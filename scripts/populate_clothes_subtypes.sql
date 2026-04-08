-- Populate sub_types for clothes categories
-- This creates the sub-category hierarchy for clothes like Trousers → Jeans, Khaki, etc.

-- First, let's check what clothes brands exist
-- SELECT id, name, top_type FROM brands WHERE top_type = 'clothes' ORDER BY name;

-- For "Trousers" brand, add sub-types: Jeans, Khaki, Material, Cargo, Chinos
INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Jeans', 1, true
FROM brands b WHERE b.name = 'Trousers' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Khaki', 2, true
FROM brands b WHERE b.name = 'Trousers' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Material', 3, true
FROM brands b WHERE b.name = 'Trousers' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Cargo', 4, true
FROM brands b WHERE b.name = 'Trousers' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Chinos', 5, true
FROM brands b WHERE b.name = 'Trousers' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

-- For "Shorts" brand, add sub-types
INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Casual Shorts', 1, true
FROM brands b WHERE b.name = 'Shorts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Sports Shorts', 2, true
FROM brands b WHERE b.name = 'Shorts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Bermuda', 3, true
FROM brands b WHERE b.name = 'Shorts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

-- For "T-Shirts" brand, add sub-types
INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Polo', 1, true
FROM brands b WHERE b.name = 'T-Shirts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Crew Neck', 2, true
FROM brands b WHERE b.name = 'T-Shirts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'V-Neck', 3, true
FROM brands b WHERE b.name = 'T-Shirts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Graphic Tees', 4, true
FROM brands b WHERE b.name = 'T-Shirts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

-- For "Shirts" brand, add sub-types
INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Slim Fit', 1, true
FROM brands b WHERE b.name = 'Shirts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Regular Fit', 2, true
FROM brands b WHERE b.name = 'Shirts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Casual', 3, true
FROM brands b WHERE b.name = 'Shirts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO sub_types (brand_id, name, sort_order, is_active)
SELECT b.id, 'Formal', 4, true
FROM brands b WHERE b.name = 'Shirts' AND b.top_type = 'clothes'
ON CONFLICT DO NOTHING;

-- Verify the sub-types were created
SELECT st.id, b.name as brand_name, st.name as sub_type_name, st.sort_order
FROM sub_types st
JOIN brands b ON st.brand_id = b.id
WHERE b.top_type = 'clothes'
ORDER BY b.name, st.sort_order;