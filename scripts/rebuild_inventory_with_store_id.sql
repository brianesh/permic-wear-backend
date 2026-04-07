-- ============================================
-- REBUILD SCRIPT WITH STORE_ID
-- Adds store_id column and populates with sample products
-- ============================================

-- Step 1: Add store_id column if it doesn't exist
DO $$ 
BEGIN 
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name = 'store_id'
  ) THEN
    ALTER TABLE products ADD COLUMN store_id INTEGER;
  END IF;
END $$;

-- Step 2: Add foreign key constraint if it doesn't exist
DO $$ 
BEGIN 
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'products_store_id_fkey' AND table_name = 'products'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_store_id_fkey 
    FOREIGN KEY (store_id) REFERENCES stores(id);
  END IF;
END $$;

-- Step 3: Create index for better performance
CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);

-- Step 4: Drop existing constraints if they exist
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_unique;

-- Step 5: Clear existing data
TRUNCATE TABLE sale_items CASCADE;
TRUNCATE TABLE sales CASCADE;
TRUNCATE TABLE tuma_transactions CASCADE;
TRUNCATE TABLE products CASCADE;
TRUNCATE TABLE sub_types CASCADE;
TRUNCATE TABLE brands CASCADE;

-- Step 6: Insert unique brands (skip if name already exists)
INSERT INTO brands (name, top_type, is_active, sort_order)
SELECT DISTINCT 
    brand,
    'shoes' as top_type,
    true as is_active,
    0 as sort_order
FROM (VALUES
    ('Santoni'),('Nike'),('Dior'),('Lacoste'),('Burberry'),
    ('Converse'),('Vans'),('Adidas'),('New Balance'),('Tommy'),('Runner'),
    ('SAMBA'),('Jordan'),('OGEIY'),('Temple'),('Naked Wolf')
) AS b(brand)
WHERE brand IS NOT NULL AND brand != ''
  AND NOT EXISTS (SELECT 1 FROM brands WHERE brands.name = b.brand);

-- Step 7: Insert sub_types
INSERT INTO sub_types (brand_id, name, is_active, sort_order)
SELECT 
    b.id as brand_id,
    p.category as name,
    true as is_active,
    0 as sort_order
FROM (
    SELECT DISTINCT brand, category 
    FROM (VALUES
        ('Santoni','Santoni Milano'),
        ('Nike','Airforce 1'),
        ('Nike','Customized Airforce'),
        ('Nike','TN'),
        ('Nike','Nike Airmax'),
        ('Naked Wolf','Naked Wolf'),
        ('Dior','DIOR'),
        ('Lacoste','LACOSTE'),
        ('Burberry','BURBERRY'),
        ('Converse','Converse Material'),
        ('Converse','Blue'),
        ('Converse','Blue/Black'),
        ('Converse','Converse Leather'),
        ('Vans','Condry'),
        ('Vans','Maroon Red'),
        ('Vans','Black/White'),
        ('Vans','Grey/White'),
        ('Vans','Black'),
        ('Vans','Nylon'),
        ('Vans','Floural Black'),
        ('Vans','Black Maroon'),
        ('Adidas','CAMPUS'),
        ('New Balance','White Blue Navy'),
        ('New Balance','White Pink'),
        ('Tommy','Black'),
        ('Tommy','White'),
        ('Runner','Light Grey'),
        ('SAMBA','Double Sole'),
        ('SAMBA','Single Sole'),
        ('Jordan','J3'),
        ('Jordan','J9'),
        ('Jordan','Jordan Lx'),
        ('OGEIY','Brown'),
        ('OGEIY','Blue'),
        ('Temple','White')
    ) AS p(brand, category)
) p
JOIN brands b ON b.name = p.brand
WHERE NOT EXISTS (
    SELECT 1 FROM sub_types st 
    WHERE st.brand_id = b.id AND st.name = p.category
);

-- Step 8: Insert products with store_id = 1 (default store)
INSERT INTO products (
    name, brand, brand_id, sub_type_id, top_type, category, color, 
    size, sku, stock, min_price, is_active, store_id
)
SELECT 
    p.name,
    p.brand,
    b.id as brand_id,
    st.id as sub_type_id,
    'shoes' as top_type,
    p.category,
    p.color,
    p.size,
    p.sku,
    p.stock,
    p.min_price,
    true as is_active,
    1 as store_id  -- Assign to store 1
FROM (VALUES
    -- Santoni Milano
    ('Santoni Milano','Santoni','Santoni Milano','42','White','SNT-SM-W42',1,3300),
    ('Santoni Milano Brown','Santoni','Santoni Milano','40','Brown','SNT-SM-BR40',1,3300),
    ('Santoni Milano Brown','Santoni','Santoni Milano','41','Brown','SNT-SM-BR41',1,3300),
    ('Santoni Milano Brown','Santoni','Santoni Milano','42','Brown','SNT-SM-BR42',1,3300),
    ('Santoni Milano Brown','Santoni','Santoni Milano','43','Brown','SNT-SM-BR43',1,3300),
    ('Santoni Milano Brown','Santoni','Santoni Milano','44','Brown','SNT-SM-BR44',1,3300),
    ('Santoni Milano Brown','Santoni','Santoni Milano','45','Brown','SNT-SM-BR45',1,3300),
    ('Santoni Milano White/Black','Santoni','Santoni Milano','40','White/Black','SNT-SM-WB40',1,3300),
    ('Santoni Milano White/Black','Santoni','Santoni Milano','41','White/Black','SNT-SM-WB41',1,3300),
    ('Santoni Milano White/Black','Santoni','Santoni Milano','42','White/Black','SNT-SM-WB42',1,3300),
    ('Santoni Milano White/Black','Santoni','Santoni Milano','43','White/Black','SNT-SM-WB43',1,3300),
    ('Santoni Milano White/Black','Santoni','Santoni Milano','44','White/Black','SNT-SM-WB44',1,3300),
    ('Santoni Milano White/Black','Santoni','Santoni Milano','45','White/Black','SNT-SM-WB45',1,3300),
    ('Santoni Milano Cream','Santoni','Santoni Milano','40','Cream','SNT-SM-CR40',1,3300),
    ('Santoni Milano Cream','Santoni','Santoni Milano','41','Cream','SNT-SM-CR41',1,3300),
    ('Santoni Milano Cream','Santoni','Santoni Milano','42','Cream','SNT-SM-CR42',1,3300),
    ('Santoni Milano Cream','Santoni','Santoni Milano','43','Cream','SNT-SM-CR43',1,3300),
    ('Santoni Milano Cream','Santoni','Santoni Milano','44','Cream','SNT-SM-CR44',1,3300),
    ('Santoni Milano Black','Santoni','Santoni Milano','40','Black','SNT-SM-BK40',1,3300),
    ('Santoni Milano Black','Santoni','Santoni Milano','41','Black','SNT-SM-BK41',1,3300),
    ('Santoni Milano Black','Santoni','Santoni Milano','42','Black','SNT-SM-BK42',1,3300),
    ('Santoni Milano Black','Santoni','Santoni Milano','43','Black','SNT-SM-BK43',1,3300),
    ('Santoni Milano Black','Santoni','Santoni Milano','44','Black','SNT-SM-BK44',1,3300),
    ('Santoni Milano Black','Santoni','Santoni Milano','45','Black','SNT-SM-BK45',1,3300),
    ('Santoni Milano Green','Santoni','Santoni Milano','42','Green','SNT-SM-GR42',1,3300),
    ('Santoni Milano Green','Santoni','Santoni Milano','44','Green','SNT-SM-GR44',1,3300),
    ('Santoni Milano Grey','Santoni','Santoni Milano','44','Grey','SNT-SM-GY44',1,3300),
    
    -- Nike Airforce 1
    ('Nike Airforce 1 Black','Nike','Airforce 1','36','Black','NK-AF1-BK36',1,2300),
    ('Nike Airforce 1 Black','Nike','Airforce 1','37','Black','NK-AF1-BK37',1,2300),
    ('Nike Airforce 1 Black','Nike','Airforce 1','39','Black','NK-AF1-BK39',1,2300),
    ('Nike Airforce 1 Black','Nike','Airforce 1','42','Black','NK-AF1-BK42',1,2300),
    ('Nike Airforce 1 Black','Nike','Airforce 1','43','Black','NK-AF1-BK43',1,2300),
    ('Nike Airforce 1 Black','Nike','Airforce 1','44','Black','NK-AF1-BK44',1,2300),
    ('Nike Airforce 1 Black','Nike','Airforce 1','45','Black','NK-AF1-BK45',1,2300),
    ('Nike Airforce 1 White','Nike','Airforce 1','38','White','NK-AF1-W38',1,2300),
    ('Nike Airforce 1 White','Nike','Airforce 1','39','White','NK-AF1-W39',1,2300),
    ('Nike Airforce 1 White','Nike','Airforce 1','40','White','NK-AF1-W40',1,2300),
    ('Nike Airforce 1 White','Nike','Airforce 1','42','White','NK-AF1-W42',1,2300),
    ('Nike Airforce 1 White','Nike','Airforce 1','44','White','NK-AF1-W44',1,2300),
    ('Nike Airforce 1 White','Nike','Airforce 1','45','White','NK-AF1-W45',1,2300),
    
    -- Nike Customized Airforce
    ('Nike Customized Airforce Givenchy','Nike','Customized Airforce','40','Givenchy','NK-CAF-GV40',1,3300),
    ('Nike Customized Airforce Givenchy','Nike','Customized Airforce','41','Givenchy','NK-CAF-GV41',1,3300),
    ('Nike Customized Airforce Givenchy','Nike','Customized Airforce','42','Givenchy','NK-CAF-GV42',1,3300),
    ('Nike Customized Airforce Givenchy','Nike','Customized Airforce','43','Givenchy','NK-CAF-GV43',1,3300),
    ('Nike Customized Airforce Givenchy','Nike','Customized Airforce','44','Givenchy','NK-CAF-GV44',1,3300),
    ('Nike Customized Airforce Burberry','Nike','Customized Airforce','40','Burberry','NK-CAF-BB40',1,3300),
    ('Nike Customized Airforce Burberry','Nike','Customized Airforce','41','Burberry','NK-CAF-BB41',1,3300),
    ('Nike Customized Airforce Burberry','Nike','Customized Airforce','42','Burberry','NK-CAF-BB42',1,3300),
    ('Nike Customized Airforce Burberry','Nike','Customized Airforce','44','Burberry','NK-CAF-BB44',1,3300),
    ('Nike Customized Airforce Black/White','Nike','Customized Airforce','40','Black/White','NK-CAF-BW40',1,3300),
    ('Nike Customized Airforce Green','Nike','Customized Airforce','39','Green','NK-CAF-GN39',1,3300),
    ('Nike Customized Airforce Dior','Nike','Customized Airforce','38','Dior','NK-CAF-DR38',1,3300),
    ('Nike Customized Airforce White/Blue','Nike','Customized Airforce','40','White/Blue','NK-CAF-WB40',1,3300),
    ('Nike Customized Airforce Peach','Nike','Customized Airforce','40','Peach','NK-CAF-PC40',1,3300),
    
    -- Nike TN
    ('Nike TN Black-Gold','Nike','TN','45','Black-Gold','NK-TN-BG45',1,3300),
    ('Nike TN Black-Red','Nike','TN','40','Black-Red','NK-TN-BR40',1,3300),
    ('Nike TN Black-White','Nike','TN','40','Black-White','NK-TN-BW40',1,3300),
    ('Nike TN White-Black','Nike','TN','44','White-Black','NK-TN-WB44',1,3300),
    
    -- Dior
    ('Dior DIOR Black','Dior','DIOR','40','Black','DR-DR-BK40',1,3300),
    ('Dior DIOR White/Navy','Dior','DIOR','40','White/Navy','DR-DR-WN40',1,3300),
    
    -- Nike Airmax
    ('Nike Airmax Black','Nike','Nike Airmax','38','Black','NK-AM-BK38',1,3300),
    ('Nike Airmax Black','Nike','Nike Airmax','39','Black','NK-AM-BK39',1,3300),
    ('Nike Airmax Black','Nike','Nike Airmax','40','Black','NK-AM-BK40',1,3300),
    ('Nike Airmax Black','Nike','Nike Airmax','41','Black','NK-AM-BK41',1,3300),
    ('Nike Airmax Black','Nike','Nike Airmax','42','Black','NK-AM-BK42',1,3300),
    ('Nike Airmax Black','Nike','Nike Airmax','43','Black','NK-AM-BK43',1,3300),
    ('Nike Airmax Black','Nike','Nike Airmax','44','Black','NK-AM-BK44',1,3300),
    ('Nike Airmax Black','Nike','Nike Airmax','45','Black','NK-AM-BK45',1,3300),
    ('Nike Airmax Grey','Nike','Nike Airmax','40','Grey','NK-AM-GY40',1,3300),
    ('Nike Airmax White/Green','Nike','Nike Airmax','36','White/Green','NK-AM-WG36',1,3300),
    
    -- Naked Wolf
    ('Naked Wolf Naked Wolf Black','Naked Wolf','Naked Wolf','40','Black','NW-NW-BK40',1,3300),
    ('Naked Wolf Naked Wolf Black','Naked Wolf','Naked Wolf','41','Black','NW-NW-BK41',1,3300),
    ('Naked Wolf Naked Wolf Blue','Naked Wolf','Naked Wolf','40','Blue','NW-NW-BL40',1,3300),
    
    -- Lacoste
    ('Lacoste LACOSTE Brown','Lacoste','LACOSTE','43','Brown','LC-LC-BR43',1,3300),
    ('Lacoste LACOSTE Brown','Lacoste','LACOSTE','44','Brown','LC-LC-BR44',1,3300),
    ('Lacoste LACOSTE Black','Lacoste','LACOSTE','42','Black','LC-LC-BK42',1,3300),
    ('Lacoste LACOSTE Blue','Lacoste','LACOSTE','42','Blue','LC-LC-BL42',1,3300),
    ('Lacoste LACOSTE Grey','Lacoste','LACOSTE','41','Grey','LC-LC-GY41',1,3300),
    ('Lacoste LACOSTE Grey','Lacoste','LACOSTE','43','Grey','LC-LC-GY43',1,3300),
    
    -- Burberry
    ('Burberry BURBERRY Black','Burberry','BURBERRY','41','Black','BB-BB-BK41',1,3300),
    
    -- Converse Material
    ('Converse Converse Material Black','Converse','Converse Material','38','Black','CV-CM-BK38',1,1200),
    ('Converse Converse Material Black','Converse','Converse Material','40','Black','CV-CM-BK40',1,1200),
    ('Converse Converse Material Black','Converse','Converse Material','42','Black','CV-CM-BK42',1,1200),
    ('Converse Converse Material White','Converse','Converse Material','37','White','CV-CM-W37',1,1200),
    ('Converse Converse Material White','Converse','Converse Material','40','White','CV-CM-W40',1,1200),
    ('Converse Converse Material White','Converse','Converse Material','42','White','CV-CM-W42',1,1200),
    ('Converse Converse Material White','Converse','Converse Material','43','White','CV-CM-W43',1,1200),
    ('Converse Converse Material White','Converse','Converse Material','44','White','CV-CM-W44',1,1200),
    
    -- Vans Condry
    ('Vans Condry Grey','Vans','Condry','38','Grey','VN-CD-GY38',1,1600),
    ('Vans Condry Grey','Vans','Condry','39','Grey','VN-CD-GY39',1,1600),
    ('Vans Condry Grey','Vans','Condry','40','Grey','VN-CD-GY40',1,1600),
    ('Vans Condry Grey','Vans','Condry','42','Grey','VN-CD-GY42',1,1600),
    ('Vans Condry Grey','Vans','Condry','43','Grey','VN-CD-GY43',1,1600),
    ('Vans Condry Grey','Vans','Condry','44','Grey','VN-CD-GY44',1,1600),
    ('Vans Condry Grey','Vans','Condry','45','Grey','VN-CD-GY45',1,1600),
    ('Vans Condry Grey','Vans','Condry','46','Grey','VN-CD-GY46',1,1600),
    ('Vans Condry Grey/Black','Vans','Condry','38','Grey/Black','VN-CD-GB38',1,1600),
    ('Vans Condry Grey/Black','Vans','Condry','39','Grey/Black','VN-CD-GB39',1,1600),
    ('Vans Condry Grey/Black','Vans','Condry','44','Grey/Black','VN-CD-GB44',1,1600),
    ('Vans Condry Brown/Black','Vans','Condry','39','Brown/Black','VN-CD-BB39',1,1600),
    ('Vans Condry Brown/Black','Vans','Condry','40','Brown/Black','VN-CD-BB40',1,1600),
    ('Vans Condry Brown/Black','Vans','Condry','41','Brown/Black','VN-CD-BB41',1,1600),
    ('Vans Condry Brown/Black','Vans','Condry','42','Brown/Black','VN-CD-BB42',1,1600),
    ('Vans Condry Brown/Black','Vans','Condry','43','Brown/Black','VN-CD-BB43',1,1600),
    ('Vans Condry Brown/Black','Vans','Condry','46','Brown/Black','VN-CD-BB46',1,1600),
    
    -- Vans Maroon Red
    ('Vans Maroon Red Black','Vans','Maroon Red','38','Black','VN-MR-BK38',1,1500),
    ('Vans Maroon Red Black','Vans','Maroon Red','39','Black','VN-MR-BK39',1,1500),
    ('Vans Maroon Red Black','Vans','Maroon Red','42','Black','VN-MR-BK42',1,1500),
    ('Vans Maroon Red Black','Vans','Maroon Red','43','Black','VN-MR-BK43',1,1500),
    ('Vans Maroon Red Black','Vans','Maroon Red','44','Black','VN-MR-BK44',1,1500),
    ('Vans Maroon Red Black','Vans','Maroon Red','45','Black','VN-MR-BK45',1,1500),
    ('Vans Maroon Red Black','Vans','Maroon Red','46','Black','VN-MR-BK46',1,1500),
    
    -- Converse Blue
    ('Converse Blue','Converse','Blue','38','Blue','CV-BL-38',1,1500),
    ('Converse Blue','Converse','Blue','39','Blue','CV-BL-39',1,1500),
    ('Converse Blue','Converse','Blue','40','Blue','CV-BL-40',1,1500),
    ('Converse Blue','Converse','Blue','41','Blue','CV-BL-41',1,1500),
    ('Converse Blue','Converse','Blue','42','Blue','CV-BL-42',1,1500),
    ('Converse Blue','Converse','Blue','43','Blue','CV-BL-43',1,1500),
    ('Converse Blue','Converse','Blue','44','Blue','CV-BL-44',1,1500),
    ('Converse Blue','Converse','Blue','45','Blue','CV-BL-45',1,1500),
    ('Converse Blue','Converse','Blue','46','Blue','CV-BL-46',1,1500),
    ('Converse Blue/Black','Converse','Blue/Black','44','Blue/Black','CV-BB-44',1,1500),
    ('Converse Blue/Black','Converse','Blue/Black','45','Blue/Black','CV-BB-45',1,1500),
    
    -- Vans various
    ('Vans Black/White','Vans','Black/White','38','Black/White','VN-BW-38',1,1500),
    ('Vans Grey/White','Vans','Grey/White','29','Grey/White','VN-GW-29',1,1500),
    ('Vans Grey/White','Vans','Grey/White','39','Grey/White','VN-GW-39',1,1500),
    ('Vans Black','Vans','Black','38','Black','VN-BK-38',1,1500),
    ('Vans Black','Vans','Black','39','Black','VN-BK-39',1,1500),
    ('Vans Nylon','Vans','Nylon','38','Nylon','VN-NY-38',1,1500),
    ('Vans Floural Black','Vans','Floural Black','38','Floural Black','VN-FB-38',1,1500),
    ('Vans Black Maroon','Vans','Black Maroon','38','Black Maroon','VN-BM-38',1,1500),
    
    -- Adidas Campus
    ('Adidas CAMPUS White','Adidas','CAMPUS','40','White','AD-CM-W40',1,3300),
    ('Adidas CAMPUS White','Adidas','CAMPUS','41','White','AD-CM-W41',1,3300),
    ('Adidas CAMPUS White','Adidas','CAMPUS','42','White','AD-CM-W42',1,3300),
    ('Adidas CAMPUS Brown','Adidas','CAMPUS','38','Brown','AD-CM-BR38',1,3300),
    
    -- New Balance
    ('New Balance White Blue Navy','New Balance','White Blue Navy','42','White Blue Navy','NB-WBN-42',1,3300),
    ('New Balance White Pink','New Balance','White Pink','39','White Pink','NB-WP-39',1,3300),
    
    -- Converse Leather
    ('Converse Converse Leather White','Converse','Converse Leather','37','White','CV-CL-W37',1,1500),
    ('Converse Converse Leather White','Converse','Converse Leather','39','White','CV-CL-W39',1,1500),
    ('Converse Converse Leather White','Converse','Converse Leather','41','White','CV-CL-W41',1,1500),
    ('Converse Converse Leather White','Converse','Converse Leather','42','White','CV-CL-W42',1,1500),
    ('Converse Converse Leather White','Converse','Converse Leather','43','White','CV-CL-W43',1,1500),
    ('Converse Converse Leather White','Converse','Converse Leather','44','White','CV-CL-W44',1,1500),
    ('Converse Converse Leather Maroon','Converse','Converse Leather','37','Maroon','CV-CL-M37',1,1500),
    ('Converse Converse Leather Maroon','Converse','Converse Leather','39','Maroon','CV-CL-M39',1,1500),
    ('Converse Converse Leather Maroon','Converse','Converse Leather','40','Maroon','CV-CL-M40',1,1500),
    ('Converse Converse Leather Maroon','Converse','Converse Leather','42','Maroon','CV-CL-M42',1,1500),
    ('Converse Converse Leather Maroon','Converse','Converse Leather','44','Maroon','CV-CL-M44',1,1500),
    ('Converse Converse Leather Grey','Converse','Converse Leather','37','Grey','CV-CL-G37',1,1500),
    ('Converse Converse Leather Grey','Converse','Converse Leather','39','Grey','CV-CL-G39',1,1500),
    
    -- Tommy
    ('Tommy Black','Tommy','Black','40','Black','TM-BK-40',1,3300),
    ('Tommy White','Tommy','White','40','White','TM-W-40',1,3300),
    
    -- Runner
    ('Runner Light Grey','Runner','Light Grey','43','Light Grey','RN-LG-43',1,3300),
    
    -- SAMBA
    ('SAMBA Double Sole Black','SAMBA','Double Sole','40','Black','SB-DS-BK40',1,3300),
    ('SAMBA Double Sole White','SAMBA','Double Sole','37','White','SB-DS-W37',1,3300),
    ('SAMBA Single Sole White/Green','SAMBA','Single Sole','40','White/Green','SB-SS-WG40',1,3300),
    ('SAMBA Single Sole White/Green','SAMBA','Single Sole','41','White/Green','SB-SS-WG41',1,3300),
    ('SAMBA Single Sole White/Sky Blue','SAMBA','Single Sole','38','White/Sky Blue','SB-SS-WSB38',1,3300),
    ('SAMBA Single Sole White/Sky Blue','SAMBA','Single Sole','41','White/Sky Blue','SB-SS-WSB41',1,3300),
    ('SAMBA Single Sole Pink/White','SAMBA','Single Sole','36','Pink/White','SB-SS-PW36',1,3300),
    ('SAMBA Single Sole Pink/White','SAMBA','Single Sole','39','Pink/White','SB-SS-PW39',1,3300),
    ('SAMBA Single Sole Pink/White','SAMBA','Single Sole','40','Pink/White','SB-SS-PW40',1,3300),
    
    -- Jordan
    ('Jordan J3 Grey','Jordan','J3','37','Grey','JR-J3-G37',1,3300),
    ('Jordan J3 Pink/White','Jordan','J3','37','Pink/White','JR-J3-PW37',1,3300),
    ('Jordan J9 Black/White A2','Jordan','J9','0','Black/White A2','JR-J9-BWA2',1,3300),
    ('Jordan Jordan Lx Black/Green','Jordan','Jordan Lx','41','Black/Green','JR-JL-BG41',1,3300),
    
    -- OGEIY
    ('OGEIY Brown','OGEIY','Brown','41','Brown','OG-BR-41',1,3300),
    ('OGEIY Brown','OGEIY','Brown','44','Brown','OG-BR-44',1,3300),
    ('OGEIY Blue','OGEIY','Blue','40','Blue','OG-BL-40',1,3300),
    
    -- Temple
    ('Temple White','Temple','White','44','White','TP-W-44',1,3300)
) AS p(name, brand, category, size, color, sku, stock, min_price)
JOIN brands b ON b.name = p.brand
JOIN sub_types st ON st.brand_id = b.id AND st.name = p.category;

-- Step 9: Add the unique constraint back
ALTER TABLE products ADD CONSTRAINT products_sku_unique UNIQUE (sku);

-- Step 10: Verify all data was inserted
SELECT 'Brands Count: ' || COUNT(*) FROM brands;
SELECT 'Sub Types Count: ' || COUNT(*) FROM sub_types;
SELECT 'Products Count: ' || COUNT(*) FROM products;
SELECT 'Products with store_id = 1: ' || COUNT(*) FROM products WHERE store_id = 1;

-- Step 11: Show sample
SELECT p.id, p.name, p.brand, p.size, p.color, p.sku, p.stock, p.min_price, p.store_id
FROM products p
LIMIT 10;