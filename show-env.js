require('dotenv').config();
console.log('=== Environment Variables ===');
console.log('SUPABASE_POOLER_URL:', process.env.SUPABASE_POOLER_URL || '❌ NOT FOUND');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✅ FOUND (starts with: ' + process.env.DATABASE_URL.substring(0, 50) + '...)' : '❌ NOT FOUND');
console.log('NODE_ENV:', process.env.NODE_ENV || '❌ NOT FOUND');
console.log('PORT:', process.env.PORT || '❌ NOT FOUND');

if (process.env.DATABASE_URL) {
  const hasPoolerPort = process.env.DATABASE_URL.includes(':6543');
  const hasDirectPort = process.env.DATABASE_URL.includes(':5432');
  console.log('DATABASE_URL port type:', hasPoolerPort ? 'Pooler (6543) ✅' : (hasDirectPort ? 'Direct (5432)' : 'Unknown'));
}
