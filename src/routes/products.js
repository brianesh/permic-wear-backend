/**
 * products.js — Products with multi-store scoping + fast autocomplete
 *
 * GET /api/products          — list products (scoped to user's store)
 * GET /api/products/search   — fast autocomplete (returns up to 12 results)
 * GET /api/products/favorites — cashier's most-used products
 * POST /api/products/favorites/:id — record a product was used (for ranking)
 */

const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateVariants, previewVariants, validateProductInput, prepareBulkInsert } = require('../services/variantGenerator');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// ── Helpers ───────────────────────────────────────────────────────────────────
// Build a store filter clause — super_admin with no store_id sees all
function storeFilter(user, paramOffset = 1) {
  if (user.role === 'super_admin' && !user.store_id) return { clause: '', vals: [], next: paramOffset };
  const storeId = user.store_id;
  return {
    clause: ` AND (p.store_id = $${paramOffset} OR p.store_id IS NULL)`,
    vals: [storeId],
    next: paramOffset + 1,
  };
}

// ── GET /api/products — full list with filters ─────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { brand, brand_id, sub_type_id, top_type, category, search, in_stock } = req.query;

    let sql  = 'SELECT p.* FROM products p WHERE p.is_active = TRUE';
    const vals = [];
    let idx  = 1;

    // Store scoping
    const sf = storeFilter(req.user, idx);
    if (sf.clause) { sql += sf.clause; vals.push(...sf.vals); idx = sf.next; }

    if (brand      && brand    !== 'All') { sql += ` AND p.brand = $${idx++}`;        vals.push(brand); }
    if (brand_id)                          { sql += ` AND p.brand_id = $${idx++}`;    vals.push(brand_id); }
    if (sub_type_id)                       { sql += ` AND p.sub_type_id = $${idx++}`; vals.push(sub_type_id); }
    if (top_type)                          { sql += ` AND p.top_type = $${idx++}`;    vals.push(top_type); }
    if (category   && category !== 'All') { sql += ` AND p.category = $${idx++}`;     vals.push(category); }
    if (in_stock === 'true')               { sql += ` AND p.stock > 0`; }

    if (search) {
      sql += ` AND (p.name ILIKE $${idx} OR p.brand ILIKE $${idx} OR p.sku ILIKE $${idx} OR p.color ILIKE $${idx})`;
      vals.push(`%${search}%`);
      idx++;
    }

    sql += ' ORDER BY p.brand, p.name, p.size';

    console.log('[products] Query:', sql, 'Vals:', vals);
    const { rows } = await db.query(sql, vals);
    console.log('[products] Found', rows.length, 'products');
    res.json(rows);
  } catch (err) {
    console.error('[products] GET /:', err.message);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// ── GET /api/products/debug — debug endpoint to check products table ────────────
router.get('/debug', requireAuth, async (req, res) => {
  try {
    // Check total products count
    const { rows: [total] } = await db.query('SELECT COUNT(*) as count FROM products');
    const { rows: [active] } = await db.query('SELECT COUNT(*) as count FROM products WHERE is_active = TRUE');
    const { rows: [inactive] } = await db.query('SELECT COUNT(*) as count FROM products WHERE is_active = FALSE OR is_active IS NULL');
    const { rows: sample } = await db.query('SELECT id, name, brand, size, stock, is_active, store_id FROM products ORDER BY id DESC LIMIT 5');

    res.json({
      total: parseInt(total.count),
      active: parseInt(active.count),
      inactive: parseInt(inactive.count),
      sample: sample,
      userStoreId: req.user.store_id,
      userRole: req.user.role,
    });
  } catch (err) {
    console.error('[products] debug:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/products/search — autocomplete (fast, max 15 results) ─────────────
// Returns products ranked: favorites first, then by name match
router.get('/search', requireAuth, async (req, res) => {
  try {
    const { q, top_type, in_stock } = req.query;
    if (!q || q.trim().length < 1) return res.json([]);

    const term    = q.trim();
    const like    = `%${term}%`;
    const userId  = req.user.id;
    const vals    = [like, userId];
    let   idx     = 3;

    let storeSql = '';
    if (req.user.store_id) {
      storeSql = ` AND (p.store_id = $${idx} OR p.store_id IS NULL)`;
      vals.push(req.user.store_id);
      idx++;
    }

    let topTypeSql = '';
    if (top_type) {
      topTypeSql = ` AND p.top_type = $${idx}`;
      vals.push(top_type);
      idx++;
    }

    let inStockSql = '';
    if (in_stock === 'true') inStockSql = ' AND p.stock > 0';

    // Rank: exact name start > brand match > anywhere; favorites bubble up
    const { rows } = await db.query(`
      SELECT
        p.*,
        COALESCE(pf.use_count, 0) AS fav_count,
        CASE
          WHEN p.name  ILIKE $1 THEN 3
          WHEN p.brand ILIKE $1 THEN 2
          ELSE 1
        END AS match_rank
      FROM products p
      LEFT JOIN product_favorites pf ON pf.product_id = p.id AND pf.user_id = $2
      WHERE p.is_active = TRUE
        AND (p.name ILIKE $1 OR p.brand ILIKE $1 OR p.sku ILIKE $1
             OR p.color ILIKE $1 OR p.category ILIKE $1)
        ${storeSql}${topTypeSql}${inStockSql}
      ORDER BY fav_count DESC, match_rank DESC, p.name ASC
      LIMIT 15
    `, vals);

    res.json(rows);
  } catch (err) {
    console.error('[products] /search:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── GET /api/products/favorites — top 12 for this cashier ─────────────────────
router.get('/favorites', requireAuth, async (req, res) => {
  try {
    const { top_type } = req.query;
    const vals = [req.user.id];
    let idx = 2;
    let topTypeSql = '';
    if (top_type) { topTypeSql = ` AND p.top_type = $${idx}`; vals.push(top_type); idx++; }

    let storeSql = '';
    if (req.user.store_id) {
      storeSql = ` AND (p.store_id = $${idx} OR p.store_id IS NULL)`;
      vals.push(req.user.store_id);
    }

    const { rows } = await db.query(`
      SELECT p.*, pf.use_count, pf.last_used
      FROM product_favorites pf
      JOIN products p ON p.id = pf.product_id
      WHERE pf.user_id = $1
        AND p.is_active = TRUE
        AND p.stock > 0
        ${topTypeSql}${storeSql}
      ORDER BY pf.use_count DESC, pf.last_used DESC
      LIMIT 12
    `, vals);

    res.json(rows);
  } catch (err) {
    console.error('[products] /favorites:', err.message);
    res.status(500).json({ error: 'Failed to load favorites' });
  }
});

// ── POST /api/products/favorites/:id — record product used in a sale ───────────
router.post('/favorites/:id', requireAuth, async (req, res) => {
  try {
    await db.query(`
      INSERT INTO product_favorites (user_id, product_id, use_count, last_used)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (user_id, product_id) DO UPDATE
        SET use_count = product_favorites.use_count + 1,
            last_used = NOW()
    `, [req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    // Non-critical — don't fail the sale
    console.warn('[products] favorites upsert:', err.message);
    res.json({ ok: false });
  }
});

// ── POST /api/products ─────────────────────────────────────────────────────────
router.post('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, brand, brand_id, sub_type_id, top_type, category,
            size, sku, stock, min_price, color, photo_url } = req.body;
    if (!name || !sku || !min_price)
      return res.status(400).json({ error: 'name, sku, min_price are required' });

    const storeId = req.user.role === 'super_admin'
      ? (req.body.store_id || null)  // super_admin can set global (null) or specific
      : req.user.store_id;

    const { rows } = await db.query(`
      INSERT INTO products
        (name, brand, brand_id, sub_type_id, top_type, category,
         size, sku, stock, min_price, color, photo_url, store_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id
    `, [name, brand||'Other', brand_id||null, sub_type_id||null,
        top_type||'shoes', category||'Lifestyle', size||'', sku,
        stock||0, min_price, color||'', photo_url||null, storeId]);

    await log(req.user.id, req.user.name, req.user.role, 'product_added',
      `${name} Sz${size}`, `SKU: ${sku}, Stock: ${stock}, Min: ${min_price}`, 'inventory', req.ip);

    res.status(201).json({ id: rows[0].id, message: 'Product created' });
  } catch (err) {
    console.error('[products] POST /:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'SKU already exists' });
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// ── PUT /api/products/:id ──────────────────────────────────────────────────────
router.put('/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, brand, brand_id, sub_type_id, top_type, category,
            size, sku, stock, min_price, color, photo_url } = req.body;

    const { rows: [old] } = await db.query('SELECT * FROM products WHERE id = $1', [id]);
    if (!old) return res.status(404).json({ error: 'Product not found' });

    await db.query(`
      UPDATE products SET name=$1,brand=$2,brand_id=$3,sub_type_id=$4,top_type=$5,
        category=$6,size=$7,sku=$8,stock=$9,min_price=$10,color=$11,photo_url=$12
      WHERE id=$13
    `, [name??old.name, brand??old.brand, brand_id!==undefined?brand_id:old.brand_id,
        sub_type_id!==undefined?sub_type_id:old.sub_type_id,
        top_type??old.top_type, category??old.category, size??old.size, sku??old.sku,
        stock!==undefined?stock:old.stock, min_price??old.min_price,
        color!==undefined?color:old.color, photo_url!==undefined?photo_url:old.photo_url, id]);

    const changes = [];
    if (stock !== undefined && stock !== old.stock) changes.push(`Stock: ${old.stock}→${stock}`);
    if (min_price !== undefined && min_price !== old.min_price) changes.push(`Price: ${old.min_price}→${min_price}`);

    await log(req.user.id, req.user.name, req.user.role, 'product_edited',
      `${old.name} Sz${old.size}`, changes.join(', ')||'Details updated', 'inventory', req.ip);

    res.json({ message: 'Product updated' });
  } catch (err) {
    console.error('[products] PUT /:id:', err.message);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// ── DELETE /api/products/:id — soft delete ─────────────────────────────────────
router.delete('/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: [p] } = await db.query('SELECT name, size FROM products WHERE id = $1', [id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });

    await db.query('UPDATE products SET is_active = FALSE WHERE id = $1', [id]);
    await log(req.user.id, req.user.name, req.user.role, 'product_deleted',
      `${p.name} Sz${p.size}`, 'Removed from inventory', 'inventory', req.ip);

    res.json({ message: 'Product removed' });
  } catch (err) {
    console.error('[products] DELETE /:id:', err.message);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ── POST /api/products/bulk-import ────────────────────────────────────────────
router.post('/bulk-import', requireAuth, ADMIN, async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || !products.length)
      return res.status(400).json({ error: 'products array required' });

    const storeId = req.user.role === 'super_admin' ? (req.body.store_id || null) : req.user.store_id;
    let imported = 0;

    for (const p of products) {
      if (!p.name || !p.sku || !p.min_price) continue;
      await db.query(`
        INSERT INTO products (name, brand, brand_id, sub_type_id, top_type, category,
                              size, sku, stock, min_price, color, store_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (sku) DO UPDATE SET
          stock = EXCLUDED.stock, min_price = EXCLUDED.min_price
      `, [p.name, p.brand||'Other', p.brand_id||null, p.sub_type_id||null,
          p.top_type||'shoes', p.category||'Lifestyle', p.size||'', p.sku,
          p.stock||0, p.min_price, p.color||'', storeId]);
      imported++;
    }

    await log(req.user.id, req.user.name, req.user.role, 'csv_import',
      `${imported} products`, 'Bulk import', 'inventory', req.ip);

    res.json({ message: `${imported} products imported` });
  } catch (err) {
    console.error('[products] bulk-import:', err.message);
    res.status(500).json({ error: 'Bulk import failed' });
  }
});

// ── POST /api/products/preview-variants ───────────────────────────────────────
// Preview variants without database lookup (for UI preview before creation)
router.post('/preview-variants', requireAuth, ADMIN, async (req, res) => {
  try {
    const product = req.body;

    // Validate input
    const validation = validateProductInput(product);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors
      });
    }

    // Generate preview variants (without DB uniqueness check)
    const variants = previewVariants(product);

    res.json({
      count: variants.length,
      variants: variants,
      warnings: validation.warnings
    });
  } catch (err) {
    console.error('[products] preview-variants:', err.message);
    res.status(500).json({ error: 'Failed to preview variants' });
  }
});

// ── POST /api/products/bulk-create ────────────────────────────────────────────
// Create multiple product variants (color × size combinations) with auto-generated SKUs
router.post('/bulk-create', requireAuth, ADMIN, async (req, res) => {
  try {
    const product = req.body;

    // Validate input
    const validation = validateProductInput(product);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors
      });
    }

    // Look up brand_id and sub_type_id from database
    let brandId = product.brand_id || null;
    let subTypeId = product.sub_type_id || null;

    // If brand name is provided but not brand_id, look it up
    if (!brandId && product.brand) {
      const { rows: [brandRow] } = await db.query(
        'SELECT id FROM brands WHERE name = $1 AND top_type = $2 LIMIT 1',
        [product.brand, product.topType || product.top_type || 'shoes']
      );
      if (brandRow) brandId = brandRow.id;
    }

    // If subType name is provided but not sub_type_id, look it up
    if (!subTypeId && product.subType) {
      const { rows: [subTypeRow] } = await db.query(
        'SELECT id FROM sub_types WHERE name = $1 AND brand_id = $2 LIMIT 1',
        [product.subType, brandId]
      );
      if (subTypeRow) subTypeId = subTypeRow.id;
    }

    // Determine store_id
    const storeId = req.user.role === 'super_admin'
      ? (product.store_id || null)
      : req.user.store_id;

    // Generate all variants with unique SKUs
    const variants = await generateVariants(db, {
      name: product.name,
      brand: product.brand,
      brand_id: brandId,
      subType: product.subType,
      sub_type_id: subTypeId,
      colors: product.colors || [],
      sizes: product.sizes || [],
      minPrice: product.min_price || product.minPrice,
      stock: product.stock || 0,
      category: product.category,
      topType: product.topType || product.top_type || 'shoes',
      distributeStock: product.distributeStock || false,
    });

    if (!variants.length) {
      return res.status(400).json({ error: 'No variants generated' });
    }

    // Insert all variants into database
    const insertedIds = [];
    const errors = [];

    for (const variant of variants) {
      try {
        const { rows } = await db.query(`
          INSERT INTO products
            (name, brand, brand_id, sub_type_id, top_type, category,
             size, sku, stock, min_price, color, store_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (sku) DO UPDATE SET
            stock = EXCLUDED.stock,
            min_price = EXCLUDED.min_price,
            brand_id = EXCLUDED.brand_id,
            sub_type_id = EXCLUDED.sub_type_id
          RETURNING id
        `, [
          variant.name,
          variant.brand,
          variant.brand_id || brandId,
          variant.sub_type_id || subTypeId,
          variant.topType,
          variant.category,
          variant.size,
          variant.sku,
          variant.stock,
          variant.minPrice,
          variant.color,
          storeId
        ]);

        insertedIds.push(rows[0].id);
      } catch (err) {
        if (err.code === '23505') {
          errors.push(`SKU ${variant.sku} already exists`);
        } else {
          errors.push(`Error creating ${variant.color} ${variant.size}: ${err.message}`);
        }
      }
    }

    // Log the bulk creation
    await log(req.user.id, req.user.name, req.user.role, 'bulk_product_created',
      `${product.name}`,
      `Created ${insertedIds.length} variants (${variants.length} requested)`,
      'inventory', req.ip);

    res.json({
      message: `Created ${insertedIds.length} of ${variants.length} variants`,
      created: insertedIds.length,
      total: variants.length,
      errors: errors.length > 0 ? errors : undefined,
      warnings: validation.warnings,
      ids: insertedIds
    });
  } catch (err) {
    console.error('[products] bulk-create:', err.message);
    res.status(500).json({ error: 'Bulk creation failed' });
  }
});

module.exports = router;
