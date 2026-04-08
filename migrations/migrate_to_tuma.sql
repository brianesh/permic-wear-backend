-- ═══════════════════════════════════════════════════════════════════
-- Permic Wear - M-Pesa to TUMA Migration Script
-- Run this on your existing PostgreSQL database to update schema
-- ═══════════════════════════════════════════════════════════════════

-- Step 1: Rename columns in sales table
ALTER TABLE sales RENAME COLUMN mpesa_ref TO tuma_ref;


-- Step 2: Update payment_method values from 'M-Pesa' to 'Tuma'
UPDATE sales SET payment_method = 'Tuma' WHERE payment_method = 'M-Pesa';

-- Step 3: Update status values from 'pending_mpesa' to 'pending_tuma'
UPDATE sales SET status = 'pending_tuma' WHERE status = 'pending_mpesa';

-- Step 4: Drop old M-Pesa transactions table if it exists
DROP TABLE IF EXISTS mpesa_transactions CASCADE;

-- Step 5: Create TUMA transactions table (if not exists from v6 migration)
CREATE TABLE IF NOT EXISTS tuma_transactions (
  id                  SERIAL PRIMARY KEY,
  sale_id             INT          NOT NULL REFERENCES sales(id),
  checkout_request_id VARCHAR(150) NOT NULL UNIQUE,
  merchant_request_id VARCHAR(150),
  phone               VARCHAR(20)  NOT NULL,
  amount              DECIMAL(10,2) NOT NULL,
  payment_ref         VARCHAR(100),
  result_code         INT,
  result_desc         VARCHAR(255),
  status              VARCHAR(20)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','success','failed','timeout')),
  initiated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  confirmed_at        TIMESTAMPTZ
);

-- Step 6: Create indexes for TUMA transactions
CREATE INDEX IF NOT EXISTS idx_tuma_txn_checkout ON tuma_transactions(checkout_request_id);
CREATE INDEX IF NOT EXISTS idx_tuma_txn_sale     ON tuma_transactions(sale_id);
CREATE INDEX IF NOT EXISTS idx_tuma_txn_status   ON tuma_transactions(status);

-- Step 7: Create TUMA cancellation blocks table
CREATE TABLE IF NOT EXISTS tuma_cancel_blocks (
  phone                VARCHAR(20)  PRIMARY KEY,
  consecutive_cancels  INT          NOT NULL DEFAULT 0,
  last_cancel_at       TIMESTAMPTZ,
  blocked_at           TIMESTAMPTZ
);

-- Step 8: Update settings to use TUMA instead of M-Pesa
INSERT INTO settings (key_name, key_value) 
VALUES ('tuma_env', 'production')
ON CONFLICT (key_name) DO UPDATE SET key_value = 'production';

-- Remove old M-Pesa settings
DELETE FROM settings WHERE key_name = 'mpesa_env';

-- Step 9: Add TUMA settings if not present
INSERT INTO settings (key_name, key_value) VALUES
  ('tuma_email', 'permicwear@gmail.com'),
  ('tuma_api_key', ''),
  ('tuma_callback_url', ''),
  ('tuma_paybill', '880100'),
  ('tuma_account', '505008')
ON CONFLICT (key_name) DO NOTHING;

-- Step 10: Verify migration
DO $$
BEGIN
  -- Check if columns were renamed
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'mpesa_ref') THEN
    RAISE EXCEPTION 'Migration failed: mpesa_ref column still exists';
  END IF;
  
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'tuma_ref') THEN
    RAISE EXCEPTION 'Migration failed: tuma_ref column does not exist';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'phone') THEN
    RAISE EXCEPTION 'Migration failed: phone column does not exist';
  END IF;
  
  RAISE NOTICE '✅ TUMA migration completed successfully!';
END $$;