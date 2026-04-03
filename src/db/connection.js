/**
 * db/connection.js — PostgreSQL (Supabase) only
 * Normalised to match mysql2 [rows, fields] interface.
 * Automatically:
 *   - converts ? placeholders → $1 $2 $3
 *   - appends RETURNING * to INSERT statements so insertId works
 *   - maps result.rows[0].id → insertId
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

function wrapQuery(queryFn) {
  return async (sql, params) => {
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);

    // Auto-append RETURNING * to INSERTs so insertId works
    const isInsert = /^\s*INSERT/i.test(pgSql);
    if (isInsert && !/RETURNING/i.test(pgSql)) {
      pgSql = pgSql.replace(/;?\s*$/, ' RETURNING *');
    }

    const result = await queryFn(pgSql, params);
    const rows   = result.rows || [];

    if (isInsert && rows.length > 0) {
      result.insertId = rows[0].id;
    }

    return [rows, result.fields, result];
  };
}

const originalPoolQuery = pool.query.bind(pool);
pool.query = wrapQuery(originalPoolQuery);

pool.getConnection = async () => {
  const client = await pool.connect();
  const originalClientQuery = client.query.bind(client);
  client.query            = wrapQuery(originalClientQuery);
  client.beginTransaction = () => client.query('BEGIN');
  client.commit           = () => client.query('COMMIT');
  client.rollback         = () => client.query('ROLLBACK');
  client.release          = client.release.bind(client);
  return client;
};

pool.connect()
  .then(client => { console.log('✅ PostgreSQL (Supabase) connected'); client.release(); })
  .catch(err   => { console.error('❌ PostgreSQL connection failed:', err.message); process.exit(1); });

module.exports = pool;
