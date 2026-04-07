# 🗄️ Database Connection Fix Guide

## Current Issue
```
❌ Connection failed: password authentication failed for user "postgres"
```

## ✅ How to Get the Correct Connection String

### Step 1: Log in to Supabase
Go to: https://supabase.com/dashboard

### Step 2: Select Your Project
Click on your project (permic-wear or similar name)

### Step 3: Get Connection String
1. Click on **Project Settings** (gear icon in sidebar)
2. Click on **Database** in the left menu
3. Scroll down to **Connection string** section
4. You'll see several connection strings:
   - **URI** (recommended)
   - **Pooler** (for serverless)
   - **Direct** (for direct connection)

### Step 4: Copy the Correct Connection String
**Use the "Pooler" connection string** (recommended for production):
```
postgresql://postgres.[user]:[password]@[host]:5432/postgres?pgbouncer=true
```

**Important:** 
- Replace `[user]`, `[password]`, and `[host]` with your actual values
- If your password contains special characters like `$`, they must be URL-encoded:
  - `$` → `%24`
  - `@` → `%40`
  - `#` → `%23`
  - `&` → `%26`

### Step 5: Update Your .env File
Replace the entire `DATABASE_URL` line in your `.env` file with the connection string you copied.

**Example:**
```env
DATABASE_URL=postgresql://postgres.dynsmjffhbvevzwbrgov:your_actual_password%24@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?pgbouncer=true
```

### Step 6: Test the Connection
Run this command to test:
```bash
node -e "require('dotenv').config(); const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); pool.connect().then(c => { console.log('✅ Connected'); c.release(); pool.end(); }).catch(err => { console.error('❌ Failed:', err.message); pool.end());"
```

## 🔍 Common Issues & Solutions

### Issue 1: Password Contains Special Characters
If your password is `bridom1308$`, it must be encoded as `bridom1308%24`

### Issue 2: Using Wrong Connection String Format
Make sure you're using the **Pooler** connection string, not the direct one.

### Issue 3: Database is Paused
If you're on the free tier, your database might be paused:
- Go to Supabase dashboard
- Look for "Pause database" button
- If it says "Wake up database", click it
- Wait 30 seconds for the database to start

### Issue 4: Network/Firewall Issues
If you're getting `ENETUNREACH` errors:
- Try using the IPv4 connection string instead of IPv6
- Check if your network allows outbound connections to Supabase

### Issue 5: Wrong Password
If you're not sure of the password:
1. Go to Supabase dashboard
2. Project Settings → Database
3. Click "Reveal database password"
4. Copy the exact password shown

## 📞 Still Having Issues?

If none of these solutions work, please:
1. Take a screenshot of your Supabase Database connection string page (hide the password)
2. Share the error message you're getting
3. I can help you construct the correct connection string

## ✅ After Connection Works

Once you've successfully connected, run these commands in order:

```bash
# 1. Run TUMA migration
node migrations/run_tuma_migration.js

# 2. Run product variants migration
node -e "require('dotenv').config(); const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); pool.connect().then(async c => { const fs = require('fs'); const sql = fs.readFileSync('migrations/product_variants_migration.sql', 'utf8'); await c.query(sql); console.log('✅ Variants migration complete'); c.release(); pool.end(); }).catch(err => { console.error('❌ Migration failed:', err.message); process.exit(1); });"

# 3. Group existing products
node -e "require('dotenv').config(); const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); pool.connect().then(async c => { await c.query('SELECT group_products_by_variant()'); console.log('✅ Products grouped'); c.release(); pool.end(); }).catch(err => { console.error('❌ Grouping failed:', err.message); });"
```

Good luck! 🚀