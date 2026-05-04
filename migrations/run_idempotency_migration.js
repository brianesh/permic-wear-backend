/**
 * Migration Runner for Idempotency Keys Table
 * 
 * This script runs the idempotency_keys migration to prevent duplicate sales.
 * Run this once to set up the database for duplicate sale prevention.
 * 
 * Usage: node migrations/run_idempotency_migration.js
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Database connection configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Starting idempotency_keys migration...');
    
    // Read the migration SQL file
    const migrationPath = path.join(__dirname, 'add_idempotency_keys.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute the migration
    await client.query(migrationSQL);
    
    console.log('✅ Migration completed successfully!');
    console.log('');
    console.log('📋 What was created:');
    console.log('   • idempotency_keys table - stores idempotency keys for sale deduplication');
    console.log('   • Indexes for fast lookups');
    console.log('   • cleanup_old_idempotency_keys() function for maintenance');
    console.log('   • idx_sales_dedup index for duplicate detection');
    console.log('');
    console.log('🔄 Next steps:');
    console.log('   1. Restart your backend server');
    console.log('   2. The system will now prevent duplicate sales automatically');
    console.log('');
    console.log('🛠️  Maintenance:');
    console.log('   Run this periodically to clean up old keys:');
    console.log('   SELECT cleanup_old_idempotency_keys();');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the migration
runMigration();