/**
 * seed.js — Production build
 *
 * NO demo data is seeded. The super admin account is created via the
 * first-run setup wizard at /setup in the frontend app.
 *
 * Only default settings that the app needs to function are inserted.
 */
require('dotenv').config();
const db = require('../src/db/connection');

async function seed() {
  console.log('🌱 Applying production defaults...\n');

  // Only insert settings that don't already exist
  const defaults = [
    ['currency',            'KES'],
    ['timezone',            'Africa/Nairobi'],
    ['commission_rate',     '10'],
    ['low_stock_threshold', '5'],
    ['aging_days',          '60'],
    ['sms_alerts',          'true'],
    ['email_alerts',        'true'],
    ['mpesa_env',           'sandbox'],
  ];

  for (const [key, val] of defaults) {
    await db.query(
      `INSERT INTO settings (key_name, key_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE key_name = key_name`,  // no-op if exists
      [key, val]
    );
  }

  console.log('  ✅ Default settings ensured (existing values preserved)');
  console.log('\n✅ Production seed complete.');
  console.log('   Open the app and complete the first-run setup wizard to create your Super Admin.\n');
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
