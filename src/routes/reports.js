const express = require('express');
const db      = require('../db/connection');
const { requireAuth, requireRole } = require('../middleware/auth');

const router  = express.Router();
const ADMIN   = requireRole('super_admin', 'admin');

// GET /api/reports/summary?from=&to=
router.get('/summary', requireAuth, ADMIN, async (req, res) => {
  try {
    const { from, to } = req.query;
    const { sql: dateSql, vals: dateVals } = buildDateFilter(from, to, 's.');

    const [[totals]] = await db.query(`
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
      WHERE s.status = 'completed' ${dateSql}
    `, dateVals);

    const [[yesterday]] = await db.query(`
      SELECT COALESCE(SUM(selling_total), 0) AS revenue
      FROM sales WHERE status='completed' AND DATE(sale_date) = CURRENT_DATE - INTERVAL '1 day'
    `);

    const [[today]] = await db.query(`
      SELECT COALESCE(SUM(selling_total), 0) AS revenue
      FROM sales WHERE status='completed' AND DATE(sale_date) = CURRENT_DATE
    `);

    const [[lowStockRow]] = await db.query(
      `SELECT COUNT(*) AS count FROM products WHERE is_active = true AND stock <= 5`
    ).catch(() => [[{ count: 0 }]]);

    const prevRev   = parseFloat(yesterday.revenue) || 1;
    const todayRev  = parseFloat(today.revenue);
    const pctChange = ((todayRev - prevRev) / prevRev * 100).toFixed(1);

    res.json({
      ...totals,
      today_revenue:     todayRev,
      yesterday_revenue: parseFloat(yesterday.revenue),
      pct_change:        parseFloat(pctChange),
      low_stock_count:   lowStockRow.count,
    });
  } catch (err) {
    console.error('[reports] summary:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// GET /api/reports/daily?from=&to=
router.get('/daily', requireAuth, ADMIN, async (req, res) => {
  try {
    const { from, to } = req.query;
    const { sql: dateSql, vals: dateVals } = buildDateFilter(from, to, 's.');

    const [rows] = await db.query(`
      SELECT
        DATE(s.sale_date)             AS date,
        SUM(s.selling_total)          AS revenue,
        SUM(s.extra_profit)           AS profit,
        SUM(s.commission)             AS commission,
        COUNT(*)                      AS transactions,
        COALESCE(SUM(si.qty_total),0) AS units,
        SUM(CASE WHEN s.payment_method='Cash'   THEN s.selling_total ELSE 0 END) AS cash_total,
        SUM(CASE WHEN s.payment_method='M-Pesa' THEN s.selling_total ELSE 0 END) AS mpesa_total,
        SUM(CASE WHEN s.payment_method='Split'  THEN s.selling_total ELSE 0 END) AS split_total
      FROM sales s
      LEFT JOIN (SELECT sale_id, SUM(qty) qty_total FROM sale_items GROUP BY sale_id) si
        ON si.sale_id = s.id
      WHERE s.status = 'completed' ${dateSql}
      GROUP BY DATE(s.sale_date)
      ORDER BY DATE(s.sale_date) ASC
    `, dateVals);

    res.json(rows);
  } catch (err) {
    console.error('[reports] daily:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch daily data' });
  }
});

// GET /api/reports/top-products?from=&to=
router.get('/top-products', requireAuth, ADMIN, async (req, res) => {
  try {
    const { from, to, limit = 10 } = req.query;
    const { sql: dateSql, vals: dateVals } = buildDateFilter(from, to, 's.');

    const [rows] = await db.query(`
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
      WHERE s.status = 'completed' ${dateSql}
      GROUP BY si.product_id, si.product_name, si.sku
      ORDER BY revenue DESC
      LIMIT ?
    `, [...dateVals, parseInt(limit)]);

    res.json(rows);
  } catch (err) {
    console.error('[reports] top-products:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch top products' });
  }
});

// GET /api/reports/cashiers?from=&to=
// Returns one row per user with their individual commission totals.
// super_admin → all staff
// admin       → admins + cashiers only (not super_admin)
// cashier     → only themselves
router.get('/cashiers', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAdmin      = req.user.role === 'admin';
    const isCashier    = req.user.role === 'cashier';

    if (!isSuperAdmin && !isAdmin && !isCashier)
      return res.status(403).json({ error: 'Forbidden' });

    // Build the date filter for the JOIN condition (not WHERE on users)
    const joinConditions = ["s.cashier_id = u.id", "s.status = 'completed'"];
    const vals = [];
    if (from) { joinConditions.push('DATE(s.sale_date) >= ?'); vals.push(from); }
    if (to)   { joinConditions.push('DATE(s.sale_date) <= ?'); vals.push(to);   }

    // Role filter on users
    let userWhere = "u.status = 'active'";
    if (isAdmin)   userWhere += " AND u.role IN ('admin','cashier')";
    if (isCashier) { userWhere += ' AND u.id = ?'; vals.push(req.user.id); }

    const sql = `
      SELECT
        u.id,
        u.name,
        u.avatar,
        u.role,
        u.commission_rate,
        COUNT(s.id)                        AS transactions,
        COALESCE(SUM(s.selling_total), 0)  AS revenue,
        COALESCE(SUM(s.commission), 0)     AS commission,
        COALESCE(AVG(s.selling_total), 0)  AS avg_sale
      FROM users u
      LEFT JOIN sales s ON ${joinConditions.join(' AND ')}
      WHERE ${userWhere}
      GROUP BY u.id, u.name, u.avatar, u.role, u.commission_rate
      ORDER BY commission DESC, revenue DESC
    `;

    const [rows] = await db.query(sql, vals);
    res.json(rows);
  } catch (err) {
    console.error('[reports] cashiers:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch cashier data' });
  }
});

// GET /api/reports/payment-mix?from=&to=
router.get('/payment-mix', requireAuth, ADMIN, async (req, res) => {
  try {
    const { from, to } = req.query;
    const { sql: dateSql, vals: dateVals } = buildDateFilter(from, to);

    const [rows] = await db.query(`
      SELECT
        payment_method     AS method,
        COUNT(*)           AS transactions,
        SUM(selling_total) AS total
      FROM sales
      WHERE status = 'completed' ${dateSql}
      GROUP BY payment_method
    `, dateVals);

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

// ── Helper ──────────────────────────────────────────────────────
// prefix is applied to sale_date column, e.g. 's.' → 's.sale_date'
function buildDateFilter(from, to, prefix = '') {
  const parts = [];
  const vals  = [];
  if (from) { parts.push(`AND DATE(${prefix}sale_date) >= ?`); vals.push(from); }
  if (to)   { parts.push(`AND DATE(${prefix}sale_date) <= ?`); vals.push(to);   }
  return { sql: parts.join(' '), vals };
}

module.exports = router;
