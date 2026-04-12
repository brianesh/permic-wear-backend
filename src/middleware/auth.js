const jwt = require('jsonwebtoken');
const db  = require('../db/connection');

/**
 * requireAuth — verifies JWT, loads fresh user from DB including store_id.
 *
 * FIXES:
 *  - store_id was missing from the SELECT → req.user.store_id was always undefined.
 *  - Super admin can pass X-Active-Store-Id header to operate in a specific store.
 *    active_store_id is what all route-level store scoping should use.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.avatar, u.status,
              u.commission_rate, u.store_id,
              s.name     AS store_name,
              s.location AS store_location
       FROM users u
       LEFT JOIN stores s ON s.id = u.store_id
       WHERE u.id = $1`,
      [payload.id]
    );
    const user = rows[0];
    if (!user || user.status === 'inactive') {
      return res.status(401).json({ error: 'Account inactive or not found' });
    }

    // Super admin can operate in any store via X-Active-Store-Id header.
    // All routes use req.user.active_store_id for scoping — never raw store_id directly.
    if (user.role === 'super_admin') {
      const override = req.headers['x-active-store-id'];
      user.active_store_id = (override && !isNaN(parseInt(override)))
        ? parseInt(override)
        : user.store_id;           // fallback to their own store
    } else {
      user.active_store_id = user.store_id;
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
