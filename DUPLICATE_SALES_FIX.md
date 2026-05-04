# 🔧 Duplicate Sales Fix - Deployment Guide

## Overview

This fix implements **idempotency-based duplicate sale prevention** to eliminate the issue where sales are recorded twice due to network delays, user double-clicking, or payment retry scenarios.

## 🚀 Deployment Steps

### Step 1: Run Database Migration

First, run the database migration to create the `idempotency_keys` table:

```bash
cd permic-wear-backend
node migrations/run_idempotency_migration.js
```

**Expected output:**
```
🚀 Starting idempotency_keys migration...
✅ Migration completed successfully!

📋 What was created:
   • idempotency_keys table - stores idempotency keys for sale deduplication
   • Indexes for fast lookups
   • cleanup_old_idempotency_keys() function for maintenance
   • idx_sales_dedup index for duplicate detection

🔄 Next steps:
   1. Restart your backend server
   2. The system will now prevent duplicate sales automatically

🛠️  Maintenance:
   Run this periodically to clean up old keys:
   SELECT cleanup_old_idempotency_keys();
```

### Step 2: Restart Backend Server

```bash
# If using PM2
pm2 restart all

# If using nodemon
# Just restart the server

# If deployed on Render/Heroku
# Push to trigger deployment or restart manually
```

### Step 3: Deploy Frontend Changes

The frontend changes are already included in the codebase. Deploy your frontend:

```bash
cd permic-wear-final
npm run build
# Then deploy to your hosting (Vercel, Netlify, etc.)
```

## ✅ How It Works

### 1. Idempotency Key Generation (Frontend)

When a user initiates a sale, the frontend generates a unique idempotency key based on:
- User ID
- Cart items (product IDs and quantities)
- Timestamp

```javascript
const generateIdempotencyKey = () => {
  const cartIds = cart.map(c => c.id).sort().join('-');
  const cartQtys = cart.map(c => `${c.id}:${c.qty}`).sort().join('-');
  return `sale-${user?.id}-${Date.now()}-${cartIds}-${cartQtys}`;
};
```

### 2. Duplicate Detection (Backend)

The backend performs two levels of duplicate detection:

**Level 1: Idempotency Key Check**
- If the same idempotency key is received within 24 hours, return the original sale
- Prevents exact duplicate API calls

**Level 2: Fuzzy Duplicate Detection**
- Checks for sales with same cashier, same total, within 30 seconds
- Compares items to confirm it's the same sale
- Catches cases where idempotency key wasn't sent

### 3. Atomic Operations (Backend)

All critical operations use atomic database operations to prevent race conditions:
- Sale creation with idempotency key storage
- Payment completion with status checks
- Stock deduction

## 🔍 Testing the Fix

### Test 1: Double-Click Prevention

1. Add items to cart
2. Click "Complete Sale" twice quickly
3. **Expected:** Only ONE sale should be created
4. Check the response - second request should return `idempotent: true`

### Test 2: Network Timeout Recovery

1. Simulate slow network (use browser DevTools → Network → Slow 3G)
2. Complete a sale
3. If it times out, click "Complete Sale" again
4. **Expected:** Only ONE sale should be created

### Test 3: Tuma Payment Retry

1. Start a Tuma payment
2. Let it timeout or fail
3. Click "Retry Payment"
4. **Expected:** Should NOT create a new sale, should use existing pending sale

## 📊 Monitoring

### Check for Duplicate Prevention in Logs

Look for these log messages:

```
[Sales] Duplicate request detected - returning existing sale: TXN-XXXX
[Sales] Potential duplicate sale detected - returning existing: TXN-XXXX
[Tuma] Sale XXX already completed - skipping (idempotent)
```

### Query to Find Potential Duplicates

Run this query to check if duplicates still exist (should return 0 after fix):

```sql
SELECT 
  cashier_id,
  selling_total,
  COUNT(*) as duplicate_count,
  array_agg(id) as sale_ids
FROM sales 
WHERE sale_date > NOW() - INTERVAL '1 hour'
GROUP BY cashier_id, selling_total
HAVING COUNT(*) > 1
ORDER BY sale_date DESC;
```

## 🛠️ Maintenance

### Clean Up Old Idempotency Keys

Run this periodically (e.g., weekly) to clean up old keys:

```sql
SELECT cleanup_old_idempotency_keys();
```

Or set up a cron job:

```bash
# Add to crontab (runs daily at 2 AM)
0 2 * * * cd /path/to/permic-wear-backend && psql $DATABASE_URL -c "SELECT cleanup_old_idempotency_keys();"
```

### Monitor Idempotency Keys Table Size

```sql
SELECT 
  COUNT(*) as total_keys,
  MIN(created_at) as oldest_key,
  MAX(created_at) as newest_key
FROM idempotency_keys;
```

## 🐛 Troubleshooting

### Issue: Migration Fails

**Symptom:** Migration script errors out

**Solution:**
1. Check database connection: `echo $DATABASE_URL`
2. Verify PostgreSQL version (should be 9.5+)
3. Check permissions: User must have CREATE TABLE privilege

### Issue: Duplicates Still Occurring

**Symptom:** Sales are still being duplicated

**Solution:**
1. Verify migration ran successfully
2. Check backend logs for duplicate detection messages
3. Ensure frontend is sending `idempotency_key` in request body
4. Check if `idempotency_keys` table exists: `\dt idempotency_keys`

### Issue: Performance Degradation

**Symptom:** Sale creation is slow

**Solution:**
1. Check if indexes exist:
   ```sql
   SELECT indexname FROM pg_indexes WHERE tablename = 'idempotency_keys';
   ```
2. Run ANALYZE on tables:
   ```sql
   ANALYZE idempotency_keys;
   ANALYZE sales;
   ```
3. Check for long-running queries in PostgreSQL logs

## 📝 Changes Summary

### Files Modified

1. **Backend:**
   - `permic-wear-backend/src/routes/sales.js` - Added idempotency and duplicate detection
   - `permic-wear-backend/src/routes/tuma.js` - Improved idempotent sale completion
   - `permic-wear-backend/migrations/add_idempotency_keys.sql` - New migration
   - `permic-wear-backend/migrations/run_idempotency_migration.js` - Migration runner

2. **Frontend:**
   - `permic-wear-final/src/pages/POS.jsx` - Added idempotency key generation

### Database Schema Changes

```sql
CREATE TABLE idempotency_keys (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    sale_id INTEGER REFERENCES sales(id),
    response JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## 🎯 Expected Results

After deploying this fix:

1. ✅ **No duplicate sales** from double-clicking
2. ✅ **No duplicate sales** from network retries
3. ✅ **No duplicate sales** from Tuma payment retries
4. ✅ **Consistent inventory** - stock won't be deducted twice
5. ✅ **Accurate reports** - revenue won't be inflated
6. ✅ **Better user experience** - clear feedback on duplicate attempts

## 📞 Support

If you encounter any issues during deployment:

1. Check backend logs: `pm2 logs` or check your logging service
2. Check database for errors: `SELECT * FROM pg_stat_database;`
3. Verify all files were updated correctly
4. Test in a staging environment first if possible

---

**Last Updated:** 2026-05-04  
**Version:** 1.0.0  
**Author:** Development Team