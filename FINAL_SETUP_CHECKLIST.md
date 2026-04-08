# Final Setup Checklist - Permic Wear TUMA Integration

## ✅ Completed Tasks

### 1. Code Migration (100% Complete)
- [x] Removed all M-Pesa references from codebase
- [x] Updated all payment methods to use 'Tuma'
- [x] Updated all ENUMs (`pending_mpesa` → `pending_tuma`)
- [x] Modified all routes, services, and reports
- [x] Updated database schemas for both MySQL and PostgreSQL

### 2. Configuration Files
- [x] Updated `.env` with production TUMA configuration
- [x] Updated `.env.example` as template
- [x] Updated `.env.development` for local development

### 3. Migration Tools Created
- [x] `migrations/migrate_to_tuma.sql` - SQL migration script
- [x] `migrations/run_tuma_migration.js` - Automated migration runner
- [x] `scripts/deploy_tuma_production.sh` - Production deployment script
- [x] `TUMA_MIGRATION_GUIDE.md` - Comprehensive documentation
- [x] `DATABASE_SETUP_INSTRUCTIONS.md` - Database troubleshooting

## 🚨 Critical Issue: Database Connection Failed

### Problem
```
password authentication failed for user "postgres"
```

### Current DATABASE_URL
```
postgresql://postgres.dynsmjffhbvevzwbrgov:bridom1308%24@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

### Required Actions

#### Option 1: Fix Database Credentials (Recommended)
1. **Log in to Supabase Dashboard**
   - Go to: https://supabase.com/dashboard
   - Select your project

2. **Get Correct Connection String**
   - Navigate to: Project Settings → Database → Connection string
   - Copy the **URI** connection string

3. **Update .env File**
   - Replace the `DATABASE_URL` line with the correct connection string
   - Ensure special characters in password are URL-encoded:
     - `$` → `%24`
     - `@` → `%40`
     - `#` → `%23`

4. **Test Connection**
   ```bash
   node -e "require('dotenv').config(); const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); pool.connect().then(c => { console.log('✅ Connected'); c.release(); pool.end(); }).catch(err => { console.error('❌ Failed:', err.message); pool.end());"
   ```

5. **Run Migration**
   ```bash
   node migrations/run_tuma_migration.js
   ```

#### Option 2: Manual Migration via Supabase SQL Editor
1. Open Supabase SQL Editor
2. Copy contents of `migrations/migrate_to_tuma.sql`
3. Paste and execute
4. Verify success

## 📋 Remaining Tasks

### Before Going Live

1. **Fix Database Connection** (URGENT)
   - Update `DATABASE_URL` with correct credentials
   - Run database migration

2. **Update TUMA API Key**
   - Replace `REPLACE_WITH_YOUR_REAL_TUMA_API_KEY` in `.env`
   - Get your actual key from TUMA merchant portal

3. **Update JWT Secret**
   - Replace `REPLACE_WITH_STRONG_RANDOM_SECRET_64_CHARS` in `.env`
   - Generate a secure 64-character random string

4. **Update Africa's Talking Credentials**
   - Replace `your_production_api_key` with actual key
   - Replace `your_username` with actual username

5. **Test All Payment Methods**
   - Cash payments
   - TUMA STK push
   - Split payments

6. **Verify Callback URL**
   - Ensure `https://permic-wear-api.onrender.com/api/tuma/callback` is accessible
   - Test with a small TUMA transaction

7. **Update Frontend**
   - Change payment method from 'M-Pesa' to 'Tuma'
   - Update API endpoints to use `/api/tuma/`

8. **Deploy Application**
   ```bash
   chmod +x scripts/deploy_tuma_production.sh
   ./scripts/deploy_tuma_production.sh
   ```

## 🔧 Testing Checklist

After fixing database connection:

- [ ] Database connects successfully
- [ ] Migration runs without errors
- [ ] Can create a sale with Cash payment
- [ ] Can create a sale with Tuma payment
- [ ] TUMA STK push initiates correctly
- [ ] Payment callback is received and processed
- [ ] Returns work with TUMA references
- [ ] Reports show Tuma payment data correctly
- [ ] SMS confirmations are sent
- [ ] All API endpoints respond correctly

## 📞 Support Resources

### Database Issues
- Supabase Dashboard: https://supabase.com/dashboard
- Supabase Docs: https://supabase.com/docs

### TUMA Issues
- TUMA Documentation: https://docs.tuma.co.ke
- TUMA Support: support@tuma.co.ke

### Application Issues
- Check logs: `pm2 logs permic-wear-backend`
- Review activity logs in admin panel
- Check `DATABASE_SETUP_INSTRUCTIONS.md`

## 🎯 Success Criteria

The migration is complete when:
1. ✅ Database connection works
2. ✅ All sales save successfully
3. ✅ TUMA payments process correctly
4. ✅ No M-Pesa references remain in code
5. ✅ All tests pass
6. ✅ Production deployment successful

---

**Next Step:** Fix the database connection by updating `DATABASE_URL` with correct Supabase credentials.