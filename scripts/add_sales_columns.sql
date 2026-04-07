-- Add missing columns to sales table for M-Pesa integration
-- Run this on your Supabase/PostgreSQL database

-- Add mpesa_phone column if it doesn't exist
ALTER TABLE sales ADD COLUMN IF NOT EXISTS mpesa_phone VARCHAR(20);

-- Add mpesa_ref column if it doesn't exist (for M-Pesa transaction reference)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS mpesa_ref VARCHAR(50);

-- Add store_id column if it doesn't exist (for multi-store support)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS store_id INTEGER;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_sales_mpesa_phone ON sales(mpesa_phone);
CREATE INDEX IF NOT EXISTS idx_sales_mpesa_ref ON sales(mpesa_ref);
CREATE INDEX IF NOT EXISTS idx_sales_store_id ON sales(store_id);

-- Verify columns were added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'sales' 
  AND column_name IN ('mpesa_phone', 'mpesa_ref', 'store_id')
ORDER BY column_name;