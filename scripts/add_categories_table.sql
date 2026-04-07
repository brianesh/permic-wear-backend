-- Add categories table for clothes hierarchy
-- Structure: Category (Trousers, T-Shirts) → Sub-category (Jeans, Khaki) → Brand → Products

-- Step 1: Create categories table
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  top_type VARCHAR(20) NOT NULL, -- 'shoes' or 'clothes'
  description TEXT,
  photo_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Step 2: Create unique constraint on name + top_type
ALTER TABLE categories ADD CONSTRAINT categories_name_top_type_unique UNIQUE (name, top_type);

-- Step 3: Add category_id to brands table (optional, for sub-category grouping)
ALTER TABLE brands ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id);

-- Step 4: Insert default categories for clothes
INSERT INTO categories (name, top_type, description, sort_order) VALUES
  ('Trousers', 'clothes', 'All types of trousers', 1),
  ('T-Shirts', 'clothes', 'All types of t-shirts', 2),
  ('Shirts', 'clothes', 'All types of shirts', 3),
  ('Vests', 'clothes', 'All types of vests', 4)
ON CONFLICT (name, top_type) DO NOTHING;

-- Step 5: Insert default sub-categories (as brands with category_id)
-- For Trousers: Jeans, Khaki, Material
INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Jeans', 'clothes', c.id, 1 FROM categories c WHERE c.name = 'Trousers' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Khaki', 'clothes', c.id, 2 FROM categories c WHERE c.name = 'Trousers' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Material', 'clothes', c.id, 3 FROM categories c WHERE c.name = 'Trousers' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

-- For T-Shirts: Polo, Crew Neck, V-Neck
INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Polo', 'clothes', c.id, 1 FROM categories c WHERE c.name = 'T-Shirts' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Crew Neck', 'clothes', c.id, 2 FROM categories c WHERE c.name = 'T-Shirts' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'V-Neck', 'clothes', c.id, 3 FROM categories c WHERE c.name = 'T-Shirts' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

-- For Shirts: Slim Fit, Regular, Casual
INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Slim Fit', 'clothes', c.id, 1 FROM categories c WHERE c.name = 'Shirts' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Regular', 'clothes', c.id, 2 FROM categories c WHERE c.name = 'Shirts' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Casual', 'clothes', c.id, 3 FROM categories c WHERE c.name = 'Shirts' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

-- For Vests: Tank, Compression, Sleeveless
INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Tank', 'clothes', c.id, 1 FROM categories c WHERE c.name = 'Vests' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

INSERT INTO brands (name, top_type, category_id, sort_order) 
SELECT 'Compression', 'clothes', c.id, 2 FROM categories c WHERE c.name = 'Vests' AND c.top_type = 'clothes'
ON CONFLICT DO NOTHING;

-- Step 6: Create index
CREATE INDEX IF NOT EXISTS idx_categories_top_type ON categories(top_type);
CREATE INDEX IF NOT EXISTS idx_brands_category_id ON brands(category_id);

-- Step 7: Verify
SELECT 'Categories:' as info, COUNT(*) as count FROM categories;
SELECT 'Sub-categories (as brands with category_id):' as info, COUNT(*) as count FROM brands WHERE category_id IS NOT NULL;