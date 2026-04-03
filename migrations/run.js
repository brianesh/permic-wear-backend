require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('../src/db/connection');

function stripFullLineComments(chunk) {
  return chunk
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => { const t = line.trim(); return t.length > 0 && !t.startsWith('--'); })
    .join('\n')
    .trim();
}

/**
 * Safely add a column only if it doesn't already exist.
 * Works on MySQL 5.7 and 8.0+.
 */
async function addColumnIfMissing(table, column, definition) {
  const [[dbRow]] = await db.query('SELECT DATABASE() AS db');
  const dbName = dbRow.db;
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  if (rows.length > 0) {
    console.log(`  ⏭  Column already exists: ${table}.${column}`);
    return;
  }
  await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  console.log(`  ✅ Added column: ${table}.${column}`);
}

async function runMigrations() {
  console.log('🗄  Running database migrations...');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  const statements = sql
    .split(';')
    .map(stripFullLineComments)
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    try {
      await db.query(stmt);
      const match = stmt.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
      if (match) console.log(`  ✅ Table ready: ${match[1]}`);
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);
      console.error(`  Statement: ${stmt.slice(0, 120)}...`);
    }
  }

  // ── Safe schema alterations (MySQL 5.7 compatible) ────────────
  console.log('\n🔧 Applying schema alterations...');

  // Expand sales.status ENUM
  try {
    await db.query(
      `ALTER TABLE sales MODIFY COLUMN status ENUM('completed','pending_mpesa','pending_cash','pending_split','failed') NOT NULL DEFAULT 'completed'`
    );
    console.log('  ✅ sales.status ENUM updated');
  } catch (err) {
    console.log(`  ⚠  sales.status: ${err.message}`);
  }

  // Add new product columns (safe on MySQL 5.7)
  await addColumnIfMissing('products', 'color',       "VARCHAR(80) NOT NULL DEFAULT ''");
  await addColumnIfMissing('products', 'photo_url',   "TEXT");
  await addColumnIfMissing('products', 'brand_id',    "INT");
  await addColumnIfMissing('products', 'sub_type_id', "INT");
  await addColumnIfMissing('products', 'top_type',    "ENUM('shoes','clothes') NOT NULL DEFAULT 'shoes'");

  // Add is_active to users if missing
  await addColumnIfMissing('users', 'is_active', "BOOLEAN NOT NULL DEFAULT TRUE");

  // Add foreign keys if they don't exist (ignore if already present)
  const fkStatements = [
    `ALTER TABLE products ADD CONSTRAINT fk_prod_brand    FOREIGN KEY (brand_id)    REFERENCES brands(id)    ON DELETE SET NULL`,
    `ALTER TABLE products ADD CONSTRAINT fk_prod_subtype  FOREIGN KEY (sub_type_id) REFERENCES sub_types(id) ON DELETE SET NULL`,
  ];
  for (const stmt of fkStatements) {
    try {
      await db.query(stmt);
      console.log(`  ✅ FK applied`);
    } catch (err) {
      // 1826 = duplicate FK name, 1005 = can't create (already exists) — both safe to ignore
      if (err.errno !== 1826 && err.errno !== 1005 && !err.message.includes('Duplicate')) {
        console.log(`  ⚠  FK note: ${err.message}`);
      } else {
        console.log(`  ⏭  FK already exists`);
      }
    }
  }

  console.log('\n✅ Migrations complete.');
  process.exit(0);
}

runMigrations().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
