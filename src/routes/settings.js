const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router     = express.Router();
const SUPERADMIN = requireRole('super_admin');
const ADMIN      = requireRole('super_admin', 'admin');

const SUPERADMIN_ONLY_KEYS = [
  'mpesa_consumer_key', 'mpesa_consumer_secret',
  'mpesa_sandbox_key', 'mpesa_sandbox_secret',
  'mpesa_env',
];

router.get('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT key_name, key_value FROM settings');
    const obj = {};
    rows.forEach(r => { obj[r.key_name] = r.key_value ?? ''; });
    res.json(obj);
  } catch (err) {
    console.error('[settings] GET:', err.message);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.put('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const updates = req.body;
    const keys    = Object.keys(updates);
    if (!keys.length) return res.status(400).json({ error: 'No settings provided' });

    if (req.user.role !== 'super_admin') {
      const blocked = keys.filter(k => SUPERADMIN_ONLY_KEYS.includes(k));
      if (blocked.length)
        return res.status(403).json({ error: `Only Super Admin can change: ${blocked.join(', ')}` });
    }

    for (const key of keys) {
      const val = updates[key];
      const SECRET_KEYS = ['mpesa_consumer_key','mpesa_consumer_secret','mpesa_sandbox_key','mpesa_sandbox_secret','at_api_key','gmail_app_password'];
      if (SECRET_KEYS.includes(key) && (val === '' || val === null || val === undefined)) continue;

      await db.query(
        `INSERT INTO settings (key_name, key_value, updated_by)
         VALUES (?, ?, ?)
         ON CONFLICT (key_name) DO UPDATE SET key_value = EXCLUDED.key_value, updated_by = EXCLUDED.updated_by`,
        [key, String(val), req.user.id]
      );
    }

    await log(req.user.id, req.user.name, req.user.role, 'settings_saved',
      keys.join(', '), `${keys.length} setting(s) updated`, 'settings', req.ip);

    res.json({ message: 'Settings saved' });
  } catch (err) {
    console.error('[settings] PUT:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
