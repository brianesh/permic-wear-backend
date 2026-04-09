#!/usr/bin/env node
/**
 * run_migration.js
 * Run this ONCE from your backend folder:
 *   node run_migration.js
 */
const { Client } = require('pg');

const DB_URL = process.env.DATABASE_URL || 
  'postgresql://postgres.vxzjyxvehpeblbqcljvf:brianesh1308n@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';

async function migrate() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('✓ Connected to database');

  try {
    // Show current constraint
    const { rows: before } = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'sales'::regclass AND contype = 'c'
      ORDER BY conname
    `);
    console.log('\n=== CURRENT CONSTRAINTS ===');
    before.forEach(r => console.log(`  ${r.conname}: ${r.def}`));

    // Fix payment_method constraint
    await client.query(`ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check`);
    await client.query(`ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
      CHECK (payment_method IN ('Cash', 'Tuma', 'M-Pesa', 'Split'))`);
    console.log('\n✓ payment_method constraint fixed');

    // Fix status constraint
    await client.query(`ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_status_check`);
    await client.query(`ALTER TABLE sales ADD CONSTRAINT sales_status_check
      CHECK (status IN ('completed','pending_tuma','pending_mpesa','pending_split','pending_cash','failed'))`);
    console.log('✓ status constraint fixed');

    // Add missing columns
    const cols = [
      `ALTER TABLE sales ADD COLUMN IF NOT EXISTS tuma_ref    VARCHAR(50)`,
      `ALTER TABLE sales ADD COLUMN IF NOT EXISTS mpesa_ref   VARCHAR(50)`,
      `ALTER TABLE sales ADD COLUMN IF NOT EXISTS store_id    INTEGER`,
      `ALTER TABLE sales ADD COLUMN IF NOT EXISTS phone       VARCHAR(20)`,
      `ALTER TABLE sales ADD COLUMN IF NOT EXISTS mpesa_phone VARCHAR(20)`,
    ];
    for (const sql of cols) {
      await client.query(sql);
    }
    console.log('✓ Missing columns added');

    // Create tuma_transactions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tuma_transactions (
        id                   SERIAL PRIMARY KEY,
        sale_id              INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        checkout_request_id  VARCHAR(100) UNIQUE,
        merchant_request_id  VARCHAR(100),
        phone                VARCHAR(20),
        amount               DECIMAL(10,2),
        payment_ref          VARCHAR(100),
        status               VARCHAR(20) NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','success','failed','timeout')),
        result_code          INT,
        result_desc          TEXT,
        initiated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        confirmed_at         TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tuma_txn_sale     ON tuma_transactions(sale_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tuma_txn_checkout ON tuma_transactions(checkout_request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tuma_txn_status   ON tuma_transactions(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tuma_txn_phone    ON tuma_transactions(phone)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tuma_txn_payref   ON tuma_transactions(payment_ref)`);
    console.log('✓ tuma_transactions table ready');

    // Create tuma_cancel_blocks table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tuma_cancel_blocks (
        phone                VARCHAR(20) PRIMARY KEY,
        consecutive_cancels  INT NOT NULL DEFAULT 0,
        last_cancel_at       TIMESTAMPTZ,
        blocked_at           TIMESTAMPTZ
      )
    `);
    console.log('✓ tuma_cancel_blocks table ready');

    // Show new constraint
    const { rows: after } = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'sales'::regclass AND contype = 'c'
      ORDER BY conname
    `);
    console.log('\n=== NEW CONSTRAINTS ===');
    after.forEach(r => console.log(`  ${r.conname}: ${r.def}`));

    console.log('\n🎉 Migration complete! Tuma payments will now work.');
  } finally {
    await client.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
