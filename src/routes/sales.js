const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db/connection');
const { log }  = require('../services/logger');
const { checkAndAlertStock } = require('../services/sms');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/sales ──────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { items, amount_paid = 0, tuma_portion, mpesa_portion } = req.body;
    // Accept 'phone' from frontend
    const phone = req.body.phone || null;
    // Normalize: DB CHECK only allows 'Cash','Tuma','Split' — map 'M-Pesa' → 'Tuma'
    const payment_method = req.body.payment_method === 'M-Pesa' ? 'Tuma' : req.body.payment_method;

    if (!items || !items.length)
      return res.status(400).json({ error: 'No items in sale' });
    if (!['Cash', 'Tuma', 'Split'].includes(req.body.payment_method))
      return res.status(400).json({ error: 'Invalid payment method' });

    // Get cashier's commission rate
    const { rows: [cashier] } = await client.query(
      'SELECT commission_rate FROM users WHERE id = $1', [req.user.id]
    );
    const commissionRate = parseFloat(cashier?.commission_rate ?? 10);

    let sellingTotal = 0, extraProfit = 0, totalCommission = 0;
    const lineItems  = [];

    for (const item of items) {
      const { rows: [product] } = await client.query(
        'SELECT * FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE',
        [item.product_id]
      );
      if (!product) throw new Error(`Product ID ${item.product_id} not found`);
      if (product.stock < item.qty)
        throw new Error(`Insufficient stock for ${product.name} Sz${product.size}: have ${product.stock}, need ${item.qty}`);

      const sellingPrice = parseFloat(item.selling_price);
      if (sellingPrice < parseFloat(product.min_price))
        throw new Error(`Selling price ${sellingPrice} is below minimum ${product.min_price} for ${product.name}`);

      const lineTotal      = sellingPrice * item.qty;
      const lineMin        = parseFloat(product.min_price) * item.qty;
      const lineExtra      = lineTotal > lineMin ? lineTotal - lineMin : 0;
      const lineCommission = lineExtra > 0 ? Math.round(lineExtra * commissionRate / 100) : 0;

      sellingTotal    += lineTotal;
      extraProfit     += lineExtra;
      totalCommission += lineCommission;
      lineItems.push({ product, qty: item.qty, selling_price: sellingPrice,
                       line_total: lineTotal, line_extra: lineExtra, line_commission: lineCommission });
    }

    const amountPaidNum  = parseFloat(amount_paid);
    const changeGiven    = (['Cash','Split'].includes(payment_method))
                         ? Math.max(0, amountPaidNum - sellingTotal) : 0;
    const txnId          = `TXN-${uuidv4().replace(/-/g,'').slice(0,8).toUpperCase()}`;
    // Support both tuma_portion and mpesa_portion for backward compatibility
    const tumaPortionNum = parseFloat(tuma_portion || mpesa_portion) || 0;

    let saleStatus;
    // Use pending_tuma for M-Pesa/Tuma payments to match DB CHECK constraint
    if (payment_method === 'Tuma') saleStatus = 'pending_tuma';
    else if (payment_method === 'Split' && tumaPortionNum > 0) saleStatus = 'pending_split';
    else saleStatus = 'completed';

    console.log('🔴 PAYMENT METHOD BEING SAVED:', payment_method);
    
    const { rows: [saleRow] } = await client.query(
      `INSERT INTO sales
         (txn_id, cashier_id, payment_method, selling_total, amount_paid,
          change_given, extra_profit, commission, commission_rate
          , phone, store_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
       [txnId, req.user.id, payment_method, sellingTotal, amountPaidNum,
        changeGiven, extraProfit, totalCommission, commissionRate, phone || null,
        req.user.store_id || null, saleStatus]
    );
    const saleId = saleRow.id;

    for (const li of lineItems) {
      await client.query(
        `INSERT INTO sale_items
           (sale_id, product_id, product_name, sku, size, qty, min_price,
            selling_price, extra_profit, commission)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [saleId, li.product.id, li.product.name, li.product.sku, li.product.size,
         li.qty, li.product.min_price, li.selling_price, li.line_extra, li.line_commission]
      );
    }

    // Deduct stock immediately for Cash/Split-cash
    if (saleStatus === 'completed') {
      for (const li of lineItems) {
        await client.query(
          'UPDATE products SET stock = stock - $1 WHERE id = $2', [li.qty, li.product.id]
        );
      }
    }

    await client.query('COMMIT');

    await log(req.user.id, req.user.name, req.user.role, 'sale', txnId,
      `KES ${sellingTotal.toLocaleString()} — ${payment_method}`, 'sale', req.ip);

    // Record product favorites asynchronously for autocomplete boost
    for (const li of lineItems) {
      db.query(
        `INSERT INTO product_favorites (user_id, product_id, use_count, last_used)
         VALUES ($1,$2,1,NOW())
         ON CONFLICT (user_id, product_id) DO UPDATE
           SET use_count = product_favorites.use_count + 1, last_used = NOW()`,
        [req.user.id, li.product.id]
      ).catch(() => {});
    }

    // Async stock alerts
    db.query("SELECT key_value FROM settings WHERE key_name = 'low_stock_threshold'")
      .then(({ rows: [r] }) => {
        return db.query("SELECT key_value FROM settings WHERE key_name = 'admin_phone'")
          .then(({ rows: [ap] }) => {
            return db.query("SELECT key_value FROM settings WHERE key_name = 'aging_days'")
              .then(({ rows: [ad] }) => {
                checkAndAlertStock(db, parseInt(r?.key_value??5),
                  parseInt(ad?.key_value??60), ap?.key_value).catch(console.error);
              });
          });
      }).catch(() => {});

    res.status(201).json({
      txn_id: txnId, sale_id: saleId, selling_total: sellingTotal,
      amount_paid: amountPaidNum, change_given: changeGiven,
      extra_profit: extraProfit, commission: totalCommission,
      commission_rate: commissionRate, status: saleStatus, message: 'Sale recorded',
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[sales] POST:', err.message);
    if (err.message.includes('Insufficient') || err.message.includes('below minimum') || err.message.includes('not found'))
      return res.status(422).json({ error: err.message });
    res.status(500).json({ error: 'Failed to record sale' });
  } finally {
    client.release();
  }
});

// GET /api/sales
router.get('/', requireAuth, async (req, res) => {
  try {
    const isAdmin   = ['super_admin', 'admin'].includes(req.user.role);
    const isCashier = req.user.role === 'cashier';

    const { from, to, cashier_id, method, status, page = 1, limit = 20 } = req.query;

    // Default to only completed sales unless status filter is explicitly provided
    let where    = "s.status = 'completed'";
    const vals   = [];
    let   idx    = 1;
    const push   = v => { vals.push(v); return `$${idx++}`; };

    // Role-based scoping — super_admin and admin can see all sales; cashiers see only their own
    if (isCashier) {
      // Cashiers only see their own sales
      where += ` AND s.cashier_id = ${push(req.user.id)}`;
    } else if (req.user.role === 'admin') {
      // Admin sees all sales (no additional filter needed)
    }
    // Super admin sees ALL sales (no where clause added)

    // Cashier filter (for admin/super_admin viewing other cashiers' sales)
    if (!isCashier && cashier_id) {
      where += ` AND s.cashier_id = ${push(cashier_id)}`;
    }

    if (from)   where += ` AND DATE(s.sale_date) >= ${push(from)}`;
    if (to)     where += ` AND DATE(s.sale_date) <= ${push(to)}`;
    if (method) where += ` AND s.payment_method = ${push(method)}`;
    // Allow filtering by specific status (completed, pending_mpesa, failed, etc.)
    // When status filter is provided, override the default completed filter
    if (status && status !== 'All') {
      where = where.replace("s.status = 'completed'", '1=1');
      where += ` AND s.status = ${push(status)}`;
    }

    const { rows: [{ total }] } = await db.query(
      `SELECT COUNT(*) AS total FROM sales s WHERE ${where}`, vals
    );

    const offset    = (parseInt(page) - 1) * parseInt(limit);
    const { rows: sales } = await db.query(
      `SELECT s.*, u.name AS cashier_name, u.role AS cashier_role
       FROM sales s
       JOIN users u ON s.cashier_id = u.id
       WHERE ${where}
       ORDER BY s.sale_date DESC
       LIMIT ${push(parseInt(limit))} OFFSET ${push(offset)}`,
      vals
    );

    const ids = sales.map(s => s.id);
    let items = [];
    if (ids.length) {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await db.query(
        `SELECT * FROM sale_items WHERE sale_id IN (${placeholders})`, ids
      );
      items = rows;
    }

    res.json({
      sales: sales.map(s => ({ ...s, items: items.filter(i => i.sale_id === s.id) })),
      total: parseInt(total), page: parseInt(page), limit: parseInt(limit),
    });
  } catch (err) {
    console.error('[sales] GET:', err);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// GET /api/sales/:id
router.get('/:id', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { rows: [sale] } = await db.query(
      `SELECT s.*, u.name AS cashier_name FROM sales s JOIN users u ON s.cashier_id=u.id WHERE s.id=$1`,
      [req.params.id]
    );
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const { rows: items } = await db.query('SELECT * FROM sale_items WHERE sale_id=$1', [sale.id]);
    res.json({ ...sale, items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sale' });
  }
});

module.exports = router;
