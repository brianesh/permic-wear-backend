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
 *   - Set search_path once per connection, not per query.
 */

const { Pool } = require('pg');

// ── Choose connection string ──────────────────────────────────────────────────
// SUPABASE_POOLER_URL = your Supabase pooler URL (port 6543, Transaction mode)
// Found in: Supabase Dashboard → Settings → Database → Connection Pooling
// Example: postgres://postgres.xxxx:password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
const connectionString = process.env.SUPABASE_POOLER_URL || process.env.DATABASE_URL;

if (process.env.SUPABASE_POOLER_URL) {
  console.log('🔀 Using Supabase pgBouncer pooler (egress-optimized)');
} else {
  console.log('⚠️  SUPABASE_POOLER_URL not set — using direct connection. Set it to reduce egress.');
}

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
    process.exit(1);
  });

module.exports = pool;