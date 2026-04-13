/**
 * stores.js — Multi-store management
 *
 * GET  /api/stores                  → list all stores with staff + revenue stats
 * GET  /api/stores/compare          → side-by-side performance comparison (super_admin)
 * GET  /api/stores/:id/details      → store details: users, out-of-stock, low-stock
 * GET  /api/stores/:id/price-list   → download price list CSV for cashiers (super_admin)
 * POST /api/stores                  → create a new store (super_admin)
 * PUT  /api/stores/:id              → update store (super_admin)
 * PUT  /api/stores/:id/activate     → re-activate a deactivated store (super_admin)
 * DELETE /api/stores/:id            → deactivate store (super_admin)
 */

const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router     = express.Router();
const SUPERADMIN = requireRole('super_admin');
const ADMIN      = requireRole('super_admin', 'admin');

// ── GET /api/stores ───────────────────────────────────────────────
router.get('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        st.*,
        COUNT(DISTINCT u.id)  FILTER (WHERE u.is_active AND u.role != 'super_admin') AS staff_count,
        COUNT(DISTINCT sa.id) FILTER (WHERE sa.status = 'completed')                  AS total_sales,
        COALESCE(SUM(sa.selling_total) FILTER (WHERE sa.status = 'completed'), 0)     AS total_revenue
      FROM stores st
      LEFT JOIN users u  ON u.store_id = st.id
      LEFT JOIN sales sa ON sa.store_id = st.id
      GROUP BY st.id
      ORDER BY st.created_at ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[stores] GET /:', err.message);
    res.status(500).json({ error: 'Failed to fetch stores' });
  }
});

// ── GET /api/stores/compare ───────────────────────────────────────
// NOTE: must be defined BEFORE /:id routes to avoid param collision
router.get('/compare', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0];
    const toDate   = to   || new Date().toISOString().split('T')[0];

    const { rows } = await db.query(`
      SELECT
        st.id,
        st.name,
        st.location,
        st.is_active,
        COUNT(DISTINCT sa.id)  FILTER (WHERE sa.status = 'completed')                        AS completed_sales,
        COALESCE(SUM(sa.selling_total) FILTER (WHERE sa.status = 'completed'), 0)::NUMERIC   AS total_revenue,
        COALESCE(SUM(sa.extra_profit)  FILTER (WHERE sa.status = 'completed'), 0)::NUMERIC   AS total_profit,
        COALESCE(AVG(sa.selling_total) FILTER (WHERE sa.status = 'completed'), 0)::NUMERIC   AS avg_sale,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_active AND u.role = 'cashier')               AS cashier_count,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_active AND u.role = 'admin')                 AS admin_count
      FROM stores st
      LEFT JOIN sales sa ON sa.store_id = st.id
        AND sa.sale_date >= $1::DATE
        AND sa.sale_date <  ($2::DATE + INTERVAL '1 day')
      LEFT JOIN users u ON u.store_id = st.id
      GROUP BY st.id
      ORDER BY total_revenue DESC
    `, [fromDate, toDate]);

    // Top 5 products per store in the date range
    const { rows: topRows } = await db.query(`
      SELECT
        si.product_name,
        sa.store_id,
        SUM(si.qty)                          AS units_sold,
        SUM(si.qty * si.selling_price)        AS revenue
      FROM sale_items si
      JOIN sales sa ON sa.id = si.sale_id
      WHERE sa.status = 'completed'
        AND sa.sale_date >= $1::DATE
        AND sa.sale_date <  ($2::DATE + INTERVAL '1 day')
      GROUP BY si.product_name, sa.store_id
      ORDER BY revenue DESC
    `, [fromDate, toDate]);

    const storesWithTop = rows.map(s => ({
      ...s,
      top_products: topRows.filter(r => r.store_id === s.id).slice(0, 5),
    }));

    res.json({ from: fromDate, to: toDate, stores: storesWithTop });
  } catch (err) {
    console.error('[stores] compare:', err.message);
    res.status(500).json({ error: 'Failed to compare stores' });
  }
});

// ── GET /api/stores/:id/details ───────────────────────────────────
router.get('/:id/details', requireAuth, ADMIN, async (req, res) => {
  try {
    const { id } = req.params;

    // Admins can only view their own store
    if (req.user.role === 'admin' && parseInt(id) !== req.user.active_store_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows: [store] } = await db.query('SELECT * FROM stores WHERE id = $1', [id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });

    const { rows: users } = await db.query(`
      SELECT id, name, email, role, is_active, created_at
      FROM users
      WHERE store_id = $1 AND role != 'super_admin'
      ORDER BY role, name
    `, [id]);

    const { rows: outOfStock } = await db.query(`
      SELECT id, name, sku, size, category, stock, min_price
      FROM products
      WHERE store_id = $1 AND stock = 0 AND is_active = TRUE
      ORDER BY name, size
    `, [id]);

    const { rows: lowStock } = await db.query(`
      SELECT id, name, sku, size, category, stock, min_price
      FROM products
      WHERE store_id = $1 AND stock > 0 AND stock <= 5 AND is_active = TRUE
      ORDER BY stock ASC, name
    `, [id]);

    res.json({ store, users, out_of_stock: outOfStock, low_stock: lowStock });
  } catch (err) {
    console.error('[stores] details:', err.message);
    res.status(500).json({ error: 'Failed to fetch store details' });
  }
});

// ── GET /api/stores/:id/price-list ────────────────────────────────
// CSV download: SKU, Name, Size, Color, Min Price — for cashier handouts
router.get('/:id/price-list', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: [store] } = await db.query('SELECT * FROM stores WHERE id = $1', [id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });

    const { rows: products } = await db.query(`
      SELECT sku, name, size, color, min_price, category, stock
      FROM products
      WHERE store_id = $1 AND is_active = TRUE
      ORDER BY name, size
    `, [id]);

    const headers = ['SKU', 'Product Name', 'Size', 'Color', 'Min Price (KES)', 'Category', 'Stock'];
    const lines   = [
      headers.join(','),
      ...products.map(p => [
        p.sku             || '',
        `"${(p.name       || '').replace(/"/g, '""')}"`,
        p.size            || '',
        `"${(p.color      || '').replace(/"/g, '""')}"`,
        p.min_price       || 0,
        `"${(p.category   || '').replace(/"/g, '""')}"`,
        p.stock           || 0,
      ].join(',')),
    ];

    const filename = `price-list-${store.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[stores] price-list:', err.message);
    res.status(500).json({ error: 'Failed to generate price list' });
  }
});

// ── POST /api/stores/assign-orphans ──────────────────────────────
// Super admin can reassign NULL-store products/sales to a specific store
router.post('/assign-orphans', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const { store_id } = req.body;
    if (!store_id) return res.status(400).json({ error: 'store_id required' });

    const { rows: [store] } = await db.query('SELECT id FROM stores WHERE id = $1', [store_id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });

    const { rowCount: prodCount } = await db.query(
      'UPDATE products SET store_id = $1 WHERE store_id IS NULL', [store_id]
    );
    const { rowCount: salesCount } = await db.query(
      'UPDATE sales SET store_id = $1 WHERE store_id IS NULL', [store_id]
    );
    await log(req.user.id, req.user.name, req.user.role, 'store_orphans_assigned',
      `Store #${store_id}`, `${prodCount} products, ${salesCount} sales assigned`, 'settings', req.ip);

    res.json({ message: 'Orphan records assigned', products: prodCount, sales: salesCount });
  } catch (err) {
    console.error('[stores] assign-orphans:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stores ──────────────────────────────────────────────
router.post('/', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const { name, location, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Store name is required' });

    const { rows } = await db.query(
      `INSERT INTO stores (name, location, phone) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), location || '', phone || '']
    );
    await log(req.user.id, req.user.name, req.user.role, 'store_created',
      name, `Location: ${location || 'N/A'}`, 'settings', req.ip);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[stores] POST /:', err.message);
    res.status(500).json({ error: 'Failed to create store' });
  }
});

// ── PUT /api/stores/:id ───────────────────────────────────────────
router.put('/:id', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, location, phone, is_active } = req.body;

    const { rows: [s] } = await db.query('SELECT * FROM stores WHERE id = $1', [id]);
    if (!s) return res.status(404).json({ error: 'Store not found' });

    const { rows } = await db.query(
      `UPDATE stores SET name=$1, location=$2, phone=$3, is_active=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name ?? s.name, location ?? s.location, phone ?? s.phone,
       is_active !== undefined ? is_active : s.is_active, id]
    );
    await log(req.user.id, req.user.name, req.user.role, 'store_updated',
      rows[0].name, `id=${id}`, 'settings', req.ip);

    res.json(rows[0]);
  } catch (err) {
    console.error('[stores] PUT /:id:', err.message);
    res.status(500).json({ error: 'Failed to update store' });
  }
});

// ── PUT /api/stores/:id/activate ─────────────────────────────────
router.put('/:id/activate', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: [s] } = await db.query('SELECT * FROM stores WHERE id = $1', [id]);
    if (!s) return res.status(404).json({ error: 'Store not found' });

    await db.query('UPDATE stores SET is_active=TRUE, updated_at=NOW() WHERE id=$1', [id]);
    await log(req.user.id, req.user.name, req.user.role, 'store_activated',
      s.name, `id=${id}`, 'settings', req.ip);

    res.json({ message: 'Store activated' });
  } catch (err) {
    console.error('[stores] activate:', err.message);
    res.status(500).json({ error: 'Failed to activate store' });
  }
});

// ── DELETE /api/stores/:id — soft deactivate ──────────────────────
router.delete('/:id', requireAuth, SUPERADMIN, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: [{ cnt }] } = await db.query(
      "SELECT COUNT(*) AS cnt FROM stores WHERE is_active = TRUE"
    );
    if (parseInt(cnt) <= 1)
      return res.status(400).json({ error: 'Cannot deactivate the last active store' });

    const { rows: [s] } = await db.query('SELECT name FROM stores WHERE id = $1', [id]);
    if (!s) return res.status(404).json({ error: 'Store not found' });

    await db.query('UPDATE stores SET is_active=FALSE, updated_at=NOW() WHERE id=$1', [id]);
    await log(req.user.id, req.user.name, req.user.role, 'store_deactivated',
      s.name, `id=${id}`, 'settings', req.ip);

    res.json({ message: 'Store deactivated' });
  } catch (err) {
    console.error('[stores] DELETE /:id:', err.message);
    res.status(500).json({ error: 'Failed to deactivate store' });
  }
});

module.exports = router;
