/**
 * db/connection.js — PostgreSQL (Supabase) with dual-style query results
 *
 * Supports BOTH access patterns used across routes:
 *   Pattern A (mysql2 style):  const [[row]] = await db.query(sql, params)
 *   Pattern B (pg style):      const { rows } = await db.query(sql, params)
 *   Pattern C (pg style):      const { rows: [row] } = await db.query(sql, params)
 *
 * Returns an array [rows, fields] that ALSO has a .rows property,
 * so both destructuring styles work on the same return value.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Convert MySQL ? placeholders → PostgreSQL $1 $2 $3
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Wrap a pg query function to return dual-style result
function wrapQuery(queryFn) {
  return async function(sql, params = []) {
    const pgSql = convertPlaceholders(sql);
    const result = await queryFn(pgSql, params);
    const rows = result.rows || [];

    // Build array [rows, fields] with .rows and .insertId attached
    // This satisfies BOTH [[row]] destructuring AND { rows } destructuring
    const ret = [rows, result.fields || []];
    ret.rows     = rows;
    ret.insertId = rows[0]?.id ?? null;
    return ret;
  };
}

pool.query = wrapQuery(pool.query.bind(pool));

// FIX: Force search_path to public on every new connection.
// Without this, Supabase's 'authenticator' role (used by the app) has no
// search_path set, so it cannot resolve tables in the public schema.
pool.on('connect', client => {
  client.query("SET search_path TO public, extensions");
});

// MySQL-like getConnection for transactions
pool.getConnection = async () => {
  const client = await pool.connect();
  // Also set search_path on transaction clients
  await client.query("SET search_path TO public, extensions");
  client.query            = wrapQuery(client.query.bind(client));
  client.beginTransaction = () => client.query('BEGIN');
  client.commit           = () => client.query('COMMIT');
  client.rollback         = () => client.query('ROLLBACK');
  client.release          = client.release.bind(client);
  return client;
};

// Test on startup
pool.connect()
  .then(c => { console.log('✅ PostgreSQL (Supabase) connected'); c.release(); })
  .catch(err => { console.error('❌ PostgreSQL connection failed:', err.message); process.exit(1); });

module.exports = pool;