/**
 * returns.js — Returns & Refunds
 *
 * GET  /api/returns             → list returns (store-scoped)
 * GET  /api/returns/lookup/:ref → load sale by receipt ID or QR ref for return UI
 * POST /api/returns             → process a return
 * PUT  /api/returns/:id/approve → approve a pending return (admin+)
 * PUT  /api/returns/:id/reject  → reject a pending return (admin+)
 *
 * Rules enforced:
 *  - Return window: configurable (default 30 days)
 *  - High-value returns above threshold require manager approval
 *  - Must match original receipt
 *  - Cashiers cannot process returns (admin+ only)
 *  - Restock adds back to inventory; damaged items do not
 */

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const db         = require('../db/connection');
const { log }    = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// ── GET /api/returns ──────────────────────────────────────────────
router.get('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const { from, to, page = 1, limit = 20 } = req.query;
    let where = '1=1';
    const vals = [];
    let idx = 1;

    if (req.user.role !== 'super_admin') {
      where += ` AND r.store_id = $${idx++}`;
      vals.push(req.user.store_id);
    }
    if (from) { where += ` AND DATE(r.created_at) >= $${idx++}`; vals.push(from); }
    if (to)   { where += ` AND DATE(r.created_at) <= $${idx++}`; vals.push(to); }

    const { rows: [{ total }] } = await db.query(
      `SELECT COUNT(*) AS total FROM returns r WHERE ${where}`, vals
    );

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows: returns } = await db.query(`
      SELECT r.*, u.name AS processed_by_name, s.txn_id AS original_txn,
             st.name AS store_name
      FROM returns r
      JOIN users u ON u.id = r.processed_by
      JOIN sales s ON s.id = r.original_sale_id
      LEFT JOIN stores st ON st.id = r.store_id
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...vals, parseInt(limit), offset]);

    // Fetch items for each return
    const ids = returns.map(r => r.id);
    let items = [];
    if (ids.length) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await db.query(
        `SELECT * FROM return_items WHERE return_id IN (${ph})`, ids
      );
      items = rows;
    }

    res.json({
      returns: returns.map(r => ({ ...r, items: items.filter(i => i.return_id === r.id) })),
      total: parseInt(total), page: parseInt(page), limit: parseInt(limit),
    });
  } catch (err) {
    console.error('[returns] GET /:', err.message);
    res.status(500).json({ error: 'Failed to fetch returns' });
  }
});

// ── GET /api/returns/lookup/:ref ──────────────────────────────────
// Used by the return UI to load a past sale by receipt ID or TXN
router.get('/lookup/:ref', requireAuth, ADMIN, async (req, res) => {
  try {
    const ref = req.params.ref.trim().toUpperCase();

    const { rows: [sale] } = await db.query(`
      SELECT s.*, u.name AS cashier_name, st.name AS store_name
      FROM sales s
      JOIN users u ON u.id = s.cashier_id
      LEFT JOIN stores st ON st.id = s.store_id
      WHERE (UPPER(s.txn_id) = $1 OR UPPER(s.mpesa_ref) = $1)
        AND s.status = 'completed'
    `, [ref]);

    if (!sale) return res.status(404).json({ error: `No completed sale found for "${ref}"` });

    // Restrict admin to their own store
    if (req.user.role === 'admin' && sale.store_id !== req.user.store_id)
      return res.status(403).json({ error: 'This sale belongs to a different store' });

    // Check return window
    const { rows: [windowRow] } = await db.query(
      "SELECT key_value FROM settings WHERE key_name = 'return_window_days'"
    );
    const windowDays = parseInt(windowRow?.key_value || 30);
    const saleDate   = new Date(sale.sale_date);
    const diffDays   = Math.floor((Date.now() - saleDate.getTime()) / 86400_000);
    const withinWindow = diffDays <= windowDays;

    // Load sale items with any already-returned quantities
    const { rows: items } = await db.query(`
      SELECT si.*,
        COALESCE((
          SELECT SUM(ri.qty) FROM return_items ri
          JOIN returns ret ON ret.id = ri.return_id
          WHERE ri.sale_item_id = si.id AND ret.status != 'rejected'
        ), 0) AS already_returned
      FROM sale_items si WHERE si.sale_id = $1
    `, [sale.id]);

    res.json({
      sale,
      items: items.map(i => ({ ...i, returnable_qty: i.qty - i.already_returned })),
      return_window_days: windowDays,
      within_window: withinWindow,
      days_since_sale: diffDays,
    });
  } catch (err) {
    console.error('[returns] lookup:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ── POST /api/returns ─────────────────────────────────────────────
router.post('/', requireAuth, ADMIN, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { original_sale_id, items, reason, notes } = req.body;
    if (!original_sale_id || !items?.length)
      return res.status(400).json({ error: 'original_sale_id and items are required' });

    // Load sale
    const { rows: [sale] } = await conn.query(
      'SELECT * FROM sales WHERE id = $1 AND status = $2', [original_sale_id, 'completed']
    );
    if (!sale) return res.status(404).json({ error: 'Completed sale not found' });

    // Store check for admins
    if (req.user.role === 'admin' && sale.store_id !== req.user.store_id)
      return res.status(403).json({ error: 'Sale belongs to a different store' });

    // Return window check
    const { rows: [windowRow] } = await conn.query(
      "SELECT key_value FROM settings WHERE key_name = 'return_window_days'"
    );
    const windowDays = parseInt(windowRow?.key_value || 30);
    const diffDays   = Math.floor((Date.now() - new Date(sale.sale_date).getTime()) / 86400_000);
    if (diffDays > windowDays)
      return res.status(400).json({ error: `Return window has expired (${windowDays} days). Sale was ${diffDays} days ago.` });

    // Validate each item
    let totalRefund = 0;
    const processedItems = [];

    for (const item of items) {
      const { rows: [si] } = await conn.query(
        'SELECT * FROM sale_items WHERE id = $1 AND sale_id = $2', [item.sale_item_id, original_sale_id]
      );
      if (!si) throw new Error(`Sale item ${item.sale_item_id} not found on this receipt`);

      // Check how much has already been returned
      const { rows: [{ already }] } = await conn.query(`
        SELECT COALESCE(SUM(ri.qty),0) AS already
        FROM return_items ri
        JOIN returns r ON r.id = ri.return_id
        WHERE ri.sale_item_id = $1 AND r.status != 'rejected'
      `, [item.sale_item_id]);

      const maxReturnable = si.qty - parseInt(already);
      if (item.qty > maxReturnable)
        throw new Error(`Cannot return ${item.qty} of "${si.product_name}" — only ${maxReturnable} available to return`);

      totalRefund += parseFloat(si.selling_price) * item.qty;
      processedItems.push({
        sale_item_id: si.id,
        product_id:   si.product_id,
        product_name: si.product_name,
        sku:          si.sku,
        size:         si.size,
        qty:          item.qty,
        refund_price: parseFloat(si.selling_price),
        restock:      item.restock !== false,  // default true
        condition:    item.condition || 'good',
      });
    }

    // Check approval threshold
    const { rows: [threshRow] } = await conn.query(
      "SELECT key_value FROM settings WHERE key_name = 'return_approval_threshold'"
    );
    const approvalThreshold = parseFloat(threshRow?.key_value || 5000);
    const needsApproval     = totalRefund > approvalThreshold && req.user.role !== 'super_admin';
    const status            = needsApproval ? 'pending_approval' : 'completed';

    // Create return record
    const returnRef = `RET-${uuidv4().replace(/-/g,'').slice(0,8).toUpperCase()}`;
    const { rows: [retRow] } = await conn.query(`
      INSERT INTO returns
        (return_ref, original_sale_id, store_id, processed_by, reason, notes, total_refund, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [returnRef, original_sale_id, sale.store_id, req.user.id,
        reason || '', notes || '', totalRefund, status]);

    const returnId = retRow.id;

    // Insert return items + restock
    for (const item of processedItems) {
      await conn.query(`
        INSERT INTO return_items
          (return_id, sale_item_id, product_id, product_name, sku, size, qty, refund_price, restock, condition)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [returnId, item.sale_item_id, item.product_id, item.product_name,
          item.sku, item.size, item.qty, item.refund_price, item.restock, item.condition]);

      // Restock immediately if approved (or super_admin bypass)
      if (item.restock && item.condition !== 'unsellable' && status === 'completed') {
        await conn.query(
          'UPDATE products SET stock = stock + $1 WHERE id = $2', [item.qty, item.product_id]
        );
      }
    }

    await conn.commit();

    await log(req.user.id, req.user.name, req.user.role, 'return_processed',
      returnRef, `KES ${totalRefund} — ${processedItems.length} item(s) — ${status}`, 'sale', req.ip);

    res.status(201).json({
      return_ref:    returnRef,
      return_id:     returnId,
      total_refund:  totalRefund,
      status,
      needs_approval: needsApproval,
      message:       needsApproval
        ? `Return of KES ${totalRefund} is pending manager approval (above KES ${approvalThreshold} threshold)`
        : `Return processed. KES ${totalRefund} to be refunded.`,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[returns] POST:', err.message);
    if (err.message.includes('Cannot return') || err.message.includes('window'))
      return res.status(422).json({ error: err.message });
    res.status(500).json({ error: 'Return processing failed' });
  } finally {
    conn.release();
  }
});

// ── PUT /api/returns/:id/approve ──────────────────────────────────
router.put('/:id/approve', requireAuth, ADMIN, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { rows: [ret] } = await conn.query('SELECT * FROM returns WHERE id = $1', [req.params.id]);
    if (!ret) return res.status(404).json({ error: 'Return not found' });
    if (ret.status !== 'pending_approval')
      return res.status(400).json({ error: `Return is already ${ret.status}` });

    await conn.query(
      `UPDATE returns SET status='completed', approved_by=$1 WHERE id=$2`,
      [req.user.id, ret.id]
    );

    // Now restock items
    const { rows: items } = await conn.query(
      'SELECT * FROM return_items WHERE return_id = $1', [ret.id]
    );
    for (const item of items) {
      if (item.restock && item.condition !== 'unsellable') {
        await conn.query('UPDATE products SET stock = stock + $1 WHERE id = $2',
          [item.qty, item.product_id]);
      }
    }

    await conn.commit();

    await log(req.user.id, req.user.name, req.user.role, 'return_approved',
      ret.return_ref, `Approved by ${req.user.name}`, 'sale', req.ip);

    res.json({ message: 'Return approved and inventory updated', return_ref: ret.return_ref });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ── PUT /api/returns/:id/reject ───────────────────────────────────
router.put('/:id/reject', requireAuth, ADMIN, async (req, res) => {
  try {
    const { rows: [ret] } = await db.query('SELECT * FROM returns WHERE id = $1', [req.params.id]);
    if (!ret) return res.status(404).json({ error: 'Return not found' });
    if (ret.status === 'completed') return res.status(400).json({ error: 'Cannot reject a completed return' });

    await db.query(
      `UPDATE returns SET status='rejected', approved_by=$1, notes=COALESCE(notes,'')||$2 WHERE id=$3`,
      [req.user.id, ` [Rejected: ${req.body.reason || 'No reason given'}]`, ret.id]
    );

    await log(req.user.id, req.user.name, req.user.role, 'return_rejected',
      ret.return_ref, req.body.reason || 'No reason', 'sale', req.ip);

    res.json({ message: 'Return rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
