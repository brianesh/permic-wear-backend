-- Fix sales table: expand status CHECK constraint to include pending_tuma, pending_split
-- and ensure tuma_ref column exists for storing Tuma payment references
-- Run this on your Supabase/PostgreSQL database

-- Step 1: Drop old constraint
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_status_check;

-- Step 2: Add expanded constraint
ALTER TABLE sales ADD CONSTRAINT sales_status_check
  CHECK (status IN (
    'completed',
    'pending_tuma',
    'pending_mpesa',   -- legacy alias kept for backward compat
    'pending_split',
    'pending_cash',
    'failed'
  ));

-- Step 3: Ensure tuma_ref column exists (stores Tuma/M-Pesa receipt code)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tuma_ref VARCHAR(50);

-- Step 4: Fix any stuck pending_mpesa rows → pending_tuma
UPDATE sales SET status = 'pending_tuma'
WHERE status = 'pending_mpesa';

-- Step 5: Ensure tuma_transactions table exists
CREATE TABLE IF NOT EXISTS tuma_transactions (
  id                   SERIAL PRIMARY KEY,
  sale_id              INT          NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  checkout_request_id  VARCHAR(100) UNIQUE,
  merchant_request_id  VARCHAR(100),
  phone                VARCHAR(20),
  amount               DECIMAL(10,2),
  payment_ref          VARCHAR(100),
  status               VARCHAR(20)  NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','success','failed','timeout')),
  result_code          INT,
  result_desc          TEXT,
  initiated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  confirmed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tuma_txn_sale     ON tuma_transactions(sale_id);
CREATE INDEX IF NOT EXISTS idx_tuma_txn_checkout ON tuma_transactions(checkout_request_id);
CREATE INDEX IF NOT EXISTS idx_tuma_txn_status   ON tuma_transactions(status);
CREATE INDEX IF NOT EXISTS idx_tuma_txn_phone    ON tuma_transactions(phone);

-- Step 6: Ensure cancellation blocks table exists
CREATE TABLE IF NOT EXISTS tuma_cancel_blocks (
  phone                VARCHAR(20) PRIMARY KEY,
  consecutive_cancels  INT         NOT NULL DEFAULT 0,
  last_cancel_at       TIMESTAMPTZ,
  blocked_at           TIMESTAMPTZ
);

SELECT 'Migration complete: sales status constraint fixed' AS result;
