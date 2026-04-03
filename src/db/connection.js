/**
 * db/connection.js
 *
 * Supports TWO database modes detected automatically:
 *   1. DATABASE_URL set (Supabase / PlanetScale / Railway)  → uses pg (PostgreSQL)
 *   2. DB_HOST / DB_NAME set (local MySQL / Render MySQL)   → uses mysql2
 *
 * All query calls use the same interface: db.query(sql, params)
 * Results are normalised to [rows, fields] just like mysql2.
 */

const isPg = !!process.env.DATABASE_URL;

let pool;

if (isPg) {
  // ── PostgreSQL (Supabase) ──────────────────────────────────────
  const { Pool } = require('pg');

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // required by Supabase
    max: 10,
  });

  // Wrap pg to match mysql2's [rows, fields] return shape
  const originalQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    // Convert MySQL ? placeholders to PostgreSQL $1 $2 $3 ...
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const result = await originalQuery(pgSql, params);
    return [result.rows, result.fields];
  };

  // mysql2-compatible getConnection shim for transactions
  pool.getConnection = async () => {
    const client = await pool.connect();
    client.beginTransaction = () => client.query('BEGIN');
    client.commit          = () => client.query('COMMIT');
    client.rollback        = () => client.query('ROLLBACK');
    client.release         = () => client.release();
    // Wrap client.query too
    const origClientQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      const result = await origClientQuery(pgSql, params);
      return [result.rows, result.fields];
    };
    return client;
  };

  pool.connect()
    .then(client => { console.log('✅ PostgreSQL (Supabase) connected'); client.release(); })
    .catch(err   => { console.error('❌ PostgreSQL connection failed:', err.message); process.exit(1); });

} else {
  // ── MySQL (local / Render MySQL) ──────────────────────────────
  const mysql = require('mysql2/promise');

  pool = mysql.createPool({
    host:               process.env.DB_HOST     || 'localhost',
    port:               parseInt(process.env.DB_PORT || '3306'),
    database:           process.env.DB_NAME     || 'permic_wear',
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASS     || process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
  });

  pool.getConnection()
    .then(conn => { console.log('✅ MySQL connected'); conn.release(); })
    .catch(err  => { console.error('❌ MySQL connection failed:', err.message); process.exit(1); });
}

module.exports = pool;
