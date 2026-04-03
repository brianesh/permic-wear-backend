const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ADMIN  = requireRole('super_admin', 'admin');

// GET /api/users
router.get('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const [users] = await db.query(
      `SELECT id, name, email, role, avatar, status, commission_rate, last_login, created_at,
              (SELECT COUNT(*) FROM sales WHERE cashier_id = users.id) AS total_sales
       FROM users ORDER BY created_at ASC`
    );
    res.json(users);
  } catch (err) {
    console.error('[users] GET /:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /api/users
router.post('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, email, password, role, commission_rate } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email, and password required' });

    if (role === 'super_admin' && req.user.role !== 'super_admin')
      return res.status(403).json({ error: 'Only Super Admin can create Super Admin accounts' });

    const hash    = await bcrypt.hash(password, 12);
    const avatar  = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const rate    = commission_rate ?? 10;

    const [rows] = await db.query(
      `INSERT INTO users (name, email, password_hash, role, avatar, commission_rate) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, email.toLowerCase(), hash, role || 'cashier', avatar, rate]
    );

    await log(req.user.id, req.user.name, req.user.role, 'user_created', name, `Role: ${role}`, 'users', req.ip);
    res.status(201).json({ id: rows[0].id, message: 'User created' });

  } catch (err) {
    console.error('[users] POST /:', err.message);
    if (err.code === '23505')
      return res.status(409).json({ error: 'Email already in use' });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id
router.put('/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { id }  = req.params;
    const { name, email, role, status, commission_rate, password } = req.body;

    const [[target]] = await db.query('SELECT role FROM users WHERE id = ?', [id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin' && req.user.role !== 'super_admin')
      return res.status(403).json({ error: 'Cannot edit Super Admin account' });

    const fields = [];
    const values = [];

    if (name)            { fields.push('name = ?');            values.push(name); }
    if (email)           { fields.push('email = ?');           values.push(email.toLowerCase()); }
    if (role)            { fields.push('role = ?');            values.push(role); }
    if (status)          { fields.push('status = ?');          values.push(status); }
    if (commission_rate !== undefined) { fields.push('commission_rate = ?'); values.push(commission_rate); }
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      fields.push('password_hash = ?');
      values.push(hash);
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(id);
    await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    await log(req.user.id, req.user.name, req.user.role, 'user_edited', name || `User #${id}`, `Fields: ${fields.join(', ')}`, 'users', req.ip);

    res.json({ message: 'User updated' });
  } catch (err) {
    console.error('[users] PUT /:id:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:id — super_admin can delete any non-superadmin; admin can delete cashiers
router.delete('/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { id } = req.params;
    const [[target]] = await db.query('SELECT name, role FROM users WHERE id = ?', [id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin')
      return res.status(403).json({ error: 'Cannot delete Super Admin account' });
    if (parseInt(id) === req.user.id)
      return res.status(403).json({ error: 'Cannot delete your own account' });
    // Admins can only delete cashiers
    if (req.user.role === 'admin' && target.role !== 'cashier')
      return res.status(403).json({ error: 'Admins can only delete cashier accounts' });

    await db.query('DELETE FROM users WHERE id = ?', [id]);
    await log(req.user.id, req.user.name, req.user.role, 'user_deleted', target.name, 'User removed', 'users', req.ip);
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('[users] DELETE /:id:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
