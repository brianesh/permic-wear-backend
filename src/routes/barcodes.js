/**
 * barcodes.js — Barcode label print queue
 *
 * GET  /api/barcodes/jobs        → list print jobs
 * POST /api/barcodes/jobs        → create a new print job (batch of SKUs)
 * GET  /api/barcodes/jobs/:id    → job details with items
 * PUT  /api/barcodes/jobs/:id/status → update job/item status
 * DELETE /api/barcodes/jobs/:id  → cancel/delete a pending job
 *
 * The barcode system READS SKUs from DB — it does NOT generate them.
 * SKUs are generated when products are created (skuGenerator.js).
 */

const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// GET /api/barcodes/jobs
router.get('/jobs', requireAuth, ADMIN, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const storeFilter = req.user.role !== 'super_admin'
      ? `AND pj.store_id = ${req.user.active_store_id}` : '';

    const { rows: [{ total }] } = await db.query(
      `SELECT COUNT(*) AS total FROM print_jobs pj WHERE 1=1 ${storeFilter}`
    );

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows: jobs } = await db.query(`
      SELECT pj.*, u.name AS created_by_name, st.name AS store_name
      FROM print_jobs pj
      JOIN users u ON u.id = pj.created_by
      LEFT JOIN stores st ON st.id = pj.store_id
      WHERE 1=1 ${storeFilter}
      ORDER BY pj.created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), offset]);

    res.json({ jobs, total: parseInt(total) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/barcodes/jobs — create batch print job
router.post('/jobs', requireAuth, ADMIN, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { job_name, items } = req.body;
    // items: [{ product_id, copies }]
    if (!items?.length) return res.status(400).json({ error: 'items required' });

    const storeId     = req.user.active_store_id;
    const totalLabels = items.reduce((s, i) => s + (i.copies || 1), 0);

    const { rows: [job] } = await conn.query(`
      INSERT INTO print_jobs (store_id, created_by, job_name, total_labels)
      VALUES ($1,$2,$3,$4) RETURNING id
    `, [storeId, req.user.id, job_name || `Print Job ${new Date().toLocaleDateString('en-KE')}`, totalLabels]);

    const jobId = job.id;

    for (const item of items) {
      // Fetch SKU from DB (source of truth)
      const { rows: [product] } = await conn.query(
        'SELECT id, sku, name FROM products WHERE id = $1 AND is_active = TRUE', [item.product_id]
      );
      if (!product) continue;

      await conn.query(`
        INSERT INTO print_job_items (job_id, product_id, sku, copies)
        VALUES ($1,$2,$3,$4)
      `, [jobId, product.id, product.sku, item.copies || 1]);
    }

    await conn.commit();

    await log(req.user.id, req.user.name, req.user.role, 'print_job_created',
      `job_${jobId}`, `${totalLabels} labels`, 'inventory', req.ip);

    res.status(201).json({ job_id: jobId, total_labels: totalLabels, message: 'Print job created' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// GET /api/barcodes/jobs/:id — job with all items + SKU data
router.get('/jobs/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { rows: [job] } = await db.query(`
      SELECT pj.*, u.name AS created_by_name
      FROM print_jobs pj JOIN users u ON u.id = pj.created_by
      WHERE pj.id = $1
    `, [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { rows: items } = await db.query(`
      SELECT pji.*, p.name AS product_name, p.brand, p.size, p.color,
             p.min_price, p.photo_url
      FROM print_job_items pji
      JOIN products p ON p.id = pji.product_id
      WHERE pji.job_id = $1
      ORDER BY pji.id
    `, [job.id]);

    res.json({ ...job, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/barcodes/jobs/:id/status — update job status
router.put('/jobs/:id/status', requireAuth, ADMIN, async (req, res) => {
  try {
    const { status, item_id, item_status } = req.body;

    if (item_id && item_status) {
      // Update single item
      await db.query(
        'UPDATE print_job_items SET status=$1 WHERE id=$2 AND job_id=$3',
        [item_status, item_id, req.params.id]
      );
      // Recalculate job totals
      const { rows: [counts] } = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='done')   AS printed,
          COUNT(*) FILTER (WHERE status='failed') AS failed_count
        FROM print_job_items WHERE job_id=$1
      `, [req.params.id]);
      await db.query(
        'UPDATE print_jobs SET printed=$1, failed_count=$2 WHERE id=$3',
        [counts.printed, counts.failed_count, req.params.id]
      );
    }

    if (status) {
      const completedAt = ['done','failed'].includes(status) ? 'NOW()' : 'NULL';
      await db.query(
        `UPDATE print_jobs SET status=$1, completed_at=${completedAt} WHERE id=$2`,
        [status, req.params.id]
      );
    }

    res.json({ message: 'Updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/barcodes/jobs/:id — cancel pending job
router.delete('/jobs/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { rows: [job] } = await db.query('SELECT status FROM print_jobs WHERE id=$1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'printing') return res.status(400).json({ error: 'Cannot delete a job that is printing' });

    await db.query('DELETE FROM print_jobs WHERE id=$1', [req.params.id]);
    res.json({ message: 'Print job deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/barcodes/analytics — inventory intelligence
router.get('/analytics', requireAuth, ADMIN, async (req, res) => {
  try {
    const storeFilter = req.user.role !== 'super_admin'
      ? `AND p.store_id = ${req.user.active_store_id}` : '';

    // Fast-moving: sold >5 units in last 30 days
    const { rows: fastMoving } = await db.query(`
      SELECT p.id, p.name, p.brand, p.size, p.color, p.sku, p.stock, p.min_price,
             COUNT(si.id) AS sale_count, SUM(si.qty) AS units_sold
      FROM products p
      JOIN sale_items si ON si.product_id = p.id
      JOIN sales s ON s.id = si.sale_id
      WHERE s.sale_date > NOW() - INTERVAL '30 days'
        AND s.status = 'completed'
        AND p.is_active = TRUE ${storeFilter}
      GROUP BY p.id
      HAVING SUM(si.qty) >= 5
      ORDER BY units_sold DESC
      LIMIT 20
    `);

    // Slow-moving: in stock, last sold >60 days ago (or never)
    const { rows: slowMoving } = await db.query(`
      SELECT p.id, p.name, p.brand, p.size, p.color, p.sku, p.stock, p.min_price,
             MAX(s.sale_date) AS last_sold,
             EXTRACT(DAY FROM NOW() - MAX(s.sale_date)) AS days_since_sold
      FROM products p
      LEFT JOIN sale_items si ON si.product_id = p.id
      LEFT JOIN sales s ON s.id = si.sale_id AND s.status = 'completed'
      WHERE p.is_active = TRUE AND p.stock > 0 ${storeFilter}
      GROUP BY p.id
      HAVING MAX(s.sale_date) < NOW() - INTERVAL '60 days' OR MAX(s.sale_date) IS NULL
      ORDER BY days_since_sold DESC NULLS FIRST
      LIMIT 20
    `);

    // Dead stock: never sold + in stock > 90 days
    const { rows: deadStock } = await db.query(`
      SELECT p.id, p.name, p.brand, p.size, p.color, p.sku, p.stock, p.min_price,
             p.created_at,
             EXTRACT(DAY FROM NOW() - p.created_at) AS days_in_system
      FROM products p
      WHERE p.is_active = TRUE AND p.stock > 0
        AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.product_id = p.id)
        AND p.created_at < NOW() - INTERVAL '90 days'
        ${storeFilter}
      ORDER BY days_in_system DESC
      LIMIT 20
    `);

    // Low stock (needs reorder)
    const { rows: [threshRow] } = await db.query(
      "SELECT key_value FROM settings WHERE key_name='low_stock_threshold'"
    );
    const threshold = parseInt(threshRow?.key_value || 5);
    const { rows: lowStock } = await db.query(`
      SELECT p.id, p.name, p.brand, p.size, p.color, p.sku, p.stock, p.min_price
      FROM products p
      WHERE p.is_active = TRUE AND p.stock > 0 AND p.stock <= $1 ${storeFilter}
      ORDER BY p.stock ASC LIMIT 20
    `, [threshold]);

    // Brand/size analytics
    const { rows: byBrand } = await db.query(`
      SELECT p.brand,
             SUM(p.stock) AS total_stock,
             COUNT(DISTINCT p.id) AS variants,
             SUM(p.stock * p.min_price) AS stock_value
      FROM products p
      WHERE p.is_active = TRUE ${storeFilter}
      GROUP BY p.brand ORDER BY total_stock DESC
    `);

    res.json({ fastMoving, slowMoving, deadStock, lowStock, byBrand, threshold });
  } catch (err) {
    console.error('[barcodes] analytics:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
