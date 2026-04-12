/**
 * users.js — User management with multi-store support
 *
 * - super_admin sees ALL users across ALL stores
 * - admin sees only users in their own store
 * - When creating/editing, super_admin assigns store_id
 * - Admins and cashiers are always scoped to their store
 */

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
    let sql;
    let vals = [];

    if (req.user.role === 'super_admin') {
      // Super admin sees everyone with store name
      sql = `
        SELECT u.id, u.name, u.email, u.role, u.avatar, u.status,
               u.commission_rate, u.last_login, u.created_at, u.store_id,
               st.name AS store_name,
               (SELECT COUNT(*) FROM sales WHERE cashier_id = u.id) AS total_sales
        FROM users u
        LEFT JOIN stores st ON st.id = u.store_id
        ORDER BY st.name NULLS LAST, u.created_at ASC
      `;
    } else {
      // Admin sees only their store
      sql = `
        SELECT u.id, u.name, u.email, u.role, u.avatar, u.status,
               u.commission_rate, u.last_login, u.created_at, u.store_id,
               st.name AS store_name,
               (SELECT COUNT(*) FROM sales WHERE cashier_id = u.id AND store_id = $1) AS total_sales
        FROM users u
        LEFT JOIN stores st ON st.id = u.store_id
        WHERE u.store_id = $1 OR u.role = 'super_admin'
        ORDER BY u.created_at ASC
      `;
      vals = [req.user.active_store_id];
    }

    const { rows } = await db.query(sql, vals);
    res.json(rows);
  } catch (err) {
    console.error('[users] GET /:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /api/users
router.post('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const { name, email, password, role, commission_rate, store_id } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email, and password required' });

    if (role === 'super_admin' && req.user.role !== 'super_admin')
      return res.status(403).json({ error: 'Only Super Admin can create Super Admin accounts' });

    // Admins can only create users for their own store
    let assignedStoreId = store_id || null;
    if (req.user.role === 'admin') {
      assignedStoreId = req.user.active_store_id;
    }
    // super_admin must assign a store to non-super users
    if (role !== 'super_admin' && !assignedStoreId) {
      return res.status(400).json({ error: 'A store must be assigned for this user' });
    }

    const hash   = await bcrypt.hash(password, 12);
    const avatar = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const rate   = commission_rate ?? 10;

    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash, role, avatar, commission_rate, store_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [name, email.toLowerCase(), hash, role || 'cashier', avatar, rate, assignedStoreId]
    );

    await log(req.user.id, req.user.name, req.user.role, 'user_created',
      name, `Role: ${role}, Store: ${assignedStoreId}`, 'users', req.ip);

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
    const { id } = req.params;
    const { name, email, role, status, commission_rate, password, store_id } = req.body;

    const { rows: [target] } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin' && req.user.role !== 'super_admin')
      return res.status(403).json({ error: 'Cannot edit Super Admin account' });

    // Admins can only edit users in their own store
    if (req.user.role === 'admin' && target.store_id !== req.user.active_store_id)
      return res.status(403).json({ error: 'Cannot edit users from another store' });

    const fields = [];
    const values = [];
    let idx = 1;

    const push = (col, val) => { fields.push(`${col} = $${idx++}`); values.push(val); };

    if (name  !== undefined)            push('name',            name);
    if (email !== undefined)            push('email',           email.toLowerCase());
    if (role  !== undefined)            push('role',            role);
    if (status !== undefined)           push('status',          status);
    if (commission_rate !== undefined)  push('commission_rate', commission_rate);
    if (store_id !== undefined && req.user.role === 'super_admin')
                                        push('store_id',        store_id);
    if (password) {
      push('password_hash', await bcrypt.hash(password, 12));
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(id);
    await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    await log(req.user.id, req.user.name, req.user.role, 'user_edited',
      name || `User #${id}`, `Fields: ${fields.join(', ')}`, 'users', req.ip);

    res.json({ message: 'User updated' });
  } catch (err) {
    console.error('[users] PUT /:id:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', requireAuth, ADMIN, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: [target] } = await db.query('SELECT name, role, store_id FROM users WHERE id = $1', [id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin')
      return res.status(403).json({ error: 'Cannot delete Super Admin account' });
    if (parseInt(id) === req.user.id)
      return res.status(403).json({ error: 'Cannot delete your own account' });
    if (req.user.role === 'admin') {
      if (target.role !== 'cashier')
        return res.status(403).json({ error: 'Admins can only delete cashier accounts' });
      if (target.store_id !== req.user.active_store_id)
        return res.status(403).json({ error: 'Cannot delete users from another store' });
    }

    await db.query('DELETE FROM users WHERE id = $1', [id]);
    await log(req.user.id, req.user.name, req.user.role, 'user_deleted',
      target.name, 'User removed', 'users', req.ip);

    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('[users] DELETE /:id:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
