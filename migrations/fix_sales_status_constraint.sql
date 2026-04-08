-- ════════════════════════════════════════════════════════════════
-- FIX: sales table CHECK constraints
-- Run this on your Supabase/PostgreSQL database BEFORE deploying
-- ════════════════════════════════════════════════════════════════

-- STEP 1: Fix payment_method CHECK constraint
-- Old: only 'Cash','Tuma','Split' — blocks 'M-Pesa' inserts → 500 error
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
  CHECK (payment_method IN ('Cash', 'Tuma', 'M-Pesa', 'Split'));

-- STEP 2: Fix status CHECK constraint
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_status_check;
ALTER TABLE sales ADD CONSTRAINT sales_status_check
  CHECK (status IN (
    'completed',
    'pending_tuma',
    'pending_mpesa',
    'pending_split',
    'pending_cash',
    'failed'
  ));

-- STEP 3: Ensure tuma_ref column exists (stores M-Pesa/Tuma receipt code)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tuma_ref VARCHAR(50);

-- STEP 4: Ensure store_id column exists
ALTER TABLE sales ADD COLUMN IF NOT EXISTS store_id INTEGER;

-- STEP 5: Ensure tuma_transactions table exists
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
CREATE INDEX IF NOT EXISTS idx_tuma_txn_payref   ON tuma_transactions(payment_ref);

-- STEP 6: Ensure tuma_cancel_blocks table exists
CREATE TABLE IF NOT EXISTS tuma_cancel_blocks (
  phone                VARCHAR(20) PRIMARY KEY,
  consecutive_cancels  INT         NOT NULL DEFAULT 0,
  last_cancel_at       TIMESTAMPTZ,
  blocked_at           TIMESTAMPTZ
);

SELECT 'Migration complete ✓' AS result;
