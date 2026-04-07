# Database Connection Issue - Urgent Fix Required

## 🚨 Problem Identified

Your system is currently **unable to save sales** because the database connection is failing. The error is:

```
password authentication failed for user "postgres"
```

## 🔍 Root Cause

The `DATABASE_URL` in your `.env` file contains an incorrect or outdated database password:

```env
DATABASE_URL=postgresql://postgres.dynsmjffhbvevzwbrgov:bridom1308%24@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

## ✅ Solution

### Step 1: Get Your Correct Database Password

1. Log in to your Supabase dashboard: https://supabase.com/dashboard
2. Go to your project settings
3. Navigate to **Database** → **Connection string**
4. Copy the correct connection string or password

### Step 2: Update .env File

Replace the `DATABASE_URL` in your `.env` file with the correct connection string from Supabase.

**Important:** If your password contains special characters like `$`, they must be URL-encoded:
- `$` → `%24`
- `@` → `%40`
- `#` → `%23`

Example format:
```env
DATABASE_URL=postgresql://postgres.[user]:[password]@[host]:5432/postgres
```

### Step 3: Test Connection

After updating the `.env` file, test the connection:

```bash
node -e "require('dotenv').config(); const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); pool.connect().then(c => { console.log('✅ Connected successfully'); c.release(); pool.end(); }).catch(err => { console.error('❌ Connection failed:', err.message); pool.end());"
```

### Step 4: Run Migration

Once connected successfully, run the TUMA migration:

```bash
node migrations/run_tuma_migration.js
```

### Step 5: Restart Application

Restart your application to apply the changes:

```bash
# If using PM2
pm2 restart permic-wear-backend

# If using Node directly
npm start
```

## 📋 Alternative: Manual Migration

If you prefer to run the migration manually in Supabase:

1. Open Supabase SQL Editor
2. Copy the contents of `migrations/migrate_to_tuma.sql`
3. Paste and execute in the SQL Editor
4. Verify the migration completed successfully

## 🔧 Verification

After fixing the database connection and running the migration, verify everything works:

1. **Check database connection:**
   ```bash
   node -e "require('dotenv').config(); const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); pool.connect().then(c => { console.log('✅ Database connected'); c.release(); pool.end(); }).catch(err => { console.error('❌ Failed:', err.message); pool.end());"
   ```

2. **Test saving a sale:**
   - Open your POS/frontend application
   - Create a test sale with Cash payment
   - Verify it saves successfully

3. **Test TUMA payment:**
   - Create a sale with Tuma payment
   - Verify STK push is initiated
   - Check that payment can be completed

## 📞 Need Help?

If you continue having issues:

1. **Check Supabase dashboard** for the correct connection details
2. **Verify database is not paused** (Supabase free tier pauses after inactivity)
3. **Check firewall settings** if connecting from a restricted network
4. **Contact support** if the issue persists

## 🎯 Next Steps After Fix

Once the database connection is working:

1. ✅ Test all payment methods (Cash, Tuma, Split)
2. ✅ Verify returns are working
3. ✅ Check reports are generating correctly
4. ✅ Test TUMA STK push with a small amount
5. ✅ Monitor logs for any errors

---

**Remember:** The database connection issue is blocking all sales operations. This must be fixed before the TUMA migration can be completed.