-- ═══════════════════════════════════════════════════════════════════
-- Dynamic Categories Migration
-- Rebuild category hierarchy from products dynamically
-- ═══════════════════════════════════════════════════════════════════

-- Step 1: Clear existing static categories (brands and sub_types)
DELETE FROM sub_types;
DELETE FROM brands;

-- Reset sequences
ALTER SEQUENCE brands_id_seq RESTART WITH 1;
ALTER SEQUENCE sub_types_id_seq RESTART WITH 1;

-- Step 2: Rebuild brands from products
-- Extract unique brand names from products and assign top_type
INSERT INTO brands (name, top_type, sort_order, is_active, created_at)
SELECT DISTINCT 
    p.brand as name,
    p.top_type,
    ROW_NUMBER() OVER (ORDER BY p.brand) as sort_order,
    true as is_active,
    NOW() as created_at
FROM products p
WHERE p.is_active = TRUE 
    AND p.brand IS NOT NULL 
    AND p.brand != ''
ON CONFLICT (name, top_type) DO NOTHING;

-- Step 3: Update products with brand_id references
UPDATE products p
SET brand_id = b.id
FROM brands b
WHERE p.brand = b.name 
    AND p.top_type = b.top_type
    AND p.brand_id IS NULL;

-- Step 4: Rebuild sub_types from products
-- Extract unique product names as sub_types under their brands
INSERT INTO sub_types (brand_id, name, sort_order, is_active, created_at)
SELECT DISTINCT
    p.brand_id,
    p.name as sub_type_name,
    ROW_NUMBER() OVER (PARTITION BY p.brand_id ORDER BY p.name) as sort_order,
    true as is_active,
    NOW() as created_at
FROM products p
WHERE p.is_active = TRUE 
    AND p.brand_id IS NOT NULL
    AND p.sub_type_id IS NULL
ON CONFLICT (brand_id, name) DO NOTHING;

-- Step 5: Update products with sub_type_id references
UPDATE products p
SET sub_type_id = st.id
FROM sub_types st
WHERE p.name = st.name 
    AND p.brand_id = st.brand_id
    AND p.sub_type_id IS NULL;

-- Step 6: Create category view for dynamic hierarchy
CREATE OR REPLACE VIEW category_hierarchy AS
SELECT 
    b.id as brand_id,
    b.name as brand_name,
    b.top_type,
    st.id as sub_type_id,
    st.name as sub_type_name,
    COUNT(p.id) as product_count,
    SUM(p.stock) as total_stock
FROM brands b
LEFT JOIN sub_types st ON st.brand_id = b.id
LEFT JOIN products p ON p.sub_type_id = st.id AND p.is_active = TRUE
WHERE b.is_active = TRUE
GROUP BY b.id, b.name, b.top_type, st.id, st.name
ORDER BY b.top_type, b.sort_order, b.name, st.sort_order, st.name;

-- Step 7: Create function to rebuild categories from products
CREATE OR REPLACE FUNCTION rebuild_categories_from_products()
RETURNS void AS $$
BEGIN
    -- Clear and rebuild (same as steps above)
    DELETE FROM sub_types;
    DELETE FROM brands;
    
    ALTER SEQUENCE brands_id_seq RESTART WITH 1;
    ALTER SEQUENCE sub_types_id_seq RESTART WITH 1;
    
    INSERT INTO brands (name, top_type, sort_order, is_active, created_at)
    SELECT DISTINCT 
        p.brand,
        p.top_type,
        ROW_NUMBER() OVER (ORDER BY p.brand),
        true,
        NOW()
    FROM products p
    WHERE p.is_active = TRUE AND p.brand IS NOT NULL AND p.brand != ''
    ON CONFLICT (name, top_type) DO NOTHING;
    
    UPDATE products p
    SET brand_id = b.id
    FROM brands b
    WHERE p.brand = b.name AND p.top_type = b.top_type AND p.brand_id IS NULL;
    
    INSERT INTO sub_types (brand_id, name, sort_order, is_active, created_at)
    SELECT DISTINCT
        p.brand_id,
        p.name,
        ROW_NUMBER() OVER (PARTITION BY p.brand_id ORDER BY p.name),
        true,
        NOW()
    FROM products p
    WHERE p.is_active = TRUE AND p.brand_id IS NOT NULL AND p.sub_type_id IS NULL
    ON CONFLICT (brand_id, name) DO NOTHING;
    
    UPDATE products p
    SET sub_type_id = st.id
    FROM sub_types st
    WHERE p.name = st.name AND p.brand_id = st.brand_id AND p.sub_type_id IS NULL;
    
    RAISE NOTICE 'Categories rebuilt successfully from products';
END;
$$ LANGUAGE plpgsql;

-- Step 8: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_brands_top_type ON brands(top_type);
CREATE INDEX IF NOT EXISTS idx_sub_types_brand ON sub_types(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_sub_type_id ON products(sub_type_id);

-- Step 9: Verify migration
DO $$
DECLARE
    brand_count integer;
    subtype_count integer;
    product_count integer;
BEGIN
    SELECT COUNT(*) INTO brand_count FROM brands WHERE is_active = TRUE;
    SELECT COUNT(*) INTO subtype_count FROM sub_types WHERE is_active = TRUE;
    SELECT COUNT(*) INTO product_count FROM products WHERE is_active = TRUE;
    
    RAISE NOTICE 'Migration complete: % brands, % sub-types, % products', 
                 brand_count, subtype_count, product_count;
END $$;