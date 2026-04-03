const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db/connection');
const { log }  = require('../services/logger');
const { checkAndAlertStock } = require('../services/sms');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/sales ──────────────────────────────────────────────
// Body: { items, payment_method, amount_paid, mpesa_phone? }
// items: [{ product_id, qty, selling_price }]
router.post('/', requireAuth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { items, payment_method, amount_paid = 0, mpesa_phone, mpesa_portion } = req.body;

    if (!items || !items.length)
      return res.status(400).json({ error: 'No items in sale' });
    if (!['Cash', 'M-Pesa', 'Split'].includes(payment_method))
      return res.status(400).json({ error: 'Invalid payment method' });

    // Fetch cashier's commission rate
    const [[cashier]] = await conn.query(
      'SELECT commission_rate FROM users WHERE id = ?', [req.user.id]
    );
    const commissionRate = parseFloat(cashier?.commission_rate ?? 10);

    // Validate + lock products
    let sellingTotal = 0;
    let extraProfit  = 0;
    let totalCommission = 0;
    const lineItems = [];

    for (const item of items) {
      const [[product]] = await conn.query(
        'SELECT * FROM products WHERE id = ? AND is_active = true FOR UPDATE',
        [item.product_id]
      );
      if (!product)
        throw new Error(`Product ID ${item.product_id} not found`);
      if (product.stock < item.qty)
        throw new Error(`Insufficient stock for ${product.name} Sz${product.size}: have ${product.stock}, need ${item.qty}`);

      const sellingPrice = parseFloat(item.selling_price);
      if (sellingPrice < parseFloat(product.min_price))
        throw new Error(`Selling price ${sellingPrice} is below minimum ${product.min_price} for ${product.name}`);

      // ── Commission logic ─────────────────────────────────────
      // extra_profit  = (selling_price − min_price) × qty
      // commission    = commission_rate% × extra_profit
      const lineTotal       = sellingPrice * item.qty;
      const lineMin         = parseFloat(product.min_price) * item.qty;
      const lineExtra       = lineTotal > lineMin ? lineTotal - lineMin : 0;
      const lineCommission  = lineExtra > 0 ? Math.round(lineExtra * commissionRate / 100) : 0;

      sellingTotal    += lineTotal;
      extraProfit     += lineExtra;
      totalCommission += lineCommission;

      lineItems.push({
        product,
        qty:           item.qty,
        selling_price: sellingPrice,
        line_total:    lineTotal,
        line_extra:    lineExtra,
        line_commission: lineCommission,
      });
    }

    const amountPaidNum = parseFloat(amount_paid);
    const changeGiven   = payment_method === 'Cash' || payment_method === 'Split'
      ? Math.max(0, amountPaidNum - sellingTotal)
      : 0;

    // Generate TXN ID
    const txnId = `TXN-${uuidv4().replace(/-/g,'').slice(0,8).toUpperCase()}`;

    // Cash & full-cash Split → completed immediately (stock deducted now)
    // M-Pesa → pending_mpesa (deducts when Safaricom callback fires)
    // Split with M-Pesa portion → pending_split (deducts when M-Pesa portion confirmed)
    const mpesaPortionNum = parseFloat(mpesa_portion) || 0;
    let saleStatus;
    if (payment_method === 'M-Pesa') {
      saleStatus = 'pending_mpesa';
    } else if (payment_method === 'Split' && mpesaPortionNum > 0) {
      saleStatus = 'pending_split';
    } else {
      // Cash or Split with no M-Pesa portion → complete immediately
      saleStatus = 'completed';
    }

    // Insert sale
    const [saleRows] = await conn.query(
      `INSERT INTO sales
         (txn_id, cashier_id, payment_method, selling_total, amount_paid,
          change_given, extra_profit, commission, commission_rate, mpesa_phone, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [txnId, req.user.id, payment_method, sellingTotal, amountPaidNum,
       changeGiven, extraProfit, totalCommission, commissionRate,
       mpesa_phone || null, saleStatus]
    );
    const saleId = saleRows[0].id;

    // Insert line items
    for (const li of lineItems) {
      await conn.query(
        `INSERT INTO sale_items
           (sale_id, product_id, product_name, sku, size, qty, min_price,
            selling_price, extra_profit, commission)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [saleId, li.product.id, li.product.name, li.product.sku, li.product.size,
         li.qty, li.product.min_price, li.selling_price, li.line_extra, li.line_commission]
      );
    }

    // Deduct stock immediately for completed (Cash/Split-cash) sales
    if (saleStatus === 'completed') {
      for (const li of lineItems) {
        await conn.query('UPDATE products SET stock = stock - ? WHERE id = ?', [li.qty, li.product.id]);
      }
    }

    await conn.commit();

    // Log the sale
    await log(req.user.id, req.user.name, req.user.role, 'sale', txnId,
      `KES ${sellingTotal.toLocaleString()} — ${payment_method}${totalCommission > 0 ? ` · Commission KES ${totalCommission}` : ''}`,
      'sale', req.ip);

    // Async: check stock alerts (don't await — don't block response)
    const [[settings]] = await db.query(
      "SELECT key_value FROM settings WHERE key_name = 'low_stock_threshold'"
    ).catch(() => [[{ key_value: 5 }]]);
    const [[adminPhone]] = await db.query(
      "SELECT key_value FROM settings WHERE key_name = 'admin_phone'"
    ).catch(() => [[{ key_value: null }]]);
    const [[agingDays]] = await db.query(
      "SELECT key_value FROM settings WHERE key_name = 'aging_days'"
    ).catch(() => [[{ key_value: 60 }]]);

    checkAndAlertStock(
      db,
      parseInt(settings?.key_value ?? 5),
      parseInt(agingDays?.key_value ?? 60),
      adminPhone?.key_value
    ).catch(console.error);

    res.status(201).json({
      txn_id:          txnId,
      sale_id:         saleId,
      selling_total:   sellingTotal,
      amount_paid:     amountPaidNum,
      change_given:    changeGiven,
      extra_profit:    extraProfit,
      commission:      totalCommission,
      commission_rate: commissionRate,
      status:          saleStatus,
      message:         'Sale recorded',
    });

  } catch (err) {
    await conn.rollback();
    console.error('[sales] POST /:',  err.message, err.stack);
    if (err.message.includes('Insufficient') || err.message.includes('below minimum') || err.message.includes('not found'))
      return res.status(422).json({ error: err.message });
    res.status(500).json({ error: 'Failed to record sale' });
  } finally {
    conn.release();
  }
});

// POST /api/sales/confirm-mpesa-manual  — cashier marked M-Pesa as paid (STK done or paybill); required so sale counts in commission reports
router.post('/confirm-mpesa-manual', requireAuth, async (req, res) => {
  try {
    const saleId = parseInt(req.body.sale_id, 10);
    if (!saleId) return res.status(400).json({ error: 'sale_id required' });

    const [[sale]] = await db.query(
      'SELECT id, cashier_id, status, payment_method FROM sales WHERE id = ?',
      [saleId]
    );
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const adminRoles = ['super_admin', 'admin'];
    const isAdmin = adminRoles.includes(req.user.role);
    if (!isAdmin && sale.cashier_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    if (sale.payment_method !== 'M-Pesa')
      return res.status(400).json({ error: 'Not an M-Pesa sale' });

    if (sale.status === 'completed')
      return res.json({ message: 'Already completed', status: 'completed' });

    if (sale.status === 'failed')
      return res.status(400).json({ error: 'Sale was cancelled or failed' });

    await db.query(
      `UPDATE sales SET status = 'completed', amount_paid = selling_total WHERE id = ? AND status = 'pending_mpesa'`,
      [saleId]
    );

    // Deduct stock now that payment is manually confirmed
    const [saleItems] = await db.query(
      'SELECT product_id, qty FROM sale_items WHERE sale_id = ?',
      [saleId]
    );
    for (const si of saleItems) {
      await db.query('UPDATE products SET stock = stock - ? WHERE id = ?', [si.qty, si.product_id]);
    }

    res.json({ message: 'Sale completed', status: 'completed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm sale' });
  }
});

// ── GET /api/sales ───────────────────────────────────────────────
// Cashiers may list only their own sales (for commission page). Admins may filter all.
router.get('/', requireAuth, async (req, res) => {
  try {
    const adminRoles = ['super_admin', 'admin'];
    const isAdmin    = adminRoles.includes(req.user.role);
    const isCashier  = req.user.role === 'cashier';
    if (!isAdmin && !isCashier)
      return res.status(403).json({ error: 'Forbidden' });

    const { from, to, cashier_id, method, page = 1, limit = 20 } = req.query;
    let sql    = `SELECT s.*, u.name AS cashier_name, u.role AS cashier_role
                  FROM sales s JOIN users u ON s.cashier_id = u.id
                  WHERE 1=1`;
    const vals = [];

    if (isCashier) {
      sql += ' AND s.cashier_id = ?';
      vals.push(req.user.id);
    } else if (cashier_id) {
      sql += ' AND s.cashier_id = ?';
      vals.push(cashier_id);
    }

    if (from)       { sql += ' AND DATE(s.sale_date) >= ?'; vals.push(from); }
    if (to)         { sql += ' AND DATE(s.sale_date) <= ?'; vals.push(to);   }
    if (method)     { sql += ' AND s.payment_method = ?';    vals.push(method); }

    sql += ' ORDER BY s.sale_date DESC';

    // Count total - build a separate count query to avoid GROUP BY issues
    let countSql = 'SELECT COUNT(*) AS total FROM sales s JOIN users u ON s.cashier_id = u.id WHERE 1=1';
    const countVals = [];
    
    if (isCashier) {
      countSql += ' AND s.cashier_id = ?';
      countVals.push(req.user.id);
    } else if (cashier_id) {
      countSql += ' AND s.cashier_id = ?';
      countVals.push(cashier_id);
    }
    if (from)       { countSql += ' AND DATE(s.sale_date) >= ?'; countVals.push(from); }
    if (to)         { countSql += ' AND DATE(s.sale_date) <= ?'; countVals.push(to);   }
    if (method)     { countSql += ' AND s.payment_method = ?';    countVals.push(method); }

    const [countRows] = await db.query(countSql, countVals);
    const total = countRows[0].total;

    // Paginate
    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ' LIMIT ? OFFSET ?';
    vals.push(parseInt(limit), offset);

    const [sales] = await db.query(sql, vals);

    // Fetch items for each sale
    const ids = sales.map(s => s.id);
    let items = [];
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await db.query(
        `SELECT * FROM sale_items WHERE sale_id IN (${placeholders})`, ids
      );
      items = rows;
    }

    const salesWithItems = sales.map(s => ({
      ...s,
      items: items.filter(i => i.sale_id === s.id),
    }));

    res.json({ sales: salesWithItems, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// GET /api/sales/:id
router.get('/:id', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const [[sale]] = await db.query(
      `SELECT s.*, u.name AS cashier_name, u.role AS cashier_role
       FROM sales s JOIN users u ON s.cashier_id = u.id
       WHERE s.id = ?`,
      [req.params.id]
    );
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const [items] = await db.query('SELECT * FROM sale_items WHERE sale_id = ?', [sale.id]);
    res.json({ ...sale, items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sale' });
  }
});

module.exports = router;
