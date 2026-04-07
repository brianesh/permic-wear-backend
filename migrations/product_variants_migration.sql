-- ═══════════════════════════════════════════════════════════════════
-- Product Variants Migration
-- Add parent_id to group product variants (sizes) together
-- ═══════════════════════════════════════════════════════════════════

-- Step 1: Add parent_id column to products
ALTER TABLE products ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES products(id) ON DELETE CASCADE;

-- Step 2: Create index for performance
CREATE INDEX IF NOT EXISTS idx_products_parent_id ON products(parent_id);

-- Step 3: Create view to show product groups with variants
CREATE OR REPLACE VIEW product_groups AS
SELECT 
    p.id,
    p.parent_id,
    p.name,
    p.brand,
    p.brand_id,
    p.sub_type_id,
    p.top_type,
    p.category,
    p.color,
    p.size,
    p.sku,
    p.stock,
    p.min_price,
    p.photo_url,
    p.is_active,
    p.store_id,
    p.created_at,
    -- Get parent product info if this is a variant
    CASE WHEN p.parent_id IS NOT NULL THEN 
        (SELECT json_build_object(
            'id', parent.id,
            'name', parent.name,
            'brand', parent.brand,
            'color', parent.color
        ) FROM products parent WHERE parent.id = p.parent_id)
    ELSE NULL END as parent_info,
    -- Get all variants if this is a parent product
    CASE WHEN p.parent_id IS NULL THEN
        (SELECT json_agg(json_build_object(
            'id', v.id,
            'size', v.size,
            'sku', v.sku,
            'stock', v.stock,
            'min_price', v.min_price,
            'color', v.color
        ))
        FROM products v 
        WHERE v.parent_id = p.id AND v.is_active = TRUE)
    ELSE NULL END as variants
FROM products p
WHERE p.is_active = TRUE;

-- Step 4: Create function to group existing products by name+brand+color
CREATE OR REPLACE FUNCTION group_products_by_variant()
RETURNS void AS $$
DECLARE
    product_record RECORD;
    parent_id integer;
BEGIN
    -- For each unique combination of name, brand, color
    FOR product_record IN 
        SELECT DISTINCT name, brand, color, top_type
        FROM products 
        WHERE is_active = TRUE 
            AND parent_id IS NULL
            AND top_type = 'shoes'  -- Focus on shoes first
        GROUP BY name, brand, color, top_type
        HAVING COUNT(*) > 1  -- Only if multiple sizes exist
    LOOP
        -- Get the first product as parent (usually the one with most stock or middle size)
        SELECT id INTO parent_id
        FROM products
        WHERE name = product_record.name 
            AND brand = product_record.brand 
            AND color = product_record.color
            AND parent_id IS NULL
        ORDER BY stock DESC, id ASC
        LIMIT 1;
        
        -- Update all other products in this group to reference the parent
        UPDATE products
        SET parent_id = parent_id
        WHERE name = product_record.name 
            AND brand = product_record.brand 
            AND color = product_record.color
            AND id != parent_id
            AND parent_id IS NULL;
    END LOOP;
    
    RAISE NOTICE 'Product grouping completed';
END;
$$ LANGUAGE plpgsql;

-- Step 5: Create API-friendly view for inventory display
CREATE OR REPLACE VIEW inventory_display AS
SELECT 
    pg.id as parent_id,
    pg.name,
    pg.brand,
    pg.brand_id,
    pg.sub_type_id,
    pg.top_type,
    pg.category,
    pg.photo_url,
    pg.is_active,
    pg.store_id,
    -- Total stock across all variants
    COALESCE(pg.stock, 0) + COALESCE(
        (SELECT SUM(v.stock) FROM products v WHERE v.parent_id = pg.id AND v.is_active = TRUE), 0
    ) as total_stock,
    -- All variants as JSON array
    COALESCE(pg.variants, '[]'::json) || json_build_array(
        json_build_object(
            'id', pg.id,
            'size', pg.size,
            'sku', pg.sku,
            'stock', pg.stock,
            'min_price', pg.min_price,
            'color', pg.color
        )
    ) as all_variants,
    -- Count of variants
    1 + COALESCE(json_array_length(pg.variants), 0) as variant_count
FROM product_groups pg
WHERE pg.parent_id IS NULL  -- Only show parent products
ORDER BY pg.brand, pg.name, pg.color;

-- Step 6: Create indexes for inventory display performance
CREATE INDEX IF NOT EXISTS idx_products_grouping ON products(name, brand, color, parent_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_products_inventory ON products(top_type, brand_id, sub_type_id, is_active) WHERE parent_id IS NULL;

-- Step 7: Verify migration
DO $$
DECLARE
    parent_count integer;
    variant_count integer;
BEGIN
    SELECT COUNT(*) INTO parent_count FROM products WHERE parent_id IS NULL AND is_active = TRUE;
    SELECT COUNT(*) INTO variant_count FROM products WHERE parent_id IS NOT NULL AND is_active = TRUE;
    
    RAISE NOTICE 'Migration complete: % parent products, % variants', parent_count, variant_count;
END $$;