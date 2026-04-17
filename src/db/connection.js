/**
 * db/connection.js — PostgreSQL with dual-style query results
 *
 * Supports BOTH access patterns used across routes:
 *   Pattern A (mysql2 style):  const [[row]] = await db.query(sql, params)
 *   Pattern B (pg style):      const { rows } = await db.query(sql, params)
 *   Pattern C (pg style):      const { rows: [row] } = await db.query(sql, params)
 *
 * EGRESS OPTIMIZATION:
 *   - Uses SUPABASE_POOLER_URL (port 6543, pgBouncer) when available.
 *     This routes through Supabase's connection pooler which dramatically
 *     reduces egress vs direct connections (port 5432).
 *   - Falls back to DATABASE_URL if pooler URL not set.
 *   - Auto-detects pooler URL from DATABASE_URL if it contains port 6543
 *   - Set search_path once per connection, not per query.
 */

const { Pool } = require('pg');

// ── Load environment variables ──────────────────────────────────────────────────
// Ensure dotenv is loaded (works both locally and on Render)
try {
  require('dotenv').config();
} catch (err) {
  // dotenv might not be installed in production, that's fine
  if (process.env.NODE_ENV !== 'production') {
    console.warn('⚠️  dotenv not found, using system environment variables only');
  }
}

// ── Smart connection string selection ──────────────────────────────────────────
// Auto-detect pooler URL if DATABASE_URL uses the pgBouncer port (6543)
// This handles cases where SUPABASE_POOLER_URL isn't explicitly set in Render
let connectionString = process.env.SUPABASE_POOLER_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ No database URL found! Set SUPABASE_POOLER_URL or DATABASE_URL');
  process.exit(1);
}

// Auto-detect: if using DATABASE_URL but it has pooler port (6543), treat as pooler
const isUsingPoolerPort = connectionString.includes(':6543/');
const isExplicitPooler = !!process.env.SUPABASE_POOLER_URL;

if (isUsingPoolerPort && !isExplicitPooler) {
  console.log('🔀 Auto-detected Supabase pooler URL from DATABASE_URL (port 6543)');
  // Set it so the pooler-specific config below activates
  process.env.SUPABASE_POOLER_URL = connectionString;
} else if (isExplicitPooler) {
  console.log('🔀 Using Supabase pgBouncer pooler (egress-optimized)');
} else {
  console.warn('⚠️  SUPABASE_POOLER_URL not set — using direct connection. Set it to reduce egress.');
  console.warn('   Get your pooler URL from: Supabase Dashboard → Settings → Database → Connection Pooling');
}

// ── Create connection pool ──────────────────────────────────────────────────────
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,                    // max simultaneous connections
  min: 1,                     // keep 1 alive to avoid cold reconnects
  idleTimeoutMillis: 30000,   // release idle connections after 30s
  connectionTimeoutMillis: 10000,
  // pgBouncer in transaction mode doesn't support prepared statements
  ...(process.env.SUPABASE_POOLER_URL ? { statement_timeout: 30000 } : {}),
});

// ── Placeholder converter: MySQL ? → PostgreSQL $1 $2 ────────────────────────
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ── Dual-style result wrapper ─────────────────────────────────────────────────
// Returns array [rows, fields] that ALSO has .rows property
// so both [[row]] and { rows } destructuring work on the same value
function wrapQuery(queryFn) {
  return async function(sql, params = []) {
    const pgSql = convertPlaceholders(sql);
    const result = await queryFn(pgSql, params);
    const rows = result.rows || [];

    const ret = [rows, result.fields || []];
    ret.rows     = rows;
    ret.insertId = rows[0]?.id ?? null;
    return ret;
  };
}

pool.query = wrapQuery(pool.query.bind(pool));

// ── Set search_path once per new connection ───────────────────────────────────
// Supabase's authenticator role has no default search_path — this fixes
// "relation does not exist" errors without paying egress for SET on every query
pool.on('connect', client => {
  client.query("SET search_path TO public, extensions").catch(err => {
    console.warn('⚠️  search_path set failed:', err.message);
  });
});

// ── MySQL-compatible getConnection for transactions ───────────────────────────
pool.getConnection = async () => {
  const client = await pool.connect();
  await client.query("SET search_path TO public, extensions");
  client.query            = wrapQuery(client.query.bind(client));
  client.beginTransaction = () => client.query('BEGIN');
  client.commit           = () => client.query('COMMIT');
  client.rollback         = () => client.query('ROLLBACK');
  client.release          = client.release.bind(client);
  return client;
};

// ── Startup connection test ───────────────────────────────────────────────────
pool.connect()
  .then(c => {
    console.log('✅ PostgreSQL connected successfully');
    c.release();
  })
  .catch(err => {
    console.error('❌ PostgreSQL connection failed:', err.message);
    console.error('   Please check your database credentials and network access');
    process.exit(1);
  });

// ── Pool error handler — CRITICAL ────────────────────────────────────────────
// Without this, any connection error (pgBouncer drop, Supabase restart,
// idle timeout) emits an unhandled 'error' event and crashes the Node process.
// With this handler, the pool silently removes the broken client and reconnects.
pool.on('error', (err, client) => {
  console.error('⚠️  Unexpected DB pool error (client removed):', err.message);
  // Do NOT call process.exit() — let the pool recover automatically.
  // pg-pool will remove the dead client and create a fresh one on next request.
});

module.exports = pool;