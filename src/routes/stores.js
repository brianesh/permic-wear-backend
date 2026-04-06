/**
 * stores.js — Multi-store management
 *
 * GET  /api/stores          → list all stores with staff + revenue stats
 * POST /api/stores          → create a new store (super_admin)
 * PUT  /api/stores/:id      → update store (super_admin)
 * DELETE /api/stores/:id    → deactivate store (super_admin)
 * GET  /api/stores/compare  → side-by-side performance comparison (super_admin)
 */

const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router     = express.Router();
const SUPERADMIN = requireRole('super_admin');
const ADMIN      = requireRole('super_admin', 'admin');

// GET /api/stores
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

// GET /api/stores/compare — cross-store performance dashboard
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
        COUNT(DISTINCT sa.id)  FILTER (WHERE sa.status = 'completed')                     AS completed_sales,
        COALESCE(SUM(sa.selling_total) FILTER (WHERE sa.status = 'completed'), 0)          AS total_revenue,
        COALESCE(SUM(sa.extra_profit)  FILTER (WHERE sa.status = 'completed'), 0)          AS total_profit,
        COALESCE(AVG(sa.selling_total) FILTER (WHERE sa.status = 'completed'), 0)          AS avg_sale,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_active AND u.role = 'cashier')             AS cashier_count,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_active AND u.role = 'admin')               AS admin_count,
        -- daily breakdown for sparkline
        json_agg(
          json_build_object(
            'date',    DATE(sa.sale_date),
            'revenue', COALESCE(SUM(sa.selling_total) FILTER (WHERE sa.status='completed'), 0)
          ) ORDER BY DATE(sa.sale_date)
        ) FILTER (WHERE sa.id IS NOT NULL)                                                  AS daily_revenue
      FROM stores st
      LEFT JOIN sales sa ON sa.store_id = st.id
        AND sa.sale_date >= $1::DATE
        AND sa.sale_date <  ($2::DATE + INTERVAL '1 day')
      LEFT JOIN users u ON u.store_id = st.id
      GROUP BY st.id
      ORDER BY total_revenue DESC
    `, [fromDate, toDate]);

    res.json({ from: fromDate, to: toDate, stores: rows });
  } catch (err) {
    console.error('[stores] compare:', err.message);
    res.status(500).json({ error: 'Failed to compare stores' });
  }
});

// POST /api/stores
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

// PUT /api/stores/:id
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

// DELETE /api/stores/:id — soft deactivate
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
