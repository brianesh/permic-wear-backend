/**
 * db/connection.js — PostgreSQL (Supabase) MySQL-style wrapper
 * Returns: [rows, fields, result]
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

/**
 * Convert MySQL-style ? placeholders → PostgreSQL $1, $2, $3
 */
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Wrap query to mimic mysql2 response style
 */
function wrapQuery(clientQuery) {
  return async (sql, params = []) => {
    try {
      let pgSql = convertPlaceholders(sql);

      const isInsert = /^\s*INSERT/i.test(pgSql);
      const hasReturning = /RETURNING/i.test(pgSql);

      if (isInsert && !hasReturning) {
        pgSql = pgSql.replace(/;?\s*$/, ' RETURNING *');
      }

      const result = await clientQuery(pgSql, params);
      const rows = result.rows || [];

      // MySQL-style insertId
      if (isInsert && rows.length > 0) {
        result.insertId = rows[0].id;
      }

      return [rows, result.fields || null, result];
    } catch (err) {
      console.error('DB Query Error:', err.message);
      throw err;
    }
  };
}

/**
 * Override pool.query
 */
pool.query = wrapQuery(pool.query.bind(pool));

/**
 * MySQL-like connection handler (for transactions)
 */
pool.getConnection = async () => {
  const client = await pool.connect();

  client.query = wrapQuery(client.query.bind(client));

  client.beginTransaction = () => client.query('BEGIN');
  client.commit = () => client.query('COMMIT');
  client.rollback = () => client.query('ROLLBACK');

  client.release = client.release.bind(client);

  return client;
};

/**
 * Test connection on startup
 */
(async () => {
  try {
    const client = await pool.connect();
    console.log('✅ PostgreSQL (Supabase) connected successfully');
    client.release();
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    process.exit(1);
  }
})();

module.exports = pool;