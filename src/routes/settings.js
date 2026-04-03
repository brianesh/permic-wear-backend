const express = require('express');
const db      = require('../db/connection');
const { log } = require('../services/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router     = express.Router();
const SUPERADMIN = requireRole('super_admin');
const ADMIN      = requireRole('super_admin', 'admin');

// Keys that only super_admin can change
const SUPERADMIN_ONLY_KEYS = [
  'mpesa_consumer_key', 'mpesa_consumer_secret',
  'mpesa_sandbox_key', 'mpesa_sandbox_secret',
  'mpesa_env',
];

// GET /api/settings — returns all settings as a flat object
// Sensitive keys (passwords/secrets) returned as masked indicator
router.get('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT key_name, key_value FROM settings');
    const obj = {};
    const MASK_KEYS = ['mpesa_consumer_key','mpesa_consumer_secret','mpesa_sandbox_key','mpesa_sandbox_secret','at_api_key','gmail_app_password'];
    rows.forEach(r => {
      // Return actual value so frontend SecretField can detect "has value"
      obj[r.key_name] = r.key_value ?? '';
    });
    res.json(obj);
  } catch (err) {
    console.error('[settings] GET:', err.message);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/settings — body: { key_name: value, ... }
// Admin can save most settings; super_admin_only keys require super_admin role
router.put('/', requireAuth, ADMIN, async (req, res) => {
  try {
    const updates = req.body;
    const keys    = Object.keys(updates);
    if (!keys.length) return res.status(400).json({ error: 'No settings provided' });

    // Check if any restricted keys are being changed by a non-super_admin
    if (req.user.role !== 'super_admin') {
      const blocked = keys.filter(k => SUPERADMIN_ONLY_KEYS.includes(k));
      if (blocked.length) {
        return res.status(403).json({ error: `Only Super Admin can change: ${blocked.join(', ')}` });
      }
    }

    for (const key of keys) {
      const val = updates[key];
      // Skip empty strings for secret fields (means "don't overwrite")
      const SECRET_KEYS = ['mpesa_consumer_key','mpesa_consumer_secret','mpesa_sandbox_key','mpesa_sandbox_secret','at_api_key','gmail_app_password'];
      if (SECRET_KEYS.includes(key) && (val === '' || val === null || val === undefined)) continue;

      await db.query(
        `INSERT INTO settings (key_name, key_value, updated_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE key_value = VALUES(key_value), updated_by = VALUES(updated_by)`,
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
