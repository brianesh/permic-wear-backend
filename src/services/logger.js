const db = require('../db/connection');

async function log(userId, userName, userRole, action, target, detail, category = 'general', ip = null) {
  try {
    await db.query(
      `INSERT INTO activity_logs (user_id, user_name, user_role, action, target, detail, category, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, userName, userRole, action, target || '', detail || '', category, ip]
    );
  } catch (err) {
    // Never let logging crash the main request
    console.error('Log write failed:', err.message);
  }
}

module.exports = { log };
