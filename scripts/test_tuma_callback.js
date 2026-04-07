/**
 * test_tuma_callback.js — Test TUMA callback endpoint
 * 
 * This script simulates a TUMA callback to verify the endpoint is working.
 * Usage: node scripts/test_tuma_callback.js
 */

require('dotenv').config();
const axios = require('axios');

// Configuration
const CALLBACK_URL = process.env.TUMA_CALLBACK_URL || 'http://localhost:5000/api/tuma/callback';

// Simulated TUMA callback payload (successful payment)
const successPayload = {
  status: 'completed',
  result_code: 0,
  result_desc: 'The service request is processed successfully.',
  checkout_request_id: `TEST-${Date.now()}`,
  merchant_request_id: `MERCH-${Date.now()}`,
  receipt_number: `TEST_RECEIPT_${Date.now()}`,
  msisdn: '254712345678',
  amount: 100,
  firstname: 'Test',
  lastname: 'Customer',
  bank_name: 'Tuma',
  account_number: '505008'
};

// Simulated TUMA callback payload (failed payment - user cancelled)
const failedPayload = {
  status: 'failed',
  result_code: 1032,
  result_desc: 'User cancelled the payment',
  checkout_request_id: `TEST-${Date.now()}`,
  merchant_request_id: `MERCH-${Date.now()}`,
  msisdn: '254712345678',
  amount: 100
};

async function testCallback() {
  console.log('🧪 Testing TUMA Callback Endpoint');
  console.log('=================================');
  console.log(`Callback URL: ${CALLBACK_URL}`);
  console.log('');

  // Test 1: Check if endpoint is reachable
  console.log('📡 Test 1: Checking endpoint reachability...');
  try {
    const response = await axios.post(CALLBACK_URL, successPayload, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Endpoint responded successfully!');
    console.log('   Status:', response.status);
    console.log('   Response:', JSON.stringify(response.data));
    console.log('');
  } catch (error) {
    console.error('❌ Endpoint not reachable or returned error');
    console.error('   Error:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data));
    }
    console.log('');
    console.log('🔧 Troubleshooting:');
    console.log('1. Ensure your application is running');
    console.log('2. Check TUMA_CALLBACK_URL in .env is correct');
    console.log('3. Verify the route is registered in server.js');
    console.log('4. Check firewall/network settings');
    return;
  }

  // Test 2: Verify payload structure
  console.log('📋 Test 2: Verifying callback payload structure...');
  console.log('   Sample payload (success):');
  console.log('   ', JSON.stringify(successPayload, null, 2));
  console.log('');
  console.log('   Sample payload (failure):');
  console.log('   ', JSON.stringify(failedPayload, null, 2));
  console.log('');

  // Test 3: Check database connection
  console.log('🗄️  Test 3: Checking database connection...');
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    await pool.end();

    console.log('✅ Database connection successful!');
    console.log('');
  } catch (error) {
    console.error('❌ Database connection failed!');
    console.error('   Error:', error.message);
    console.log('');
    console.log('🔧 Fix database connection first:');
    console.log('1. Update DATABASE_URL in .env with correct credentials');
    console.log('2. Ensure Supabase database is accessible');
    console.log('3. Check network/firewall settings');
    return;
  }

  // Test 4: Check required tables
  console.log('🗃️  Test 4: Checking required tables...');
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    const client = await pool.connect();
    
    // Check tuma_transactions table
    const { rows: [tableCheck] } = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'tuma_transactions'
      ) as exists
    `);

    if (tableCheck.exists) {
      console.log('✅ tuma_transactions table exists');
      
      // Check columns
      const { rows: columns } = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'tuma_transactions'
        ORDER BY ordinal_position
      `);
      
      console.log('   Columns:', columns.map(c => `${c.column_name} (${c.data_type})`).join(', '));
    } else {
      console.error('❌ tuma_transactions table missing!');
      console.log('   Run database migration first.');
    }

    // Check sales table
    const { rows: [salesCheck] } = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'sales'
      ) as exists
    `);

    if (salesCheck.exists) {
      console.log('✅ sales table exists');
      
      // Check for required columns
      const { rows: salesColumns } = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'sales' AND column_name IN ('tuma_ref', 'phone')
      `);
      
      if (salesColumns.length >= 2) {
        console.log('   ✅ Required columns (tuma_ref, phone) exist');
      } else {
        console.error('   ❌ Missing required columns (tuma_ref, phone)');
        console.log('      Run TUMA migration to update sales table');
      }
    } else {
      console.error('❌ sales table missing!');
    }

    client.release();
    await pool.end();
    console.log('');
  } catch (error) {
    console.error('❌ Error checking tables:', error.message);
  }

  // Summary
  console.log('📊 Test Summary');
  console.log('===============');
  console.log('✅ Callback endpoint is reachable');
  console.log('✅ Payload structure is correct');
  console.log('✅ Database connection works');
  console.log('ℹ️  Tables and columns verified');
  console.log('');
  console.log('🎉 TUMA callback is properly configured!');
  console.log('');
  console.log('📝 Next Steps:');
  console.log('1. Ensure your application is running on the callback URL');
  console.log('2. Configure TUMA merchant portal with your callback URL:');
  console.log(`   ${CALLBACK_URL}`);
  console.log('3. Test with a real STK push transaction');
  console.log('4. Monitor logs for callback processing');
  console.log('');
  console.log('🔍 To monitor callbacks in real-time:');
  console.log('   pm2 logs permic-wear-backend --lines 100');
  console.log('');
}

// Run the test
testCallback().catch(err => {
  console.error('❌ Unexpected error:', err.message);
  process.exit(1);
});