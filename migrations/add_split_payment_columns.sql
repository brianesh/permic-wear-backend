-- Migration: add_split_payment_columns
-- Adds cash_amount and mpesa_amount columns to the sales table to properly
-- record the breakdown of split payments (cash portion + M-Pesa portion).
-- Safe to run multiple times (IF NOT EXISTS guards).

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS cash_amount  DECIMAL(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS mpesa_amount DECIMAL(10,2) DEFAULT NULL;

-- Optional: back-fill completed Split sales where we have amount_paid data.
-- For historical Split sales the split breakdown is unknown, so we leave them NULL.
-- You can manually update specific records if you have the original amounts.

COMMENT ON COLUMN sales.cash_amount  IS 'Cash portion of a Split payment (NULL for non-Split)';
COMMENT ON COLUMN sales.mpesa_amount IS 'M-Pesa/Tuma portion of a Split payment (NULL for non-Split)';
