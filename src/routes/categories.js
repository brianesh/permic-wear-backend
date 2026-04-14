/**
 * /api/categories — Dynamic category hierarchy from products
 *
 * EGRESS FIX: Added in-memory cache (10 min TTL) on all GET routes.
 *   Brands and subtypes are fetched on every Inventory/POS page load.
 *   Cache is cleared on any POST/PUT/DELETE mutation.
 */

const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');
const router  = express.Router();
const ADMIN   = requireRole('super_admin', 'admin');

// ── In-memory cache (10 min TTL — categories change rarely) ──────────────────
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) { cache.set(key, { data, time: Date.now() }); }
function invalidateCache() { cache.clear(); }

// ── GET /api/categories/hierarchy — CACHED ────────────────────────────────────
router.get('/hierarchy', requireAuth, async (req, res) => {
  try {
    const { top_type } = req.query;
    const cacheKey = `hierarchy:${top_type||'all'}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let sql = 'SELECT * FROM category_hierarchy';
    const vals = []; let idx = 1;
    if (top_type) { sql += ` WHERE top_type = $${idx++}`; vals.push(top_type); }
    sql += ' ORDER BY top_type, sort_order, brand_name, sub_type_name';
    const { rows } = await db.query(sql, vals);

    const hierarchy = {};
    for (const row of rows) {
      const { top_type: tt, brand_id, brand_name, sub_type_id, sub_type_name } = row;
      if (!hierarchy[tt]) hierarchy[tt] = {};
      if (!hierarchy[tt][brand_id]) hierarchy[tt][brand_id] = { id: brand_id, name: brand_name, top_type: tt, sub_types: [] };
      if (sub_type_id && sub_type_name) {
        hierarchy[tt][brand_id].sub_types.push({ id: sub_type_id, name: sub_type_name, product_count: parseInt(row.product_count)||0, total_stock: parseInt(row.total_stock)||0 });
      }
    }

    setCached(cacheKey, hierarchy);
    res.json(hierarchy);
  } catch (err) {
    console.error('[categories] GET hierarchy:', err.message);
    res.status(500).json({ error: 'Failed to fetch category hierarchy' });
  }
});

// ── GET /api/categories/brands — CACHED ──────────────────────────────────────
router.get('/brands', requireAuth, async (req, res) => {
  try {
    const { top_type } = req.query;
    const cacheKey = `brands:${top_type||'all'}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let sql = 'SELECT * FROM brands WHERE is_active = true';
    const vals = [];
    if (top_type) { sql += ` AND top_type = $${vals.length + 1}`; vals.push(top_type); }
    sql += ' ORDER BY sort_order, name';
    const { rows } = await db.query(sql, vals);
    setCached(cacheKey, rows);
    res.json(rows);
  } catch (err) {
    console.error('[categories] GET brands:', err.message);
    res.status(500).json({ error: 'Failed to fetch brands' });
  }
});

// ── POST /api/categories/brands ───────────────────────────────────────────────
router.post('/brands', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, top_type, photo_url, sort_order } = req.body;
    if (!name || !top_type) return res.status(400).json({ error: 'name and top_type are required' });
    const { rows } = await db.query(
      'INSERT INTO brands (name, top_type, photo_url, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
      [name.trim(), top_type, photo_url || null, sort_order || 0]
    );
    await log(req.user.id, req.user.name, req.user.role, 'brand_created', name, `Type: ${top_type}`, 'inventory', req.ip);
    invalidateCache();
    res.status(201).json({ id: rows[0].id, message: 'Brand created' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Brand already exists for this type' });
    console.error('[categories] POST brands:', err.message);
    res.status(500).json({ error: 'Failed to create brand' });
  }
});

// ── PUT /api/categories/brands/:id ───────────────────────────────────────────
router.put('/brands/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, photo_url, sort_order, is_active } = req.body;
    const fields = [], vals = [];
    if (name       !== undefined) { fields.push(`name=$${vals.length+1}`);       vals.push(name); }
    if (photo_url  !== undefined) { fields.push(`photo_url=$${vals.length+1}`);  vals.push(photo_url); }
    if (sort_order !== undefined) { fields.push(`sort_order=$${vals.length+1}`); vals.push(sort_order); }
    if (is_active  !== undefined) { fields.push(`is_active=$${vals.length+1}`);  vals.push(!!is_active); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE brands SET ${fields.join(',')} WHERE id=$${vals.length}`, vals);
    invalidateCache();
    res.json({ message: 'Brand updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update brand' });
  }
});

// ── DELETE /api/categories/brands/:id ────────────────────────────────────────
router.delete('/brands/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { rows: [b] } = await db.query('SELECT name FROM brands WHERE id=$1', [req.params.id]);
    if (!b) return res.status(404).json({ error: 'Brand not found' });
    await db.query('UPDATE brands SET is_active=false WHERE id=$1', [req.params.id]);
    await log(req.user.id, req.user.name, req.user.role, 'brand_deleted', b.name, '', 'inventory', req.ip);
    invalidateCache();
    res.json({ message: 'Brand removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete brand' });
  }
});

// ── GET /api/categories/subtypes — CACHED ────────────────────────────────────
router.get('/subtypes', requireAuth, async (req, res) => {
  try {
    const { brand_id } = req.query;
    const cacheKey = `subtypes:${brand_id||'all'}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let sql = `SELECT st.*, COUNT(p.id) as product_count, COALESCE(SUM(p.stock), 0) as total_stock
      FROM sub_types st
      LEFT JOIN products p ON p.sub_type_id = st.id AND p.is_active = TRUE
      WHERE st.is_active = true`;
    const vals = [];
    if (brand_id) { sql += ` AND st.brand_id = $${vals.length+1}`; vals.push(brand_id); }
    sql += ' GROUP BY st.id, st.brand_id, st.name, st.sort_order, st.is_active, st.created_at ORDER BY st.sort_order, st.name';
    const { rows } = await db.query(sql, vals);
    setCached(cacheKey, rows);
    res.json(rows);
  } catch (err) {
    console.error('[categories] GET subtypes:', err.message);
    res.status(500).json({ error: 'Failed to fetch sub-types' });
  }
});

// ── GET /api/categories/tree — CACHED ────────────────────────────────────────
router.get('/tree', requireAuth, async (req, res) => {
  try {
    const { top_type, in_stock } = req.query;
    const cacheKey = `tree:${top_type||'all'}:${in_stock||''}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let sql = `
      SELECT b.top_type, b.id as brand_id, b.name as brand_name,
        st.id as sub_type_id, st.name as sub_type_name,
        COUNT(p.id) as product_count, COALESCE(SUM(p.stock), 0) as total_stock
      FROM brands b
      LEFT JOIN sub_types st ON st.brand_id = b.id AND st.is_active = true
      LEFT JOIN products p ON p.sub_type_id = st.id AND p.is_active = true
    `;
    if (in_stock === 'true') sql += ' AND p.stock > 0';
    const vals = [];
    if (top_type) { sql += ` WHERE b.top_type = $${++vals.length}`; vals.push(top_type); }
    sql += ' GROUP BY b.top_type, b.id, b.name, st.id, st.name ORDER BY b.top_type, b.sort_order, b.name, st.sort_order, st.name';

    const { rows } = await db.query(sql, vals);
    const tree = {};
    for (const row of rows) {
      if (!tree[row.top_type]) tree[row.top_type] = { name: row.top_type.charAt(0).toUpperCase() + row.top_type.slice(1), brands: {} };
      if (!tree[row.top_type].brands[row.brand_id]) tree[row.top_type].brands[row.brand_id] = { id: row.brand_id, name: row.brand_name, sub_types: [] };
      if (row.sub_type_id) tree[row.top_type].brands[row.brand_id].sub_types.push({ id: row.sub_type_id, name: row.sub_type_name, product_count: parseInt(row.product_count), total_stock: parseInt(row.total_stock) });
    }
    setCached(cacheKey, tree);
    res.json(tree);
  } catch (err) {
    console.error('[categories] GET tree:', err.message);
    res.status(500).json({ error: 'Failed to fetch category tree' });
  }
});

// ── POST /api/categories/rebuild ─────────────────────────────────────────────
router.post('/rebuild', requireAuth, ADMIN, async (req, res) => {
  try {
    await log(req.user.id, req.user.name, req.user.role, 'categories_rebuilt', 'Category hierarchy', 'Triggered by ' + req.user.name, 'inventory', req.ip);
    await db.query('SELECT rebuild_categories_from_products()');
    const { rows: [brandCount] }   = await db.query('SELECT COUNT(*) as count FROM brands WHERE is_active = true');
    const { rows: [subtypeCount] } = await db.query('SELECT COUNT(*) as count FROM sub_types WHERE is_active = true');
    invalidateCache();
    res.json({ message: 'Categories rebuilt successfully from products', brands: parseInt(brandCount.count), sub_types: parseInt(subtypeCount.count) });
  } catch (err) {
    console.error('[categories] POST rebuild:', err.message);
    res.status(500).json({ error: 'Failed to rebuild categories' });
  }
});

// ── POST /api/categories/subtypes ────────────────────────────────────────────
router.post('/subtypes', requireAuth, ADMIN, async (req, res) => {
  try {
    const { brand_id, name, photo_url, sort_order } = req.body;
    if (!brand_id || !name) return res.status(400).json({ error: 'brand_id and name are required' });
    const { rows } = await db.query(
      'INSERT INTO sub_types (brand_id, name, photo_url, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
      [brand_id, name.trim(), photo_url || null, sort_order || 0]
    );
    await log(req.user.id, req.user.name, req.user.role, 'subtype_created', name, `Brand: ${brand_id}`, 'inventory', req.ip);
    invalidateCache();
    res.status(201).json({ id: rows[0].id, message: 'Sub-type created' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Sub-type already exists for this brand' });
    res.status(500).json({ error: 'Failed to create sub-type' });
  }
});

// ── PUT /api/categories/subtypes/:id ─────────────────────────────────────────
router.put('/subtypes/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, photo_url, sort_order, is_active } = req.body;
    const fields = [], vals = [];
    if (name       !== undefined) { fields.push(`name=$${vals.length+1}`);       vals.push(name); }
    if (photo_url  !== undefined) { fields.push(`photo_url=$${vals.length+1}`);  vals.push(photo_url); }
    if (sort_order !== undefined) { fields.push(`sort_order=$${vals.length+1}`); vals.push(sort_order); }
    if (is_active  !== undefined) { fields.push(`is_active=$${vals.length+1}`);  vals.push(!!is_active); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE sub_types SET ${fields.join(',')} WHERE id=$${vals.length}`, vals);
    invalidateCache();
    res.json({ message: 'Sub-type updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update sub-type' });
  }
});

// ── DELETE /api/categories/subtypes/:id ──────────────────────────────────────
router.delete('/subtypes/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { rows: [st] } = await db.query('SELECT name FROM sub_types WHERE id=$1', [req.params.id]);
    if (!st) return res.status(404).json({ error: 'Sub-type not found' });
    await db.query('UPDATE sub_types SET is_active=false WHERE id=$1', [req.params.id]);
    await log(req.user.id, req.user.name, req.user.role, 'subtype_deleted', st.name, '', 'inventory', req.ip);
    invalidateCache();
    res.json({ message: 'Sub-type removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete sub-type' });
  }
});

module.exports = router;