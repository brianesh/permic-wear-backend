const express = require('express');
const db      = require('../db/connection');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// GET /api/logs
router.get('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const { category, role, search, from, to, page = 1, limit = 50 } = req.query;

    let sql    = 'SELECT * FROM activity_logs WHERE 1=1';
    const vals = [];

    if (category && category !== 'All') { sql += ' AND category = ?';        vals.push(category); }
    if (role     && role     !== 'All') { sql += ' AND user_role = ?';        vals.push(role); }
    if (from)                           { sql += ' AND DATE(logged_at) >= ?'; vals.push(from); }
    if (to)                             { sql += ' AND DATE(logged_at) <= ?'; vals.push(to); }
    if (search) {
      sql += ' AND (user_name LIKE ? OR action LIKE ? OR target LIKE ? OR detail LIKE ?)';
      const q = `%${search}%`;
      vals.push(q, q, q, q);
    }

    // Total count
    const [countRows] = await db.query(
      sql.replace('SELECT *', 'SELECT COUNT(*) AS total'), vals
    );
    const total = countRows[0].total;

    sql += ' ORDER BY logged_at DESC LIMIT ? OFFSET ?';
    vals.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const [rows] = await db.query(sql, vals);
    res.json({ logs: rows, total, page: parseInt(page) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// DELETE /api/logs  — Super Admin only
router.delete('/', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM activity_logs');
    res.json({ message: 'All logs cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

module.exports = router;
