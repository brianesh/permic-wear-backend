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

    const { items, amount_paid = 0, tuma_portion, mpesa_portion, idempotency_key } = req.body;
    const phone = req.body.phone || req.body.mpesa_phone || null;
    // Normalise: frontend may send 'M-Pesa' or 'Tuma' — store as 'Tuma' in DB
    const payment_method = ['M-Pesa','Tuma'].includes(req.body.payment_method)
      ? 'Tuma' : req.body.payment_method;

    if (!items || !items.length)
      return res.status(400).json({ error: 'No items in sale' });
    if (!['Cash', 'Tuma', 'M-Pesa', 'Split'].includes(req.body.payment_method))
      return res.status(400).json({ error: 'Invalid payment method' });

    // ── IDEMPOTENCY CHECK ──────────────────────────────────────────
    // If an idempotency key is provided, check if we've already processed this request
    if (idempotency_key) {
      const { rows: [existingKey] } = await client.query(
        `SELECT ik.*, s.txn_id, s.id as sale_db_id, s.selling_total, s.payment_method, s.status
         FROM idempotency_keys ik
         JOIN sales s ON ik.sale_id = s.id
         WHERE ik.key = $1 AND ik.created_at > NOW() - INTERVAL '24 hours'`,
        [idempotency_key]
      );
      
      if (existingKey) {
        console.log(`[Sales] Duplicate request detected - returning existing sale: ${existingKey.txn_id}`);
        await client.query('ROLLBACK');
        return res.status(200).json({
          txn_id: existingKey.txn_id,
          sale_id: existingKey.sale_db_id,
          selling_total: existingKey.selling_total,
          amount_paid: existingKey.selling_total,
          change_given: 0,
          extra_profit: 0,
          commission: 0,
          commission_rate: 0,
          status: existingKey.status,
          message: 'Sale already recorded (idempotent response)',
          idempotent: true
        });
      }
    }

    // ── DUPLICATE SALE DETECTION ───────────────────────────────────
    // Check for similar recent sales (same cashier, same total, within 30 seconds)
    // This catches cases where idempotency key wasn't sent
    const calculatedTotal = items.reduce((sum, item) => sum + (parseFloat(item.selling_price) * item.qty), 0);
    const { rows: [recentSale] } = await client.query(
      `SELECT id, txn_id, status FROM sales 
       WHERE cashier_id = $1 
       AND selling_total = $2 
       AND status IN ('completed', 'pending_tuma', 'pending_split')
       AND sale_date > NOW() - INTERVAL '30 seconds'
       ORDER BY sale_date DESC 
       LIMIT 1`,
      [req.user.id, calculatedTotal]
    );
    
    if (recentSale) {
      // Check if the items match (same products and quantities)
      const { rows: recentItems } = await client.query(
        'SELECT product_id, qty FROM sale_items WHERE sale_id = $1',
        [recentSale.id]
      );
      
      const isDuplicate = items.length === recentItems.length && 
        items.every(item => recentItems.some(ri => 
          ri.product_id === item.product_id && ri.qty === item.qty
        ));
      
      if (isDuplicate) {
        console.log(`[Sales] Potential duplicate sale detected - returning existing: ${recentSale.txn_id}`);
        await client.query('ROLLBACK');
        return res.status(200).json({
          txn_id: recentSale.txn_id,
          sale_id: recentSale.id,
          message: 'Similar sale recently created (duplicate prevention)',
          duplicate: true
        });
      }
    }

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
    const tumaPortionNum = parseFloat(tuma_portion || mpesa_portion) || 0;

    let saleStatus;
    if (payment_method === 'Tuma' || payment_method === 'M-Pesa') saleStatus = 'pending_tuma';
    else if (payment_method === 'Split' && tumaPortionNum > 0)    saleStatus = 'pending_split';
    else saleStatus = 'completed';

    // FIX: use active_store_id (works for super_admin store picker too)
    const storeId = req.user.active_store_id || null;

    const { rows: [saleRow] } = await client.query(
      `INSERT INTO sales
         (txn_id, cashier_id, payment_method, selling_total, amount_paid,
          change_given, extra_profit, commission, commission_rate,
          mpesa_phone, phone, store_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
       [txnId, req.user.id, payment_method, sellingTotal, amountPaidNum,
        changeGiven, extraProfit, totalCommission, commissionRate,
        phone || null, phone || null, storeId, saleStatus]
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

    if (saleStatus === 'completed') {
      for (const li of lineItems) {
        await client.query(
          'UPDATE products SET stock = stock - $1 WHERE id = $2', [li.qty, li.product.id]
        );
      }
    }

    // Save idempotency key if provided
    if (idempotency_key) {
      await client.query(
        `INSERT INTO idempotency_keys (key, sale_id, response)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET sale_id = EXCLUDED.sale_id`,
        [idempotency_key, saleId, JSON.stringify({
          txn_id: txnId,
          sale_id: saleId,
          selling_total: sellingTotal,
          amount_paid: amountPaidNum,
          change_given: changeGiven,
          extra_profit: extraProfit,
          commission: totalCommission,
          commission_rate: commissionRate,
          status: saleStatus
        })]
      );
    }

    await client.query('COMMIT');

    await log(req.user.id, req.user.name, req.user.role, 'sale', txnId,
      `KES ${sellingTotal.toLocaleString()} — ${payment_method}`, 'sale', req.ip);

    for (const li of lineItems) {
      db.query(
        `INSERT INTO product_favorites (user_id, product_id, use_count, last_used)
         VALUES ($1,$2,1,NOW())
         ON CONFLICT (user_id, product_id) DO UPDATE
           SET use_count = product_favorites.use_count + 1, last_used = NOW()`,
        [req.user.id, li.product.id]
      ).catch(() => {});
    }

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
    res.status(500).json({ error: 'Failed to record sale', detail: err.message });
  } finally {
    client.release();
  }
});

// ── GET /api/sales ───────────────────────────────────────────────
// FIX: admin now scoped to their active_store_id
router.get('/', requireAuth, async (req, res) => {
  try {
    const isCashier = req.user.role === 'cashier';
    const isAdmin   = req.user.role === 'admin';

    const { from, to, cashier_id, method, status, page = 1, limit = 20 } = req.query;

    let where  = "s.status = 'completed'";
    const vals = [];
    let   idx  = 1;
    const push = v => { vals.push(v); return `$${idx++}`; };

    // Store scoping:
    // cashier        → own sales only
    // admin          → their store always
    // super_admin    → selected store if active_store_id set, ALL stores if global mode
    if (isCashier) {
      where += ` AND s.cashier_id = ${push(req.user.id)}`;
    } else if (req.user.active_store_id) {
      where += ` AND s.store_id = ${push(req.user.active_store_id)}`;
    }
    // super_admin with no active_store_id → global mode, sees all stores

    if (!isCashier && cashier_id) where += ` AND s.cashier_id = ${push(cashier_id)}`;
    // Use Nairobi timezone (Africa/Nairobi, UTC+3) for date filtering
    if (from)   where += ` AND s.sale_date >= (${push(from)}::date AT TIME ZONE 'Africa/Nairobi')::timestamp`;
    if (to)     where += ` AND s.sale_date < ((${push(to)}::date + INTERVAL '1 day') AT TIME ZONE 'Africa/Nairobi')::timestamp`;
    if (method) where += ` AND s.payment_method = ${push(method)}`;
    if (status && status !== 'All') {
      where = where.replace("s.status = 'completed'", '1=1');
      where += ` AND s.status = ${push(status)}`;
    }

    const { rows: [{ total }] } = await db.query(
      `SELECT COUNT(*) AS total FROM sales s WHERE ${where}`, vals
    );

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows: sales } = await db.query(
      `SELECT s.*, u.name AS cashier_name, u.role AS cashier_role,
              st.name AS store_name
       FROM sales s
       JOIN users u ON s.cashier_id = u.id
       LEFT JOIN stores st ON st.id = s.store_id
       WHERE ${where}
       ORDER BY s.sale_date DESC
       LIMIT ${push(parseInt(limit))} OFFSET ${push(offset)}`,
      vals
    );

    const ids = sales.map(s => s.id);
    let items = [];
    if (ids.length) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await db.query(
        `SELECT * FROM sale_items WHERE sale_id IN (${ph})`, ids
      );
      items = rows;
    }

    // Map Tuma → 'M-Pesa' for display (stored as 'Tuma' in DB)
    const mapMethod = m => m === 'Tuma' ? 'M-Pesa' : m;
    res.json({
      sales: sales.map(s => ({
        ...s,
        payment_method: mapMethod(s.payment_method),
        items: items.filter(i => i.sale_id === s.id),
      })),
      total: parseInt(total), page: parseInt(page), limit: parseInt(limit),
    });
  } catch (err) {
    console.error('[sales] GET:', err);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// ── GET /api/sales/:id ───────────────────────────────────────────
router.get('/:id', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { rows: [sale] } = await db.query(
      `SELECT s.*, u.name AS cashier_name FROM sales s JOIN users u ON s.cashier_id=u.id WHERE s.id=$1`,
      [req.params.id]
    );
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    // Admin can only view their store's sales
    if (req.user.role === 'admin' && sale.store_id !== req.user.active_store_id)
      return res.status(403).json({ error: 'Sale belongs to a different store' });

    const { rows: items } = await db.query('SELECT * FROM sale_items WHERE sale_id=$1', [sale.id]);
    res.json({ ...sale, items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sale' });
  }
});

module.exports = router;