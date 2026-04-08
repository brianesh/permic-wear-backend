# TUMA Payment Migration Guide

## Overview

This guide covers the complete migration from M-Pesa to TUMA Payment API for the Permic Wear backend system.

## Changes Made

### 1. Environment Variables

**Removed M-Pesa variables:**
- `MPESA_ENV`
- `MPESA_SHORTCODE`
- `MPESA_CONSUMER_KEY`
- `MPESA_CONSUMER_SECRET`
- `MPESA_PASSKEY`
- `MPESA_CALLBACK_URL`

**Added TUMA variables:**
- `TUMA_ENV=production`
- `TUMA_EMAIL=your_email@example.com`
- `TUMA_API_KEY=your_production_api_key`
- `TUMA_PAYBILL=880100`
- `TUMA_ACCOUNT=505008`
- `TUMA_CALLBACK_URL=https://your-domain.com/api/tuma/callback`

### 2. Database Schema Changes

**Sales Table:**
- `payment_method` ENUM changed from `('Cash','M-Pesa','Split')` to `('Cash','Tuma','Split')`
- `mpesa_ref` renamed to `tuma_ref`
- `status` ENUM changed from `pending_mpesa` to `pending_tuma`

**New Tables:**
- `tuma_transactions` - Tracks TUMA payment transactions
- `tuma_cancel_blocks` - Blocks phones with 3+ consecutive cancellations

### 3. API Changes

**Payment Status Values:**
- `pending_mpesa` → `pending_tuma`
- `mpesa_ref` → `tuma_ref`

**Routes:**
- All payment routes now use `/api/tuma/` prefix
- Callback URL: `/api/tuma/callback`

## Migration Steps for Existing Deployments

### Step 1: Update Environment Variables

```bash
# Update your .env file or hosting platform environment variables
# Remove all MPESA_* variables
# Add TUMA_* variables with your production credentials
```

### Step 2: Run Database Migration

For **PostgreSQL (Supabase)**:
```sql
-- Update sales table
ALTER TABLE sales RENAME COLUMN mpesa_ref TO tuma_ref;

-- Update payment_method enum
ALTER TABLE sales ALTER COLUMN payment_method TYPE VARCHAR(10);
UPDATE sales SET payment_method = 'Tuma' WHERE payment_method = 'M-Pesa';
ALTER TABLE sales ALTER COLUMN payment_method TYPE VARCHAR(10) 
  USING CASE payment_method 
    WHEN 'M-Pesa' THEN 'Tuma'
    ELSE payment_method 
  END::VARCHAR(10);
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check 
  CHECK (payment_method IN ('Cash','Tuma','Split'));

-- Update status enum
UPDATE sales SET status = 'pending_tuma' WHERE status = 'pending_mpesa';

-- Create TUMA tables if not exists
CREATE TABLE IF NOT EXISTS tuma_transactions (
  id                  SERIAL PRIMARY KEY,
  sale_id             INT NOT NULL REFERENCES sales(id),
  checkout_request_id VARCHAR(150) NOT NULL UNIQUE,
  merchant_request_id VARCHAR(150),
  phone               VARCHAR(20) NOT NULL,
  amount              DECIMAL(10,2) NOT NULL,
  payment_ref         VARCHAR(100),
  result_code         INT,
  result_desc         VARCHAR(255),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','success','failed','timeout')),
  initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tuma_cancel_blocks (
  phone               VARCHAR(20) PRIMARY KEY,
  consecutive_cancels INT NOT NULL DEFAULT 0,
  last_cancel_at      TIMESTAMPTZ,
  blocked_at          TIMESTAMPTZ
);
```

For **MySQL**:
```sql
-- Update sales table
ALTER TABLE sales CHANGE mpesa_ref tuma_ref VARCHAR(50);


-- Update payment_method enum
ALTER TABLE sales MODIFY payment_method ENUM('Cash','Tuma','Split');
UPDATE sales SET payment_method = 'Tuma' WHERE payment_method = 'M-Pesa';
UPDATE sales SET status = 'pending_tuma' WHERE status = 'pending_mpesa';

-- Create TUMA tables
CREATE TABLE IF NOT EXISTS tuma_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sale_id INT NOT NULL,
  checkout_request_id VARCHAR(100) NOT NULL UNIQUE,
  merchant_request_id VARCHAR(100),
  phone VARCHAR(20) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  payment_ref VARCHAR(50),
  result_code INT,
  result_desc VARCHAR(255),
  status ENUM('pending','success','failed','timeout') NOT NULL DEFAULT 'pending',
  initiated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at DATETIME,
  FOREIGN KEY (sale_id) REFERENCES sales(id)
);

CREATE TABLE IF NOT EXISTS tuma_cancel_blocks (
  phone VARCHAR(20) PRIMARY KEY,
  consecutive_cancels INT NOT NULL DEFAULT 0,
  last_cancel_at DATETIME,
  blocked_at DATETIME
);
```

### Step 3: Update Frontend

Update your frontend application to:
1. Use `Tuma` as payment method instead of `M-Pesa`
2. Call `/api/tuma/stk-push` instead of `/api/mpesa/stk-push`
3. Update any UI text from "M-Pesa" to "Tuma"

### Step 4: Configure TUMA Callback URL

Ensure your TUMA callback URL is publicly accessible:
```
https://your-domain.com/api/tuma/callback
```

For development with ngrok:
```
https://your-ngrok-url.ngrok.io/api/tuma/callback
```

### Step 5: Test Credentials

Use the test endpoint to verify your TUMA credentials:
```bash
GET /api/tuma/test-credentials
Authorization: Bearer <your_jwt_token>
```

## Production Deployment Checklist

- [ ] Update `.env` with production TUMA credentials
- [ ] Set `TUMA_ENV=production`
- [ ] Configure production callback URL
- [ ] Run database migration
- [ ] Update frontend payment method
- [ ] Test STK push flow
- [ ] Test callback handling
- [ ] Verify SMS confirmations
- [ ] Test returns with TUMA reference

## TUMA API Configuration

### Getting Your API Key

1. Log in to your TUMA merchant portal
2. Navigate to Settings → API Keys
3. Generate a new API key
4. Copy the key to your `.env` file

### Paybill Information

- **Paybill:** 880100
- **Account:** 505008

These are the default values but can be overridden in settings.

## Troubleshooting

### Common Issues

1. **"Tuma API key or email not configured"**
   - Ensure `TUMA_API_KEY` and `TUMA_EMAIL` are set in `.env` or database settings

2. **"Authentication failed (401)"**
   - Verify your API key and email are correct
   - Check that your TUMA account is active

3. **"Callback URL not reachable"**
   - Ensure your callback URL is publicly accessible (HTTPS required)
   - For development, use ngrok or similar tool

4. **"Payment blocked: This number has cancelled 3 consecutive payment requests"**
   - This is a TUMA policy enforcement
   - Contact support to unblock or wait for automatic reset after successful payment

### Testing

Test your integration with small amounts first:
```bash
POST /api/tuma/stk-push
{
  "sale_id": 123,
  "phone": "0712345678",
  "amount": 10
}
```

## Support

For TUMA-related issues:
- TUMA Documentation: https://docs.tuma.co.ke
- TUMA Support: support@tuma.co.ke

For application issues:
- Check logs: `npm run logs` (if using PM2)
- Review activity logs in the admin panel