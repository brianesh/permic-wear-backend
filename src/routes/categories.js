/**
 * /api/categories — CRUD for brands & sub_types
 * Super Admin + Admin can create / update / delete.
 * All authenticated users can read.
 */
const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');
const router  = express.Router();
const ADMIN   = requireRole('super_admin', 'admin');

// ── GET /api/categories/brands?top_type=shoes|clothes ────────────
router.get('/brands', requireAuth, async (req, res) => {
  try {
    const { top_type } = req.query;
    let sql = 'SELECT * FROM brands WHERE is_active = true';
    const vals = [];
    if (top_type) { sql += ' AND top_type = ?'; vals.push(top_type); }
    sql += ' ORDER BY sort_order, name';
    const [rows] = await db.query(sql, vals);
    res.json(rows);
  } catch (err) {
    console.error('[categories] GET brands:', err.message);
    res.status(500).json({ error: 'Failed to fetch brands' });
  }
});

// ── POST /api/categories/brands ───────────────────────────────────
router.post('/brands', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, top_type, photo_url, sort_order } = req.body;
    if (!name || !top_type) return res.status(400).json({ error: 'name and top_type are required' });
    const [rrows] = await db.query(
      'INSERT INTO brands (name, top_type, photo_url, sort_order) VALUES (?,?,?,?)',
      [name.trim(), top_type, photo_url || null, sort_order || 0]
    );
    await log(req.user.id, req.user.name, req.user.role, 'brand_created', name, `Type: ${top_type}`, 'inventory', req.ip);
    res.status(201).json({ id: rrows[0].id, message: 'Brand created' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Brand already exists for this type' });
    console.error('[categories] POST brands:', err.message);
    res.status(500).json({ error: 'Failed to create brand' });
  }
});

// ── PUT /api/categories/brands/:id ───────────────────────────────
router.put('/brands/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, photo_url, sort_order, is_active } = req.body;
    const fields = [], vals = [];
    if (name        !== undefined) { fields.push('name=?');        vals.push(name); }
    if (photo_url   !== undefined) { fields.push('photo_url=?');   vals.push(photo_url); }
    if (sort_order  !== undefined) { fields.push('sort_order=?');  vals.push(sort_order); }
    if (is_active   !== undefined) { fields.push('is_active=?');   vals.push(is_active ? true : false); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE brands SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ message: 'Brand updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update brand' });
  }
});

// ── DELETE /api/categories/brands/:id ────────────────────────────
router.delete('/brands/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const [[b]] = await db.query('SELECT name FROM brands WHERE id=?', [req.params.id]);
    if (!b) return res.status(404).json({ error: 'Brand not found' });
    await db.query('UPDATE brands SET is_active=false WHERE id=?', [req.params.id]);
    await log(req.user.id, req.user.name, req.user.role, 'brand_deleted', b.name, '', 'inventory', req.ip);
    res.json({ message: 'Brand removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete brand' });
  }
});

// ── GET /api/categories/subtypes?brand_id=X ──────────────────────
router.get('/subtypes', requireAuth, async (req, res) => {
  try {
    const { brand_id } = req.query;
    let sql = 'SELECT * FROM sub_types WHERE is_active=true';
    const vals = [];
    if (brand_id) { sql += ' AND brand_id=?'; vals.push(brand_id); }
    sql += ' ORDER BY sort_order, name';
    const [rows] = await db.query(sql, vals);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sub-types' });
  }
});

// ── POST /api/categories/subtypes ────────────────────────────────
router.post('/subtypes', requireAuth, ADMIN, async (req, res) => {
  try {
    const { brand_id, name, photo_url, sort_order } = req.body;
    if (!brand_id || !name) return res.status(400).json({ error: 'brand_id and name are required' });
    const [rrows] = await db.query(
      'INSERT INTO sub_types (brand_id, name, photo_url, sort_order) VALUES (?,?,?,?)',
      [brand_id, name.trim(), photo_url || null, sort_order || 0]
    );
    await log(req.user.id, req.user.name, req.user.role, 'subtype_created', name, `Brand: ${brand_id}`, 'inventory', req.ip);
    res.status(201).json({ id: rrows[0].id, message: 'Sub-type created' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Sub-type already exists for this brand' });
    res.status(500).json({ error: 'Failed to create sub-type' });
  }
});

// ── PUT /api/categories/subtypes/:id ─────────────────────────────
router.put('/subtypes/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, photo_url, sort_order, is_active } = req.body;
    const fields = [], vals = [];
    if (name       !== undefined) { fields.push('name=?');       vals.push(name); }
    if (photo_url  !== undefined) { fields.push('photo_url=?');  vals.push(photo_url); }
    if (sort_order !== undefined) { fields.push('sort_order=?'); vals.push(sort_order); }
    if (is_active  !== undefined) { fields.push('is_active=?');  vals.push(is_active ? true : false); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE sub_types SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ message: 'Sub-type updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update sub-type' });
  }
});

// ── DELETE /api/categories/subtypes/:id ──────────────────────────
router.delete('/subtypes/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const [[st]] = await db.query('SELECT name FROM sub_types WHERE id=?', [req.params.id]);
    if (!st) return res.status(404).json({ error: 'Sub-type not found' });
    await db.query('UPDATE sub_types SET is_active=false WHERE id=?', [req.params.id]);
    await log(req.user.id, req.user.name, req.user.role, 'subtype_deleted', st.name, '', 'inventory', req.ip);
    res.json({ message: 'Sub-type removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete sub-type' });
  }
});

module.exports = router;
