-- ================================================================
-- Permic Men's Wear — PostgreSQL Schema (Supabase)
-- Run this in Supabase SQL Editor: Dashboard → SQL Editor → New query
-- ================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(100)  NOT NULL,
  email           VARCHAR(150)  NOT NULL UNIQUE,
  password_hash   VARCHAR(255)  NOT NULL,
  role            VARCHAR(20)   NOT NULL DEFAULT 'cashier' CHECK (role IN ('super_admin','admin','cashier')),
  avatar          VARCHAR(10)   NOT NULL DEFAULT 'U',
  status          VARCHAR(20)   NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  commission_rate DECIMAL(5,2)  NOT NULL DEFAULT 10.00,
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Brands table
CREATE TABLE IF NOT EXISTS brands (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(80)  NOT NULL,
  top_type   VARCHAR(20)  NOT NULL CHECK (top_type IN ('shoes','clothes')),
  photo_url  TEXT,
  sort_order INT          NOT NULL DEFAULT 0,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (name, top_type)
);

-- Sub-types table
CREATE TABLE IF NOT EXISTS sub_types (
  id         SERIAL PRIMARY KEY,
  brand_id   INT          NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name       VARCHAR(80)  NOT NULL,
  photo_url  TEXT,
  sort_order INT          NOT NULL DEFAULT 0,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (brand_id, name)
);

-- Products table
CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(150)  NOT NULL,
  brand         VARCHAR(80)   NOT NULL,
  brand_id      INT           REFERENCES brands(id)    ON DELETE SET NULL,
  sub_type_id   INT           REFERENCES sub_types(id) ON DELETE SET NULL,
  top_type      VARCHAR(20)   NOT NULL DEFAULT 'shoes' CHECK (top_type IN ('shoes','clothes')),
  category      VARCHAR(80)   NOT NULL DEFAULT 'Lifestyle',
  color         VARCHAR(80)   NOT NULL DEFAULT '',
  size          VARCHAR(10)   NOT NULL,
  sku           VARCHAR(50)   NOT NULL UNIQUE,
  stock         INT           NOT NULL DEFAULT 0,
  min_price     DECIMAL(10,2) NOT NULL,
  days_in_stock INT           NOT NULL DEFAULT 0,
  photo_url     TEXT,
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_sku      ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_brand    ON products(brand);
CREATE INDEX IF NOT EXISTS idx_products_stock    ON products(stock);
CREATE INDEX IF NOT EXISTS idx_products_top_type ON products(top_type);

-- Sales table
CREATE TABLE IF NOT EXISTS sales (
  id              SERIAL PRIMARY KEY,
  txn_id          VARCHAR(20)   NOT NULL UNIQUE,
  cashier_id      INT           NOT NULL REFERENCES users(id),
  payment_method  VARCHAR(10)   NOT NULL CHECK (payment_method IN ('Cash','M-Pesa','Split')),
  selling_total   DECIMAL(10,2) NOT NULL,
  amount_paid     DECIMAL(10,2) NOT NULL DEFAULT 0,
  change_given    DECIMAL(10,2) NOT NULL DEFAULT 0,
  extra_profit    DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission      DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission_rate DECIMAL(5,2)  NOT NULL DEFAULT 10,
  mpesa_ref       VARCHAR(50),
  mpesa_phone     VARCHAR(20),
  status          VARCHAR(20)   NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('completed','pending_mpesa','pending_cash','pending_split','failed')),
  sale_date       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_cashier   ON sales(cashier_id);
CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_status    ON sales(status);

-- Sale items
CREATE TABLE IF NOT EXISTS sale_items (
  id            SERIAL PRIMARY KEY,
  sale_id       INT           NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id    INT           NOT NULL REFERENCES products(id),
  product_name  VARCHAR(150)  NOT NULL,
  sku           VARCHAR(50)   NOT NULL,
  size          VARCHAR(10)   NOT NULL,
  qty           INT           NOT NULL,
  min_price     DECIMAL(10,2) NOT NULL,
  selling_price DECIMAL(10,2) NOT NULL,
  extra_profit  DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission    DECIMAL(10,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale    ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

-- M-Pesa transactions
CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id                  SERIAL PRIMARY KEY,
  sale_id             INT          NOT NULL REFERENCES sales(id),
  checkout_request_id VARCHAR(100) NOT NULL UNIQUE,
  merchant_request_id VARCHAR(100),
  phone               VARCHAR(20)  NOT NULL,
  amount              DECIMAL(10,2) NOT NULL,
  mpesa_ref           VARCHAR(50),
  result_code         INT,
  result_desc         VARCHAR(255),
  status              VARCHAR(20)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','success','failed','timeout')),
  initiated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  confirmed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mpesa_checkout ON mpesa_transactions(checkout_request_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_status   ON mpesa_transactions(status);

-- Activity logs
CREATE TABLE IF NOT EXISTS activity_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INT          NOT NULL REFERENCES users(id),
  user_name   VARCHAR(100) NOT NULL,
  user_role   VARCHAR(20)  NOT NULL,
  action      VARCHAR(80)  NOT NULL,
  target      VARCHAR(200),
  detail      TEXT,
  category    VARCHAR(20)  NOT NULL DEFAULT 'general'
                CHECK (category IN ('auth','sale','inventory','users','settings','general')),
  ip_address  VARCHAR(45),
  logged_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_user     ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_category ON activity_logs(category);
CREATE INDEX IF NOT EXISTS idx_logs_logged   ON activity_logs(logged_at);

-- Settings (key-value store)
CREATE TABLE IF NOT EXISTS settings (
  id          SERIAL PRIMARY KEY,
  key_name    VARCHAR(80)  NOT NULL UNIQUE,
  key_value   TEXT,
  updated_by  INT          REFERENCES users(id),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on products and sales
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Default brand seeds
INSERT INTO brands (name, top_type, sort_order) VALUES
  ('Nike','shoes',1),('Adidas','shoes',2),('Jordan','shoes',3),
  ('Puma','shoes',4),('New Balance','shoes',5),('Converse','shoes',6),
  ('Vans','shoes',7),('Reebok','shoes',8),
  ('Shirts','clothes',1),('T-Shirts','clothes',2),('Vests','clothes',3),
  ('Belts','clothes',4),('Trousers','clothes',5),('Shorts','clothes',6),
  ('Jeans','clothes',7),('Hoodies','clothes',8),('Jackets','clothes',9),
  ('Caps','clothes',10),('Tracksuits','clothes',11)
ON CONFLICT (name, top_type) DO NOTHING;

-- Nike sub-types
INSERT INTO sub_types (brand_id, name, sort_order)
SELECT b.id, s.name, s.ord FROM brands b
JOIN (VALUES
  ('Nike','Air Force 1',1),('Nike','Air Max',2),('Nike','Dunk',3),
  ('Nike','Blazer',4),('Nike','React',5),('Nike','Pegasus',6),('Nike','Cortez',7),
  ('Jordan','Jordan 1',1),('Jordan','Jordan 4',2),('Jordan','Jordan 11',3),
  ('Adidas','Superstar',1),('Adidas','Stan Smith',2),('Adidas','NMD',3),
  ('Adidas','Ultraboost',4),('Adidas','Gazelle',5),
  ('Puma','Suede',1),('Puma','RS-X',2),('Puma','Clyde',3),
  ('New Balance','574',1),('New Balance','990',2),('New Balance','993',3),
  ('Converse','Chuck Taylor All Star',1),('Converse','Run Star',2),
  ('Vans','Old Skool',1),('Vans','Sk8-Hi',2),
  ('Reebok','Classic Leather',1),('Reebok','Club C 85',2)
) AS s(brand_name, name, ord) ON b.name = s.brand_name AND b.top_type = 'shoes'
ON CONFLICT (brand_id, name) DO NOTHING;

-- Default settings
INSERT INTO settings (key_name, key_value) VALUES
  ('currency','KES'),
  ('timezone','Africa/Nairobi'),
  ('commission_rate','10'),
  ('low_stock_threshold','5'),
  ('aging_days','60'),
  ('sms_alerts','true'),
  ('email_alerts','true'),
  ('mpesa_env','production')
ON CONFLICT (key_name) DO NOTHING;
