const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../db/connection');
const { log }  = require('../services/logger');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password)
      return res.status(400).json({ error: 'Name and password required' });

    // Try to find user by name first, then by email
    const [[user]] = await db.query(
      `SELECT id, name, email, password_hash, role, avatar, status, commission_rate, last_login
       FROM users WHERE name ILIKE ? OR email = ?`,
      [identifier.trim(), identifier.trim().toLowerCase()]
    );

    if (!user)
      return res.status(401).json({ error: 'Invalid name or password' });

    if (user.status === 'inactive')
      return res.status(403).json({ error: 'Account deactivated. Contact your administrator.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Invalid name or password' });

    // Update last_login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    await log(user.id, user.name, user.role, 'login', 'System', 'Logged in', 'auth',
      req.ip);

    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me  — returns current user from token
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  await log(req.user.id, req.user.name, req.user.role, 'logout', 'System', 'Logged out', 'auth', req.ip);
  res.json({ message: 'Logged out' });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const [[user]] = await db.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    await log(req.user.id, req.user.name, req.user.role, 'password_changed', 'Account', 'Password updated', 'auth', req.ip);

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Password change failed' });
  }
});


// POST /api/auth/setup — first-run only. Creates the super admin account.
// Only works when the users table is completely empty.
router.post('/setup', async (req, res) => {
  try {
    const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM users');
    if (parseInt(count) > 0) {
      return res.status(403).json({ error: 'Setup already completed. Please log in.' });
    }

    const { name, email, password, store_name, store_location, store_phone } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const hash   = await bcrypt.hash(password, 12);
    const avatar = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

    const [rows] = await db.query(
      `INSERT INTO users (name, email, password_hash, role, avatar, status, commission_rate)
       VALUES (?, ?, ?, 'super_admin', ?, 'active', 10)`,
      [name, email.trim().toLowerCase(), hash, avatar]
    );

    // Save basic store settings
    const defaults = [
      ['store_name',          store_name     || 'Permic Men\'s Wear'],
      ['store_location',      store_location || 'Nairobi, Kenya'],
      ['store_phone',         store_phone    || ''],
      ['currency',            'KES'],
      ['timezone',            'Africa/Nairobi'],
      ['commission_rate',     '10'],
      ['low_stock_threshold', '5'],
      ['aging_days',          '60'],
      ['sms_alerts',          'true'],
      ['email_alerts',        'true'],
      ['mpesa_env',           'sandbox'],
      ['mpesa_shortcode',     '174379'],
      ['mpesa_account',       'test001'],
    ];
    for (const [key, val] of defaults) {
      await db.query(
        `INSERT INTO settings (key_name, key_value, updated_by) VALUES (?, ?, ?)
         ON CONFLICT (key_name) DO UPDATE SET key_value = EXCLUDED.key_value`,
        [key, val, rows[0].id]
      );
    }

    const token = jwt.sign(
      { id: rows[0].id, role: 'super_admin' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    console.log(`[SETUP] Super admin created: ${name} <${email}>`);

    res.status(201).json({
      message: 'Setup complete. Super admin account created.',
      token,
      user: { id: rows[0].id, name, email, role: 'super_admin', avatar, status: 'active', commission_rate: 10 },
    });
  } catch (err) {
    console.error('[SETUP] Error:', err.message);
    if (err.code === '23505')
      return res.status(409).json({ error: 'Email already in use' });
    res.status(500).json({ error: 'Setup failed' });
  }
});

// GET /api/auth/setup-status — tells frontend whether setup has been done
router.get('/setup-status', async (req, res) => {
  try {
    const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM users');
    res.json({ needs_setup: parseInt(count) === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Could not check setup status' });
  }
});

module.exports = router;
