const express = require('express');
const db      = require('../db/connection');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// GET /api/logs
// activity_logs has no store_id column, so we scope by looking at which
// users belong to this store. Admin sees logs from their store's users only.
// super_admin sees all logs.
router.get('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const { category, role, search, from, to, page = 1, limit = 50 } = req.query;

    const vals = [];
    let   idx  = 1;
    const push = v => { vals.push(v); return `$${idx++}`; };

    let where = '1=1';

    // Store scoping — when any user has an active store, scope logs to that store's users.
    // super_admin with NO store (global mode) → sees all logs.
    // super_admin WITH a store selected → sees logs from that store's users only.
    // admin → always scoped to their store's users.
    if (req.user.active_store_id) {
      where += ` AND al.user_id IN (
        SELECT id FROM users WHERE store_id = ${push(req.user.active_store_id)}
        UNION SELECT ${push(req.user.id)}
      )`;
    }

    if (category && category !== 'All') { where += ` AND al.category = ${push(category)}`; }
    if (role     && role     !== 'All') { where += ` AND al.user_role = ${push(role)}`; }
    if (from)                           { where += ` AND DATE(al.logged_at) >= ${push(from)}`; }
    if (to)                             { where += ` AND DATE(al.logged_at) <= ${push(to)}`; }
    if (search) {
      const q = `%${search}%`;
      where += ` AND (al.user_name ILIKE ${push(q)} OR al.action ILIKE ${push(q)} OR al.target ILIKE ${push(q)} OR al.detail ILIKE ${push(q)})`;
    }

    const { rows: [{ total }] } = await db.query(
      `SELECT COUNT(*) AS total FROM activity_logs al WHERE ${where}`, vals
    );

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows: logs } = await db.query(
      `SELECT al.* FROM activity_logs al
       WHERE ${where}
       ORDER BY al.logged_at DESC
       LIMIT ${push(parseInt(limit))} OFFSET ${push(offset)}`,
      vals
    );

    res.json({ logs, total: parseInt(total), page: parseInt(page) });
  } catch (err) {
    console.error('[logs] GET:', err.message);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// DELETE /api/logs — Super Admin only
router.delete('/', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM activity_logs');
    res.json({ message: 'All logs cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

module.exports = router;