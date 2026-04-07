-- ═══════════════════════════════════════════════════════════════════
-- Add missing stores table
-- The users table references store_id but stores table was missing
-- ═══════════════════════════════════════════════════════════════════

-- Create stores table
CREATE TABLE IF NOT EXISTS stores (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(150)  NOT NULL,
  location    VARCHAR(200),
  phone       VARCHAR(20),
  email       VARCHAR(150),
  is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Add store_id column to users table if it doesn't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE SET NULL;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_users_store_id ON users(store_id);

-- Create default store if none exists
INSERT INTO stores (name, location, phone) 
SELECT 'Default Store', 'Nairobi, Kenya', ''
WHERE NOT EXISTS (SELECT 1 FROM stores LIMIT 1);

-- Update existing users to reference the default store
UPDATE users 
SET store_id = (SELECT id FROM stores LIMIT 1) 
WHERE store_id IS NULL;

-- Add store_id to products table if it doesn't exist (for multi-store support)
ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);

-- Add store_id to sales table if it doesn't exist
ALTER TABLE sales ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sales_store_id ON sales(store_id);

-- Verify
DO $$
DECLARE
  store_count integer;
BEGIN
  SELECT COUNT(*) INTO store_count FROM stores;
  RAISE NOTICE 'Stores table created successfully. Total stores: %', store_count;
END $$;