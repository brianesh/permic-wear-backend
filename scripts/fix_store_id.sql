-- Simple fix: Add store_id column without foreign key constraint
-- Run this if the full rebuild script failed

-- Step 1: Add store_id column if it doesn't exist
ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id INTEGER;

-- Step 2: Update all existing products to have store_id = 1
UPDATE products SET store_id = 1 WHERE store_id IS NULL;

-- Step 3: Create index for performance
CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);

-- Step 4: Verify
SELECT COUNT(*) as total_products FROM products;
SELECT COUNT(*) as with_store_id FROM products WHERE store_id IS NOT NULL;
SELECT COUNT(*) as store_1 FROM products WHERE store_id = 1;