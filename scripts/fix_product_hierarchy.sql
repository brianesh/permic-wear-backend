-- Fix Product Hierarchy: Use proper foreign keys instead of redundant string columns
-- Run this script to clean up the data model

-- Step 1: Update products with missing brand_id based on brand string name
UPDATE products p
SET brand_id = b.id
FROM brands b
WHERE p.brand_id IS NULL 
  AND b.name = p.brand
  AND b.top_type = p.top_type;

-- Step 2: Update products with missing sub_type_id based on category string name
UPDATE products p
SET sub_type_id = st.id
FROM sub_types st
JOIN brands b ON st.brand_id = b.id
WHERE p.sub_type_id IS NULL 
  AND st.name = p.category
  AND b.name = p.brand
  AND b.top_type = p.top_type;

-- Step 3: For clothes products without sub_types, create default sub_types
INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'General', 0, true
FROM brands b
LEFT JOIN sub_types st ON st.brand_id = b.id
WHERE b.top_type = 'clothes'
  AND st.id IS NULL
ON CONFLICT DO NOTHING;

-- Step 4: Update clothes products to use the default sub_type
UPDATE products p
SET sub_type_id = st.id
FROM sub_types st
JOIN brands b ON st.brand_id = b.id
WHERE p.sub_type_id IS NULL 
  AND p.top_type = 'clothes'
  AND b.top_type = 'clothes'
  AND st.name = 'General';

-- Step 5: Verify the fix
SELECT 
  'Products with brand_id' as check_type,
  COUNT(*) as count
FROM products 
WHERE brand_id IS NOT NULL

UNION ALL

SELECT 
  'Products with sub_type_id' as check_type,
  COUNT(*) as count
FROM products 
WHERE sub_type_id IS NOT NULL

UNION ALL

SELECT 
  'Products still with null brand_id' as check_type,
  COUNT(*) as count
FROM products 
WHERE brand_id IS NULL AND is_active = TRUE

UNION ALL

SELECT 
  'Products still with null sub_type_id' as check_type,
  COUNT(*) as count
FROM products 
WHERE sub_type_id IS NULL AND is_active = TRUE;

-- Step 6: (Optional) Remove redundant columns after verification
-- WARNING: Only run these after confirming all products have proper IDs
-- ALTER TABLE products DROP COLUMN brand;
-- ALTER TABLE products DROP COLUMN category;

-- Step 7: Create a view for easy product listing with proper joins
CREATE OR REPLACE VIEW products_with_categories AS
SELECT 
  p.*,
  b.name AS brand_name,
  b.top_type AS brand_top_type,
  st.name AS sub_type_name,
  st.id AS sub_type_id_check
FROM products p
LEFT JOIN brands b ON p.brand_id = b.id
LEFT JOIN sub_types st ON p.sub_type_id = st.id;

-- Usage: SELECT * FROM products_with_categories WHERE is_active = TRUE;