const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// GET /api/products
router.get('/', requireAuth, async (req, res) => {
  try {
    const { brand, brand_id, sub_type_id, top_type, category, search } = req.query;
    let sql    = 'SELECT * FROM products WHERE is_active = 1';
    const vals = [];

    if (brand      && brand      !== 'All') { sql += ' AND brand = ?';        vals.push(brand); }
    if (brand_id)                           { sql += ' AND brand_id = ?';     vals.push(brand_id); }
    if (sub_type_id)                        { sql += ' AND sub_type_id = ?';  vals.push(sub_type_id); }
    if (top_type)                           { sql += ' AND top_type = ?';     vals.push(top_type); }
    if (category   && category   !== 'All') { sql += ' AND category = ?';     vals.push(category); }
    if (search) {
      sql += ' AND (name LIKE ? OR sku LIKE ? OR color LIKE ?)';
      vals.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY brand, name, size';

    const [rows] = await db.query(sql, vals);
    res.json(rows);
  } catch (err) {
    console.error('[products] GET /:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// POST /api/products
router.post('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, brand, brand_id, sub_type_id, top_type, category, size, sku, stock, min_price, color, photo_url } = req.body;
    if (!name || !sku || !min_price)
      return res.status(400).json({ error: 'name, sku, min_price are required' });

    const [result] = await db.query(
      `INSERT INTO products (name, brand, brand_id, sub_type_id, top_type, category, size, sku, stock, min_price, color, photo_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        brand       || 'Other',
        brand_id    || null,
        sub_type_id || null,
        top_type    || 'shoes',
        category    || 'Lifestyle',
        size        || '',
        sku,
        stock       || 0,
        min_price,
        color       || '',
        photo_url   || null,
      ]
    );

    await log(req.user.id, req.user.name, req.user.role, 'product_added', `${name} Sz${size}`,
      `SKU: ${sku}, Stock: ${stock}, Min: ${min_price}`, 'inventory', req.ip);

    res.status(201).json({ id: result.insertId, message: 'Product created' });
  } catch (err) {
    console.error('[products] POST /:', err.message, err.stack);
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'SKU already exists' });
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT /api/products/:id
router.put('/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { id }  = req.params;
    const { name, brand, brand_id, sub_type_id, top_type, category, size, sku, stock, min_price, color, photo_url } = req.body;

    const [[old]] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
    if (!old) return res.status(404).json({ error: 'Product not found' });

    await db.query(
      `UPDATE products SET name=?, brand=?, brand_id=?, sub_type_id=?, top_type=?, category=?, size=?, sku=?, stock=?, min_price=?, color=?, photo_url=?
       WHERE id = ?`,
      [
        name        ?? old.name,
        brand       ?? old.brand,
        brand_id    !== undefined ? brand_id    : old.brand_id,
        sub_type_id !== undefined ? sub_type_id : old.sub_type_id,
        top_type    ?? old.top_type,
        category    ?? old.category,
        size        ?? old.size,
        sku         ?? old.sku,
        stock       !== undefined ? stock : old.stock,
        min_price   ?? old.min_price,
        color       !== undefined ? color : old.color,
        photo_url   !== undefined ? photo_url : old.photo_url,
        id,
      ]
    );

    const changes = [];
    if (stock !== undefined && stock !== old.stock) changes.push(`Stock: ${old.stock}→${stock}`);
    if (min_price !== undefined && min_price !== old.min_price) changes.push(`MinPrice: ${old.min_price}→${min_price}`);

    await log(req.user.id, req.user.name, req.user.role, 'product_edited', `${old.name} Sz${old.size}`,
      changes.length ? changes.join(', ') : 'Details updated', 'inventory', req.ip);

    res.json({ message: 'Product updated' });
  } catch (err) {
    console.error('[products] PUT /:id:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE /api/products/:id  (soft delete)
router.delete('/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { id } = req.params;
    const [[p]]  = await db.query('SELECT name, size FROM products WHERE id = ?', [id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });

    await db.query('UPDATE products SET is_active = 0 WHERE id = ?', [id]);
    await log(req.user.id, req.user.name, req.user.role, 'product_deleted', `${p.name} Sz${p.size}`,
      'Removed from inventory', 'inventory', req.ip);

    res.json({ message: 'Product removed' });
  } catch (err) {
    console.error('[products] DELETE /:id:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// POST /api/products/bulk-import
router.post('/bulk-import', requireAuth, ADMIN, async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || !products.length)
      return res.status(400).json({ error: 'products array required' });

    let imported = 0;
    for (const p of products) {
      if (!p.name || !p.sku || !p.min_price) continue;
      await db.query(
        `INSERT INTO products (name, brand, brand_id, sub_type_id, top_type, category, size, sku, stock, min_price, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE stock = VALUES(stock), min_price = VALUES(min_price)`,
        [p.name, p.brand || 'Other', p.brand_id || null, p.sub_type_id || null,
         p.top_type || 'shoes', p.category || 'Lifestyle', p.size || '', p.sku,
         p.stock || 0, p.min_price, p.color || '']
      );
      imported++;
    }

    await log(req.user.id, req.user.name, req.user.role, 'csv_import', `${imported} products`,
      'Bulk imported via CSV', 'inventory', req.ip);

    res.json({ message: `${imported} products imported` });
  } catch (err) {
    console.error('[products] bulk-import:', err.message, err.stack);
    res.status(500).json({ error: 'Bulk import failed' });
  }
});

// POST /api/products/send-alert
router.post('/send-alert', requireAuth, async (req, res) => {
  try {
    const [[adminPhoneRow]] = await db.query(
      "SELECT key_value FROM settings WHERE key_name = 'admin_phone'"
    ).catch(() => [[{ key_value: null }]]);
    const [[lowThreshRow]] = await db.query(
      "SELECT key_value FROM settings WHERE key_name = 'low_stock_threshold'"
    ).catch(() => [[{ key_value: 5 }]]);
    const [[agingRow]] = await db.query(
      "SELECT key_value FROM settings WHERE key_name = 'aging_days'"
    ).catch(() => [[{ key_value: 60 }]]);

    const adminPhone = adminPhoneRow?.key_value || process.env.ADMIN_PHONE;
    if (adminPhone) {
      const { checkAndAlertStock } = require('../services/sms');
      await checkAndAlertStock(db, parseInt(lowThreshRow?.key_value||5), parseInt(agingRow?.key_value||60), adminPhone);
    }

    await require('../services/logger').log(
      req.user.id, req.user.name, req.user.role,
      'stock_alert_sent', 'Admin', `Alert sent by ${req.user.name}`, 'inventory', req.ip
    );

    res.json({ message: 'Alert sent' });
  } catch (err) {
    console.error('[products] send-alert:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

module.exports = router;
