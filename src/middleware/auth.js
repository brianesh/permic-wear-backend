const jwt = require('jsonwebtoken');
const db  = require('../db/connection');

// Verify JWT token on every protected route
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Fetch fresh user from DB (catches deactivated accounts mid-session)
    const { rows } = await db.query(
      'SELECT id, name, email, role, avatar, status, commission_rate FROM users WHERE id = $1',
      [payload.id]
    );
    const user = rows[0];
    if (!user || user.status === 'inactive') {
      return res.status(401).json({ error: 'Account inactive or not found' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Role-based access guard factory
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
