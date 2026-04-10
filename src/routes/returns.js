/**
 * returns.js — Returns & Refunds
 *
 * GET  /api/returns             → list returns (store-scoped)
 * GET  /api/returns/lookup/:ref → load sale by receipt ID or QR ref for return UI
 * POST /api/returns             → process a return
 * PUT  /api/returns/:id/approve → approve a pending return (admin+)
 * PUT  /api/returns/:id/reject  → reject a pending return (admin+)
 */

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const db         = require('../db/connection');
const { log }    = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// Helper to check if a table exists
async function tableExists(tableName) {
  try {
    const [[{ exists }]] = await db.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)",
      [tableName]
    );
    return exists;
  } catch (err) {
    console.error(`[returns] Error checking table ${tableName}:`, err.message);
    return false;
  }
}

// ── GET /api/returns ──────────────────────────────────────────────
router.get('/', requireAuth, ADMIN, async (req, res) => {
  try {
    // Check if returns table exists
    const hasReturnsTable = await tableExists('returns');
    if (!hasReturnsTable) {
      return res.json({
        returns: [],
        total: 0,
        page: 1,
        limit: 20,
        message: 'Returns table not yet created'
      });
    }

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

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM returns r WHERE ${where}`, vals
    );

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows: returns } = await db.query(`
      SELECT 
        r.id,
        r.return_ref,
        r.original_sale_id,
        r.store_id,
        r.processed_by,
        r.approved_by,
        r.actioned_by,
        r.reason,
        r.notes,
        r.total_refund,
        r.status,
        r.created_at,
        u.name AS processed_by_name,
        s.txn_id AS original_txn,
        st.name AS store_name
      FROM returns r
      JOIN users u ON u.id = r.processed_by
      JOIN sales s ON s.id = r.original_sale_id
      LEFT JOIN stores st ON st.id = r.store_id
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...vals, parseInt(limit), offset]);

    // Fetch items for each return if return_items table exists
    const hasReturnItemsTable = await tableExists('return_items');
    let items = [];
    
    if (hasReturnItemsTable && returns.length > 0) {
      const ids = returns.map(r => r.id);
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
router.get('/lookup/:ref', requireAuth, ADMIN, async (req, res) => {
  try {
    const ref = req.params.ref?.trim()?.toUpperCase();

    if (!ref) {
      return res.status(400).json({
        success: false,
        error: 'Transaction reference is required'
      });
    }

    console.log(`[Returns Lookup] Searching for: ${ref}`);

    const saleQuery = `
      SELECT
        s.id,
        s.txn_id,
        s.cashier_id,
        s.store_id,
        s.selling_total,
        s.amount_paid,
        s.status,
        s.sale_date,
        s.phone,
        s.tuma_ref,
        s.mpesa_ref,
        u.name AS cashier_name,
        st.name AS store_name
      FROM sales s
      LEFT JOIN users u ON u.id = s.cashier_id
      LEFT JOIN stores st ON st.id = s.store_id
      WHERE (s.txn_id = $1 OR s.tuma_ref = $1 OR s.mpesa_ref = $1)
        AND s.status = 'completed'
      LIMIT 1
    `;

    const { rows: sales } = await db.query(saleQuery, [ref]);

    if (sales.length === 0) {
      return res.status(404).json({
        success: false,
        error: `No completed sale found for "${ref}"`,
        message: 'Please check the transaction ID and try again'
      });
    }

    const sale = sales[0];

    // Restrict admin to their own store
    if (req.user.role === 'admin' && sale.store_id !== req.user.store_id) {
      return res.status(403).json({
        success: false,
        error: 'This sale belongs to a different store'
      });
    }

    // Get return window from settings
    let windowDays = 30;
    try {
      const [[{ key_value }]] = await db.query(
        "SELECT key_value FROM settings WHERE key_name = 'return_window_days'"
      );
      windowDays = parseInt(key_value || 30);
    } catch (err) {
      console.warn('[Returns Lookup] Could not fetch return window, using default 30 days');
    }

    const saleDate = new Date(sale.sale_date);
    const now = new Date();
    const diffDays = Math.floor((now - saleDate) / (1000 * 60 * 60 * 24));
    const withinWindow = diffDays <= windowDays;

    // Get sale items
    const { rows: items } = await db.query(`
      SELECT
        si.id,
        si.product_id,
        si.product_name,
        si.size,
        si.qty,
        si.selling_price AS unit_price,
        si.sku,
        COALESCE((
          SELECT SUM(ri.qty)
          FROM return_items ri
          JOIN returns ret ON ret.id = ri.return_id
          WHERE ri.sale_item_id = si.id
            AND ret.status IN ('completed', 'pending_approval')
        ), 0) AS already_returned
      FROM sale_items si
      WHERE si.sale_id = $1
    `, [sale.id]);

    // Calculate returnable quantities
    const itemsWithReturnable = items.map(item => ({
      id: item.id,
      sale_item_id: item.id,
      product_id: item.product_id,
      product_name: item.product_name,
      size: item.size,
      qty: item.qty,
      selling_price: parseFloat(item.unit_price) || 0,
      sku: item.sku,
      already_returned: parseInt(item.already_returned) || 0,
      returnable_qty: Math.max(0, item.qty - (parseInt(item.already_returned) || 0))
    }));

    const hasReturnableItems = itemsWithReturnable.some(item => item.returnable_qty > 0);
    const isFullyReturned = itemsWithReturnable.length > 0 &&
      itemsWithReturnable.every(item => item.returnable_qty === 0);

    const response = {
      success: true,
      sale: {
        id: sale.id,
        txn_id: sale.txn_id,
        cashier_id: sale.cashier_id,
        store_id: sale.store_id,
        selling_total: parseFloat(sale.selling_total) || 0,
        amount_paid: parseFloat(sale.amount_paid) || 0,
        status: sale.status,
        sale_date: sale.sale_date,
        phone: sale.phone,
        cashier_name: sale.cashier_name || 'Unknown',
        store_name: sale.store_name || 'Main Store',
        tuma_ref: sale.tuma_ref,
        mpesa_ref: sale.mpesa_ref,
      },
      items: itemsWithReturnable,
      return_window_days: windowDays,
      within_window: withinWindow,
      days_since_sale: diffDays,
      has_returnable_items: hasReturnableItems,
      is_fully_returned: isFullyReturned,
      can_return: withinWindow && hasReturnableItems && !isFullyReturned,
      message: null,
    };

    if (!withinWindow) {
      response.message = `Return window has expired (${windowDays} days). Sale was ${diffDays} days ago.`;
    } else if (isFullyReturned) {
      response.message = 'All items from this sale have already been returned.';
    } else if (!hasReturnableItems) {
      response.message = 'No items available for return.';
    }

    console.log(`[Returns Lookup] Found sale ${sale.txn_id} with ${itemsWithReturnable.length} items`);
    res.json(response);

  } catch (err) {
    console.error('[returns] lookup error:', err.message);
    console.error('[returns] lookup stack:', err.stack);

    if (err.message.includes('relation "return_items" does not exist')) {
      return res.status(500).json({
        success: false,
        error: 'Returns system not set up',
        message: 'Please run database migrations to create returns tables',
        needsMigration: true
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to lookup transaction',
      message: err.message,
    });
  }
});

// ── POST /api/returns ─────────────────────────────────────────────
router.post('/', requireAuth, ADMIN, async (req, res) => {
  // Check if tables exist first
  const hasReturnsTable = await tableExists('returns');
  const hasReturnItemsTable = await tableExists('return_items');
  
  if (!hasReturnsTable || !hasReturnItemsTable) {
    return res.status(500).json({
      error: 'Returns system not fully set up',
      message: 'Please run database migrations first',
      needsMigration: true
    });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { original_sale_id, items, reason, notes } = req.body;
    if (!original_sale_id || !items?.length) {
      return res.status(400).json({ error: 'original_sale_id and items are required' });
    }

    // Load sale
    const { rows: [sale] } = await conn.query(
      'SELECT * FROM sales WHERE id = $1 AND status = $2', [original_sale_id, 'completed']
    );
    if (!sale) {
      return res.status(404).json({ error: 'Completed sale not found' });
    }

    // Store check for admins
    if (req.user.role === 'admin' && sale.store_id !== req.user.store_id) {
      return res.status(403).json({ error: 'Sale belongs to a different store' });
    }

    // Return window check
    let windowDays = 30;
    try {
      const [[{ key_value }]] = await conn.query(
        "SELECT key_value FROM settings WHERE key_name = 'return_window_days'"
      );
      windowDays = parseInt(key_value || 30);
    } catch (err) {
      console.warn('[returns POST] Using default return window');
    }

    const diffDays = Math.floor((Date.now() - new Date(sale.sale_date).getTime()) / 86400000);
    if (diffDays > windowDays) {
      return res.status(400).json({
        error: `Return window has expired (${windowDays} days). Sale was ${diffDays} days ago.`
      });
    }

    // Validate each item
    let totalRefund = 0;
    const processedItems = [];

    for (const item of items) {
      const { rows: [si] } = await conn.query(
        'SELECT * FROM sale_items WHERE id = $1 AND sale_id = $2',
        [item.sale_item_id, original_sale_id]
      );
      if (!si) {
        throw new Error(`Sale item ${item.sale_item_id} not found on this receipt`);
      }

      // Check how much has already been returned
      const [[{ already }]] = await conn.query(`
        SELECT COALESCE(SUM(ri.qty),0) AS already
        FROM return_items ri
        JOIN returns r ON r.id = ri.return_id
        WHERE ri.sale_item_id = $1 AND r.status != 'rejected'
      `, [item.sale_item_id]);

      const maxReturnable = si.qty - parseInt(already);
      if (item.qty > maxReturnable) {
        throw new Error(
          `Cannot return ${item.qty} of "${si.product_name}" — only ${maxReturnable} available to return`
        );
      }

      const unitPrice = parseFloat(si.selling_price || 0);
      totalRefund += unitPrice * item.qty;
      processedItems.push({
        sale_item_id: si.id,
        product_id:   si.product_id,
        product_name: si.product_name,
        sku:          si.sku,
        size:         si.size,
        qty:          item.qty,
        refund_price: unitPrice,
        restock:      item.restock !== false,
        condition:    item.condition || 'good',
      });
    }

    // Check approval threshold
    let approvalThreshold = 5000;
    try {
      const [[{ key_value }]] = await conn.query(
        "SELECT key_value FROM settings WHERE key_name = 'return_approval_threshold'"
      );
      approvalThreshold = parseFloat(key_value || 5000);
    } catch (err) {
      console.warn('[returns POST] Using default approval threshold');
    }

    const needsApproval = totalRefund > approvalThreshold && req.user.role !== 'super_admin';
    const status = needsApproval ? 'pending_approval' : 'completed';

    // Create return record
    const returnRef = `RET-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
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

      // Restock immediately if approved
      if (item.restock && item.condition !== 'unsellable' && status === 'completed') {
        await conn.query(
          'UPDATE products SET stock = stock + $1 WHERE id = $2',
          [item.qty, item.product_id]
        );
      }
    }

    await conn.commit();

    await log(req.user.id, req.user.name, req.user.role, 'return_processed',
      returnRef, `KES ${totalRefund} — ${processedItems.length} item(s) — ${status}`, 'sale', req.ip);

    res.status(201).json({
      success: true,
      return_ref: returnRef,
      return_id: returnId,
      total_refund: totalRefund,
      status,
      needs_approval: needsApproval,
      message: needsApproval
        ? `Return of KES ${totalRefund} is pending manager approval (above KES ${approvalThreshold} threshold)`
        : `Return processed. KES ${totalRefund} to be refunded.`,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[returns] POST error:', err.message);

    if (err.message.includes('Cannot return') || err.message.includes('window')) {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: 'Return processing failed: ' + err.message });
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
    if (!ret) {
      return res.status(404).json({ error: 'Return not found' });
    }
    if (ret.status !== 'pending_approval') {
      return res.status(400).json({ error: `Return is already ${ret.status}` });
    }

    await conn.query(
      `UPDATE returns SET status='completed', approved_by=$1 WHERE id=$2`,
      [req.user.id, ret.id]
    );

    // Restock items
    const { rows: items } = await conn.query(
      'SELECT * FROM return_items WHERE return_id = $1', [ret.id]
    );
    for (const item of items) {
      if (item.restock && item.condition !== 'unsellable') {
        await conn.query(
          'UPDATE products SET stock = stock + $1 WHERE id = $2',
          [item.qty, item.product_id]
        );
      }
    }

    await conn.commit();

    await log(req.user.id, req.user.name, req.user.role, 'return_approved',
      ret.return_ref, `Approved by ${req.user.name}`, 'sale', req.ip);

    res.json({
      success: true,
      message: 'Return approved and inventory updated',
      return_ref: ret.return_ref,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[returns] approve error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ── PUT /api/returns/:id/reject ───────────────────────────────────
router.put('/:id/reject', requireAuth, ADMIN, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { rows: [ret] } = await conn.query('SELECT * FROM returns WHERE id = $1', [req.params.id]);
    if (!ret) {
      return res.status(404).json({ error: 'Return not found' });
    }
    if (ret.status === 'completed') {
      return res.status(400).json({ error: 'Cannot reject a completed return' });
    }

    const rejectReason = req.body.reason || 'No reason given';
    const newNotes = ret.notes
      ? `${ret.notes}\n[Rejected: ${rejectReason}]`
      : `[Rejected: ${rejectReason}]`;

    await conn.query(
      `UPDATE returns SET status='rejected', actioned_by=$1, notes=$2 WHERE id=$3`,
      [req.user.id, newNotes, ret.id]
    );

    await conn.commit();

    await log(req.user.id, req.user.name, req.user.role, 'return_rejected',
      ret.return_ref, rejectReason, 'sale', req.ip);

    res.json({
      success: true,
      message: 'Return rejected',
      return_ref: ret.return_ref,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[returns] reject error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;