/**
 * run_tuma_migration.js — Run TUMA migration on existing database
 * Usage: node migrations/run_tuma_migration.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log('🔗 Connecting to database...');
    await client.query('BEGIN');
    
    // Read migration SQL file
    const migrationPath = path.join(__dirname, 'migrate_to_tuma.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('🚀 Running TUMA migration...');
    
    // Execute migration
    await client.query(migrationSQL);
    
    await client.query('COMMIT');
    console.log('✅ TUMA migration completed successfully!');
    console.log('');
    console.log('📋 Next steps:');
    console.log('1. Update your .env with TUMA production credentials');
    console.log('2. Restart your application');
    console.log('3. Test a sale transaction');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error.message);
    console.error('');
    console.error('Error details:', error);
    console.error('');
    console.error('💡 To run migration manually:');
    console.error('1. Open Supabase SQL Editor');
    console.error('2. Copy contents of migrations/migrate_to_tuma.sql');
    console.error('3. Paste and run in SQL Editor');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Check if DATABASE_URL is set
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is not set');
  console.error('Please set DATABASE_URL in your .env file');
  process.exit(1);
}

// Run migration
runMigration().catch(err => {
  console.error('❌ Unexpected error:', err.message);
  process.exit(1);
});