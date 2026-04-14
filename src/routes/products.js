/**
 * products.js — Products with multi-store scoping + fast autocomplete
 *
 * EGRESS FIX: Added in-memory cache (5-min TTL) on GET / and GET /search.
 *   Same data was being fetched from Supabase on every page load and POS search.
 *   Cache is cleared automatically on any mutation (POST/PUT/DELETE).
 *   This alone should cut egress by 70-80% for typical usage.
 */

const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateVariants, previewVariants, validateProductInput } = require('../services/variantGenerator');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// ── In-memory cache (5 min TTL) ───────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) { cache.set(key, { data, time: Date.now() }); }
function invalidateCache() { cache.clear(); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function storeFilter(user, paramOffset = 1) {
  if (!user) return { clause: '', vals: [], next: paramOffset };
  const storeId = user.active_store_id;
  if (!storeId) return { clause: '', vals: [], next: paramOffset };
  return {
    clause: ` AND (p.store_id = $${paramOffset} OR p.store_id IS NULL)`,
    vals: [storeId],
    next: paramOffset + 1,
  };
}

// ── GET /api/products/grouped ─────────────────────────────────────────────────
router.get('/grouped', requireAuth, async (req, res) => {
  try {
    const { brand_id, sub_type_id, top_type, search, in_stock } = req.query;
    let sql = `
      SELECT p.id, p.name, p.brand, p.brand_id, p.sub_type_id,
        p.top_type, p.category, p.photo_url, p.is_active, p.store_id,
        COALESCE(p.stock, 0) + COALESCE(
          (SELECT SUM(v.stock) FROM products v WHERE v.parent_id = p.id AND v.is_active = TRUE), 0
        ) as total_stock,
        (SELECT json_agg(json_build_object(
            'id', v.id, 'size', v.size, 'sku', v.sku, 'stock', v.stock,
            'min_price', v.min_price, 'color', v.color, 'photo_url', v.photo_url
          ) ORDER BY v.size)
          FROM products v WHERE (v.parent_id = p.id OR v.id = p.id) AND v.is_active = TRUE
        ) as variants,
        1 + (SELECT COUNT(*) FROM products v WHERE v.parent_id = p.id AND v.is_active = TRUE) as variant_count
      FROM products p
      WHERE p.is_active = TRUE AND p.parent_id IS NULL
    `;
    const vals = []; let idx = 1;
    if (brand_id)    { sql += ` AND p.brand_id = $${idx++}`;    vals.push(brand_id); }
    if (sub_type_id) { sql += ` AND p.sub_type_id = $${idx++}`; vals.push(sub_type_id); }
    if (top_type)    { sql += ` AND p.top_type = $${idx++}`;    vals.push(top_type); }
    if (in_stock === 'true') sql += ` AND (p.stock + COALESCE((SELECT SUM(v.stock) FROM products v WHERE v.parent_id = p.id AND v.is_active = TRUE), 0)) > 0`;
    if (search) { sql += ` AND (p.name ILIKE $${idx} OR p.brand ILIKE $${idx})`; vals.push(`%${search}%`); idx++; }
    sql += ' ORDER BY p.brand, p.name, p.color';
    const { rows } = await db.query(sql, vals);
    res.json(rows);
  } catch (err) {
    console.error('[products] GET /grouped:', err.message);
    res.status(500).json({ error: 'Failed to fetch grouped products' });
  }
});

// ── GET /api/products/variants/:id ────────────────────────────────────────────
router.get('/variants/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [parent] } = await db.query(
      'SELECT * FROM products WHERE id = $1 AND is_active = TRUE', [req.params.id]
    );
    if (!parent) return res.status(404).json({ error: 'Product not found' });
    const { rows: variants } = await db.query(`
      SELECT id, name, brand, color, size, sku, stock, min_price, photo_url, is_active
      FROM products WHERE (parent_id = $1 OR id = $1) AND is_active = TRUE ORDER BY size
    `, [req.params.id]);
    res.json({ parent, variants, total_stock: variants.reduce((s, v) => s + parseInt(v.stock||0), 0) });
  } catch (err) {
    console.error('[products] GET /variants/:id:', err.message);
    res.status(500).json({ error: 'Failed to fetch product variants' });
  }
});

// ── GET /api/products — CACHED ────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { brand_id, sub_type_id, top_type, search, in_stock } = req.query;
    const sid = req.user.active_store_id || 'all';
    const cacheKey = `products:${sid}:${brand_id||''}:${sub_type_id||''}:${top_type||''}:${search||''}:${in_stock||''}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let sql = `
      SELECT p.*, b.name AS brand, b.top_type AS brand_top_type,
        st.name AS category, st.id AS sub_type_id_check
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN sub_types st ON p.sub_type_id = st.id
      WHERE p.is_active = TRUE
    `;
    const vals = []; let idx = 1;
    const sf = storeFilter(req.user, idx);
    if (sf.clause) { sql += sf.clause; vals.push(...sf.vals); idx = sf.next; }
    if (brand_id)    { sql += ` AND p.brand_id = $${idx++}`;    vals.push(parseInt(brand_id)); }
    if (sub_type_id) { sql += ` AND p.sub_type_id = $${idx++}`; vals.push(parseInt(sub_type_id)); }
    if (top_type)    { sql += ` AND (p.top_type = $${idx} OR b.top_type = $${idx})`; vals.push(top_type); idx++; }
    if (in_stock === 'true') sql += ` AND p.stock > 0`;
    if (search) {
      sql += ` AND (p.name ILIKE $${idx} OR b.name ILIKE $${idx} OR p.sku ILIKE $${idx} OR p.color ILIKE $${idx})`;
      vals.push(`%${search}%`); idx++;
    }
    sql += ' ORDER BY b.name, p.name, p.size';
    const { rows } = await db.query(sql, vals);
    setCached(cacheKey, rows);
    res.json(rows);
  } catch (err) {
    console.error('[products] GET /:', err.message);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// ── GET /api/products/debug ───────────────────────────────────────────────────
router.get('/debug', requireAuth, async (req, res) => {
  try {
    const { rows: [total] }    = await db.query('SELECT COUNT(*) as count FROM products');
    const { rows: [active] }   = await db.query('SELECT COUNT(*) as count FROM products WHERE is_active = TRUE');
    const { rows: [inactive] } = await db.query('SELECT COUNT(*) as count FROM products WHERE is_active = FALSE OR is_active IS NULL');
    const { rows: sample }     = await db.query('SELECT id, name, brand, size, stock, is_active, store_id FROM products ORDER BY id DESC LIMIT 5');
    res.json({ total: parseInt(total.count), active: parseInt(active.count), inactive: parseInt(inactive.count), sample, cacheSize: cache.size, userStoreId: req.user.active_store_id, userRole: req.user.role });
  } catch (err) {
    console.error('[products] debug:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/search — CACHED ────────────────────────────────────────
router.get('/search', requireAuth, async (req, res) => {
  try {
    const { q, top_type, in_stock } = req.query;
    if (!q || q.trim().length < 1) return res.json([]);
    const sid = req.user.active_store_id || 'all';
    const cacheKey = `search:${sid}:${q.trim().toLowerCase()}:${top_type||''}:${in_stock||''}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const like = `%${q.trim()}%`;
    const vals = [like]; let idx = 2;
    let storeSql = '';
    if (req.user.active_store_id) { storeSql = ` AND (p.store_id = $${idx} OR p.store_id IS NULL)`; vals.push(req.user.active_store_id); idx++; }
    let topTypeSql = '';
    if (top_type) { topTypeSql = ` AND (p.top_type = $${idx} OR b.top_type = $${idx})`; vals.push(top_type); idx++; }
    const inStockSql = in_stock === 'true' ? ' AND p.stock > 0' : '';

    const { rows } = await db.query(`
      SELECT p.*, b.name AS brand, b.top_type AS brand_top_type, st.name AS category,
        0 AS fav_count,
        CASE WHEN p.name ILIKE $1 THEN 3 WHEN b.name ILIKE $1 THEN 2 ELSE 1 END AS match_rank
      FROM products p
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN sub_types st ON p.sub_type_id = st.id
      WHERE p.is_active = TRUE
        AND (p.name ILIKE $1 OR b.name ILIKE $1 OR p.sku ILIKE $1 OR p.color ILIKE $1 OR st.name ILIKE $1)
        ${storeSql}${topTypeSql}${inStockSql}
      ORDER BY match_rank DESC, p.name ASC LIMIT 15
    `, vals);
    setCached(cacheKey, rows);
    res.json(rows);
  } catch (err) {
    console.error('[products] /search:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── GET /api/products/favorites ───────────────────────────────────────────────
router.get('/favorites', requireAuth, async (req, res) => {
  try {
    const { top_type, in_stock } = req.query;
    const vals = []; let idx = 1;
    let topTypeSql = ''; if (top_type) { topTypeSql = ` AND p.top_type = $${idx}`; vals.push(top_type); idx++; }
    let storeSql = ''; if (req.user.active_store_id) { storeSql = ` AND p.store_id = $${idx}`; vals.push(req.user.active_store_id); idx++; }
    const inStockSql = in_stock === 'true' ? ' AND p.stock > 0' : '';
    try {
      const { rows } = await db.query(`
        SELECT p.*, COALESCE(pf.use_count, 0) as fav_count FROM products p
        LEFT JOIN product_favorites pf ON pf.product_id = p.id AND pf.user_id = $1
        WHERE p.is_active = TRUE ${inStockSql}${topTypeSql}${storeSql}
        ORDER BY COALESCE(pf.use_count, 0) DESC, p.name ASC LIMIT 12
      `, [req.user.id, ...vals]);
      res.json(rows);
    } catch {
      const { rows } = await db.query(`SELECT p.*, 0 as fav_count FROM products p WHERE p.is_active = TRUE ${inStockSql}${topTypeSql}${storeSql} ORDER BY p.name ASC LIMIT 12`, vals);
      res.json(rows);
    }
  } catch (err) {
    console.error('[products] /favorites:', err.message);
    res.status(500).json({ error: 'Failed to load favorites' });
  }
});

// ── POST /api/products/favorites/:id ─────────────────────────────────────────
router.post('/favorites/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'product_favorites') as exists`);
    if (rows[0]?.exists) {
      await db.query(`INSERT INTO product_favorites (user_id, product_id, use_count, last_used) VALUES ($1,$2,1,NOW()) ON CONFLICT (user_id, product_id) DO UPDATE SET use_count = product_favorites.use_count + 1, last_used = NOW()`, [req.user.id, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) { console.warn('[products] favorites upsert:', err.message); res.json({ ok: false }); }
});

// ── POST /api/products ────────────────────────────────────────────────────────
router.post('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, brand, brand_id, sub_type_id, top_type, category, size, sku, stock, min_price, color, photo_url } = req.body;
    if (!name || !sku || !min_price) return res.status(400).json({ error: 'name, sku, min_price are required' });
    let storeId = req.body.store_id;
    if (req.user.role !== 'super_admin') storeId = req.user.active_store_id;
    const { rows } = await db.query(`
      INSERT INTO products (name,brand,brand_id,sub_type_id,top_type,category,size,sku,stock,min_price,color,photo_url,store_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id
    `, [name, brand||'Other', brand_id||null, sub_type_id||null, top_type||'shoes', category||'Lifestyle', size||'', sku, stock||0, min_price, color||'', photo_url||null, storeId||null]);
    await log(req.user.id, req.user.name, req.user.role, 'product_added', `${name} Sz${size}`, `SKU: ${sku}, Stock: ${stock}, Min: ${min_price}`, 'inventory', req.ip);
    invalidateCache();
    res.status(201).json({ id: rows[0].id, message: 'Product created' });
  } catch (err) {
    console.error('[products] POST /:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'SKU already exists' });
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// ── PUT /api/products/:id ─────────────────────────────────────────────────────
router.put('/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, brand, brand_id, sub_type_id, top_type, category, size, sku, stock, min_price, color, photo_url } = req.body;
    const { rows: [old] } = await db.query('SELECT * FROM products WHERE id = $1', [id]);
    if (!old) return res.status(404).json({ error: 'Product not found' });
    await db.query(`UPDATE products SET name=$1,brand=$2,brand_id=$3,sub_type_id=$4,top_type=$5,category=$6,size=$7,sku=$8,stock=$9,min_price=$10,color=$11,photo_url=$12 WHERE id=$13`,
      [name??old.name, brand??old.brand, brand_id!==undefined?brand_id:old.brand_id, sub_type_id!==undefined?sub_type_id:old.sub_type_id,
       top_type??old.top_type, category??old.category, size??old.size, sku??old.sku, stock!==undefined?stock:old.stock,
       min_price??old.min_price, color!==undefined?color:old.color, photo_url!==undefined?photo_url:old.photo_url, id]);
    const changes = [];
    if (stock !== undefined && stock !== old.stock) changes.push(`Stock: ${old.stock}→${stock}`);
    if (min_price !== undefined && min_price !== old.min_price) changes.push(`Price: ${old.min_price}→${min_price}`);
    await log(req.user.id, req.user.name, req.user.role, 'product_edited', `${old.name} Sz${old.size}`, changes.join(', ')||'Details updated', 'inventory', req.ip);
    invalidateCache();
    res.json({ message: 'Product updated' });
  } catch (err) {
    console.error('[products] PUT /:id:', err.message);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// ── DELETE /api/products/:id ──────────────────────────────────────────────────
router.delete('/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { rows: [p] } = await db.query('SELECT name, size FROM products WHERE id = $1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    await db.query('UPDATE products SET is_active = FALSE WHERE id = $1', [req.params.id]);
    await log(req.user.id, req.user.name, req.user.role, 'product_deleted', `${p.name} Sz${p.size}`, 'Removed from inventory', 'inventory', req.ip);
    invalidateCache();
    res.json({ message: 'Product removed' });
  } catch (err) {
    console.error('[products] DELETE /:id:', err.message);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ── POST /api/products/bulk-import ───────────────────────────────────────────
router.post('/bulk-import', requireAuth, ADMIN, async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'products array required' });
    let storeId = req.body.store_id;
    if (req.user.role !== 'super_admin') storeId = req.user.active_store_id;
    let imported = 0;
    for (const p of products) {
      if (!p.name || !p.sku || !p.min_price) continue;
      await db.query(`INSERT INTO products (name,brand,brand_id,sub_type_id,top_type,category,size,sku,stock,min_price,color,store_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (sku) DO UPDATE SET stock=EXCLUDED.stock, min_price=EXCLUDED.min_price`,
        [p.name, p.brand||'Other', p.brand_id||null, p.sub_type_id||null, p.top_type||'shoes', p.category||'Lifestyle', p.size||'', p.sku, p.stock||0, p.min_price, p.color||'', storeId||null]);
      imported++;
    }
    await log(req.user.id, req.user.name, req.user.role, 'csv_import', `${imported} products`, 'Bulk import', 'inventory', req.ip);
    invalidateCache();
    res.json({ message: `${imported} products imported` });
  } catch (err) {
    console.error('[products] bulk-import:', err.message);
    res.status(500).json({ error: 'Bulk import failed' });
  }
});

// ── POST /api/products/preview-variants ──────────────────────────────────────
router.post('/preview-variants', requireAuth, ADMIN, async (req, res) => {
  try {
    const validation = validateProductInput(req.body);
    if (!validation.valid) return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    const variants = previewVariants(req.body);
    res.json({ count: variants.length, variants, warnings: validation.warnings });
  } catch (err) {
    console.error('[products] preview-variants:', err.message);
    res.status(500).json({ error: 'Failed to preview variants' });
  }
});

// ── POST /api/products/bulk-create ───────────────────────────────────────────
router.post('/bulk-create', requireAuth, ADMIN, async (req, res) => {
  try {
    const body = req.body;
    const getStoreId = (id) => req.user.role === 'super_admin' ? (id || null) : req.user.active_store_id;

    // PATH A: Array of pre-expanded variants
    if (Array.isArray(body)) {
      if (!body.length) return res.status(400).json({ error: 'Empty variants array' });
      const validationErrors = [];
      body.forEach((item, i) => {
        if (!item.name?.trim())            validationErrors.push(`Item ${i+1}: name required`);
        if (!item.brand?.trim())           validationErrors.push(`Item ${i+1}: brand required`);
        if (!item.sku?.trim())             validationErrors.push(`Item ${i+1}: sku required`);
        if (!item.size?.toString().trim()) validationErrors.push(`Item ${i+1}: size required`);
        const price = item.minPrice ?? item.min_price;
        if (!price || parseFloat(price) <= 0) validationErrors.push(`Item ${i+1}: minPrice must be > 0`);
        if (item.stock === undefined || parseInt(item.stock) < 0) validationErrors.push(`Item ${i+1}: stock cannot be negative`);
      });
      if (validationErrors.length) return res.status(400).json({ error: 'Validation failed', details: validationErrors });

      const insertedIds = [], errors = [];
      for (const item of body) {
        try {
          const price = item.minPrice ?? item.min_price;
          const { rows } = await db.query(`
            INSERT INTO products (name,brand,brand_id,sub_type_id,top_type,category,size,sku,stock,min_price,color,photo_url,store_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT (sku) DO UPDATE SET stock=EXCLUDED.stock, min_price=EXCLUDED.min_price, brand_id=EXCLUDED.brand_id, sub_type_id=EXCLUDED.sub_type_id
            RETURNING id
          `, [item.name.trim(), item.brand||'Other', item.brand_id?parseInt(item.brand_id):null, item.sub_type_id?parseInt(item.sub_type_id):null,
              item.top_type||item.topType||'shoes', item.category||'', item.size.toString(), item.sku.trim(),
              parseInt(item.stock)||0, parseFloat(price), item.color||'', item.photo_url||null, getStoreId(item.store_id)]);
          insertedIds.push(rows[0].id);
        } catch (err) {
          errors.push(err.code === '23505' ? `SKU ${item.sku} already exists` : `Error creating ${item.color||''} ${item.size}: ${err.message}`);
        }
      }
      await log(req.user.id, req.user.name, req.user.role, 'bulk_product_created', body[0]?.name||'products', `Created ${insertedIds.length} variants (${body.length} requested)`, 'inventory', req.ip);
      invalidateCache();
      return res.json({ message: `Created ${insertedIds.length} of ${body.length} variants`, created: insertedIds.length, total: body.length, errors: errors.length ? errors : undefined, ids: insertedIds });
    }

    // PATH B: Single matrix object
    const product = body;
    const validation = validateProductInput(product);
    if (!validation.valid) return res.status(400).json({ error: 'Validation failed', details: validation.errors });

    let brandId = product.brand_id || null;
    let subTypeId = product.sub_type_id || null;
    if (!brandId && product.brand) {
      const { rows: [b] } = await db.query('SELECT id FROM brands WHERE name=$1 AND top_type=$2 LIMIT 1', [product.brand, product.topType||product.top_type||'shoes']);
      if (b) brandId = b.id;
    }
    if (!subTypeId && product.subType) {
      const { rows: [s] } = await db.query('SELECT id FROM sub_types WHERE name=$1 AND brand_id=$2 LIMIT 1', [product.subType, brandId]);
      if (s) subTypeId = s.id;
    }

    const variants = await generateVariants(db, {
      name: product.name, brand: product.brand, brand_id: brandId, subType: product.subType, sub_type_id: subTypeId,
      colors: product.colors||[], sizes: product.sizes||[], minPrice: product.min_price||product.minPrice,
      stock: product.stock||0, stockMap: product.stockMap||{}, category: product.category,
      topType: product.topType||product.top_type||'shoes', distributeStock: product.distributeStock||false,
    });
    if (!variants.length) return res.status(400).json({ error: 'No variants generated' });

    const storeId = getStoreId(product.store_id);
    const insertedIds = [], errors = [];
    for (const v of variants) {
      try {
        const { rows } = await db.query(`
          INSERT INTO products (name,brand,brand_id,sub_type_id,top_type,category,size,sku,stock,min_price,color,store_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (sku) DO UPDATE SET stock=EXCLUDED.stock, min_price=EXCLUDED.min_price, brand_id=EXCLUDED.brand_id, sub_type_id=EXCLUDED.sub_type_id
          RETURNING id
        `, [v.name, v.brand, v.brand_id||brandId, v.sub_type_id||subTypeId, v.topType, v.category, v.size, v.sku, v.stock, v.minPrice, v.color, storeId]);
        insertedIds.push(rows[0].id);
      } catch (err) {
        errors.push(err.code === '23505' ? `SKU ${v.sku} already exists` : `Error creating ${v.color} ${v.size}: ${err.message}`);
      }
    }
    await log(req.user.id, req.user.name, req.user.role, 'bulk_product_created', product.name, `Created ${insertedIds.length} variants (${variants.length} requested)`, 'inventory', req.ip);
    invalidateCache();
    res.json({ message: `Created ${insertedIds.length} of ${variants.length} variants`, created: insertedIds.length, total: variants.length, errors: errors.length?errors:undefined, warnings: validation.warnings, ids: insertedIds });

  } catch (err) {
    console.error('[products] bulk-create:', err.message);
    res.status(500).json({ error: 'Bulk creation failed' });
  }
});

module.exports = router;