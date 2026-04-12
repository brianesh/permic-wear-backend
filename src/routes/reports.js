/**
 * reports.js — Store-scoped analytics
 *
 * FIXES:
 *  1. buildDateFilter used MySQL ? placeholders → converted to pg $N
 *  2. top-products LIMIT used ? → converted to $N
 *  3. cashiers route used ? placeholders → converted to $N
 *  4. All routes now store-scoped:
 *       super_admin sees ALL stores (no filter)
 *       admin sees only their store (req.user.active_store_id)
 *       cashier sees only their own sales
 */

const express = require('express');
const db      = require('../db/connection');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// ── Helper: build date + store filter clause ─────────────────────
// Returns { clauses: string[], vals: any[], nextIdx: number }
function buildFilters(user, from, to, saleAlias = 's', startIdx = 1) {
  const clauses = [];
  const vals    = [];
  let   idx     = startIdx;
  // prefix: 's.' or '' (no alias) - never '.column'
  const p = saleAlias ? saleAlias + '.' : '';

  // Store scoping
  if (user.role === 'admin') {
    clauses.push(`${p}store_id = $${idx++}`);
    vals.push(user.active_store_id);
  }

  if (from) { clauses.push(`DATE(${p}sale_date) >= $${idx++}`); vals.push(from); }
  if (to)   { clauses.push(`DATE(${p}sale_date) <= $${idx++}`); vals.push(to);   }

  return { clauses, vals, nextIdx: idx };
}

// ── GET /api/reports/summary ─────────────────────────────────────
router.get('/summary', requireAuth, ADMIN, async (req, res) => {
  try {
    const { from, to } = req.query;
    const { clauses, vals, nextIdx } = buildFilters(req.user, from, to, 's', 1);
    const where = clauses.length ? 'AND ' + clauses.join(' AND ') : '';

    const { rows: [totals] } = await db.query(`
      SELECT
        COALESCE(SUM(s.selling_total), 0)   AS total_revenue,
        COALESCE(SUM(s.extra_profit), 0)    AS total_profit,
        COALESCE(SUM(s.commission), 0)      AS total_commission,
        COUNT(*)                            AS total_transactions,
        COALESCE(SUM(si.total_qty), 0)      AS total_units
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, SUM(qty) AS total_qty FROM sale_items GROUP BY sale_id
      ) si ON si.sale_id = s.id
      WHERE s.status = 'completed' ${where}
    `, vals);

    // Today / yesterday — store-scoped too
    const storeClause = req.user.role === 'admin'
      ? `AND store_id = ${vals[0] || 'NULL'}`
      : '';
    // Use parameterised for safety
    let todayVals = [], yestVals = [];
    let todayStore = '', yestStore = '';
    if (req.user.role === 'admin') {
      todayStore = 'AND store_id = $1';
      todayVals  = [req.user.active_store_id];
      yestStore  = 'AND store_id = $1';
      yestVals   = [req.user.active_store_id];
    }

    const { rows: [yesterday] } = await db.query(
      `SELECT COALESCE(SUM(selling_total),0) AS revenue
       FROM sales WHERE status='completed'
         AND DATE(sale_date) = CURRENT_DATE - INTERVAL '1 day' ${yestStore}`,
      yestVals
    );
    const { rows: [today] } = await db.query(
      `SELECT COALESCE(SUM(selling_total),0) AS revenue
       FROM sales WHERE status='completed'
         AND DATE(sale_date) = CURRENT_DATE ${todayStore}`,
      todayVals
    );

    // Low stock — scoped to store
    let lsVals = [], lsClause = '';
    if (req.user.role === 'admin') {
      lsClause = 'AND store_id = $1';
      lsVals   = [req.user.active_store_id];
    }
    const { rows: [lowStockRow] } = await db.query(
      `SELECT COUNT(*) AS count FROM products WHERE is_active = true AND stock <= 5 ${lsClause}`,
      lsVals
    ).catch(() => ({ rows: [{ count: 0 }] }));

    const prevRev   = parseFloat(yesterday.revenue) || 1;
    const todayRev  = parseFloat(today.revenue);
    const pctChange = ((todayRev - prevRev) / prevRev * 100).toFixed(1);

    res.json({
      ...totals,
      today_revenue:     todayRev,
      yesterday_revenue: parseFloat(yesterday.revenue),
      pct_change:        parseFloat(pctChange),
      low_stock_count:   parseInt(lowStockRow.count),
    });
  } catch (err) {
    console.error('[reports] summary:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// ── GET /api/reports/daily ───────────────────────────────────────
router.get('/daily', requireAuth, ADMIN, async (req, res) => {
  try {
    const { from, to } = req.query;
    const { clauses, vals } = buildFilters(req.user, from, to, 's', 1);
    const where = clauses.length ? 'AND ' + clauses.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        DATE(s.sale_date)             AS date,
        SUM(s.selling_total)          AS revenue,
        SUM(s.extra_profit)           AS profit,
        SUM(s.commission)             AS commission,
        COUNT(*)                      AS transactions,
        COALESCE(SUM(si.qty_total),0) AS units,
        SUM(CASE WHEN s.payment_method='Cash'  THEN s.selling_total ELSE 0 END) AS cash_total,
        SUM(CASE WHEN s.payment_method='Tuma'  THEN s.selling_total ELSE 0 END) AS tuma_total,
        SUM(CASE WHEN s.payment_method='Split' THEN s.selling_total ELSE 0 END) AS split_total
      FROM sales s
      LEFT JOIN (SELECT sale_id, SUM(qty) qty_total FROM sale_items GROUP BY sale_id) si
        ON si.sale_id = s.id
      WHERE s.status = 'completed' ${where}
      GROUP BY DATE(s.sale_date)
      ORDER BY DATE(s.sale_date) ASC
    `, vals);

    res.json(rows);
  } catch (err) {
    console.error('[reports] daily:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch daily data' });
  }
});

// ── GET /api/reports/top-products ───────────────────────────────
router.get('/top-products', requireAuth, ADMIN, async (req, res) => {
  try {
    const { from, to, limit = 10 } = req.query;
    const { clauses, vals, nextIdx } = buildFilters(req.user, from, to, 's', 1);
    const where = clauses.length ? 'AND ' + clauses.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        si.product_id,
        si.product_name                                AS name,
        si.sku,
        SUM(si.qty)                                    AS units_sold,
        SUM(si.selling_price * si.qty)                 AS revenue,
        SUM(si.extra_profit)                           AS profit,
        SUM(si.commission)                             AS commission,
        ROUND(
          SUM(si.extra_profit) / NULLIF(SUM(si.selling_price * si.qty), 0) * 100, 1
        )                                              AS margin_pct
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.status = 'completed' ${where}
      GROUP BY si.product_id, si.product_name, si.sku
      ORDER BY revenue DESC
      LIMIT $${nextIdx}
    `, [...vals, parseInt(limit)]);

    res.json(rows);
  } catch (err) {
    console.error('[reports] top-products:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch top products' });
  }
});

// ── GET /api/reports/cashiers ────────────────────────────────────
router.get('/cashiers', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const { role, id: userId, active_store_id } = req.user;
    const isSuperAdmin = role === 'super_admin';
    const isAdmin      = role === 'admin';
    const isCashier    = role === 'cashier';

    if (!isSuperAdmin && !isAdmin && !isCashier)
      return res.status(403).json({ error: 'Forbidden' });

    const vals = [];
    let idx = 1;

    // Build JOIN conditions for sales
    const joinConds = [`s.cashier_id = u.id`, `s.status = 'completed'`];
    if (from) { joinConds.push(`DATE(s.sale_date) >= $${idx++}`); vals.push(from); }
    if (to)   { joinConds.push(`DATE(s.sale_date) <= $${idx++}`); vals.push(to);   }
    // Store scope on sales JOIN
    if (isAdmin) {
      joinConds.push(`s.store_id = $${idx++}`);
      vals.push(active_store_id);
    }

    // User WHERE
    const userConds = [`u.status = 'active'`];
    if (isAdmin)   userConds.push(`u.role IN ('admin','cashier')`);
    if (isCashier) { userConds.push(`u.id = $${idx++}`); vals.push(userId); }
    // Admin scope: only show users in their store
    if (isAdmin) {
      userConds.push(`u.store_id = $${idx++}`);
      vals.push(active_store_id);
    }

    const { rows } = await db.query(`
      SELECT
        u.id, u.name, u.avatar, u.role, u.commission_rate,
        COUNT(s.id)                        AS transactions,
        COALESCE(SUM(s.selling_total), 0)  AS revenue,
        COALESCE(SUM(s.commission), 0)     AS commission,
        COALESCE(AVG(s.selling_total), 0)  AS avg_sale
      FROM users u
      LEFT JOIN sales s ON ${joinConds.join(' AND ')}
      WHERE ${userConds.join(' AND ')}
      GROUP BY u.id, u.name, u.avatar, u.role, u.commission_rate
      ORDER BY commission DESC, revenue DESC
    `, vals);

    res.json(rows);
  } catch (err) {
    console.error('[reports] cashiers:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch cashier data' });
  }
});

// ── GET /api/reports/payment-mix ─────────────────────────────────
router.get('/payment-mix', requireAuth, ADMIN, async (req, res) => {
  try {
    const { from, to } = req.query;
    const { clauses, vals } = buildFilters(req.user, from, to, '', 1);
    const where = clauses.length ? 'AND ' + clauses.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        payment_method     AS method,
        COUNT(*)           AS transactions,
        SUM(selling_total) AS total
      FROM sales
      WHERE status = 'completed' ${where}
      GROUP BY payment_method
    `, vals);

    const grand = rows.reduce((s, r) => s + parseFloat(r.total), 0) || 1;
    res.json(rows.map(r => ({
      ...r,
      pct: Math.round(parseFloat(r.total) / grand * 100),
    })));
  } catch (err) {
    console.error('[reports] payment-mix:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch payment mix' });
  }
});

module.exports = router;
