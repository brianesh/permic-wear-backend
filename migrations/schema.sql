-- ================================================================
-- Permic Men's Wear Database Schema v5
-- Run: node migrations/run.js
-- ================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100)  NOT NULL,
  email         VARCHAR(150)  NOT NULL UNIQUE,
  password_hash VARCHAR(255)  NOT NULL,
  role          ENUM('super_admin','admin','cashier') NOT NULL DEFAULT 'cashier',
  avatar        VARCHAR(10)   NOT NULL DEFAULT 'U',
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  commission_rate DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  last_login    DATETIME,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ── Category hierarchy ──────────────────────────────────────────
-- Level 1: top_type  = 'shoes' | 'clothes'  (fixed, not in DB)
-- Level 2: brands    e.g. Nike, Adidas, Shirts, T-Shirts …
-- Level 3: sub_types  e.g. Air Force 1, Dunk, Slim Fit …
-- Products belong to brand + sub_type

CREATE TABLE IF NOT EXISTS brands (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(80)  NOT NULL,
  top_type   ENUM('shoes','clothes') NOT NULL,
  photo_url  TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_brand_type (name, top_type)
);

CREATE TABLE IF NOT EXISTS sub_types (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  brand_id   INT NOT NULL,
  name       VARCHAR(80)  NOT NULL,
  photo_url  TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
  UNIQUE KEY uq_subtype_brand (brand_id, name)
);

-- Products table (updated with brand_id + sub_type_id foreign keys)
CREATE TABLE IF NOT EXISTS products (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(150)  NOT NULL,
  brand         VARCHAR(80)   NOT NULL,
  brand_id      INT,
  sub_type_id   INT,
  top_type      ENUM('shoes','clothes') NOT NULL DEFAULT 'shoes',
  category      VARCHAR(80)   NOT NULL DEFAULT 'Lifestyle',
  color         VARCHAR(80)   NOT NULL DEFAULT '',
  size          VARCHAR(10)   NOT NULL,
  sku           VARCHAR(50)   NOT NULL UNIQUE,
  stock         INT           NOT NULL DEFAULT 0,
  min_price     DECIMAL(10,2) NOT NULL,
  days_in_stock INT           NOT NULL DEFAULT 0,
  photo_url     TEXT,
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (brand_id)    REFERENCES brands(id)    ON DELETE SET NULL,
  FOREIGN KEY (sub_type_id) REFERENCES sub_types(id) ON DELETE SET NULL,
  INDEX idx_sku      (sku),
  INDEX idx_brand    (brand),
  INDEX idx_stock    (stock),
  INDEX idx_top_type (top_type)
);

-- Sales (one row per transaction)
CREATE TABLE IF NOT EXISTS sales (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  txn_id          VARCHAR(20)   NOT NULL UNIQUE,
  cashier_id      INT           NOT NULL,
  payment_method  ENUM('Cash','Tuma','Split') NOT NULL,
  selling_total   DECIMAL(10,2) NOT NULL,
  amount_paid     DECIMAL(10,2) NOT NULL DEFAULT 0,
  change_given    DECIMAL(10,2) NOT NULL DEFAULT 0,
  extra_profit    DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission      DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission_rate DECIMAL(5,2)  NOT NULL DEFAULT 10,
  tuma_ref        VARCHAR(50),
  phone           VARCHAR(20),
  status          ENUM('completed','pending_tuma','pending_cash','pending_split','failed') NOT NULL DEFAULT 'completed',
  sale_date       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cashier_id) REFERENCES users(id),
  INDEX idx_cashier   (cashier_id),
  INDEX idx_sale_date (sale_date),
  INDEX idx_status    (status)
);

-- Sale items (one row per product line in a sale)
CREATE TABLE IF NOT EXISTS sale_items (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  sale_id       INT           NOT NULL,
  product_id    INT           NOT NULL,
  product_name  VARCHAR(150)  NOT NULL,
  sku           VARCHAR(50)   NOT NULL,
  size          VARCHAR(10)   NOT NULL,
  qty           INT           NOT NULL,
  min_price     DECIMAL(10,2) NOT NULL,
  selling_price DECIMAL(10,2) NOT NULL,
  extra_profit  DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission    DECIMAL(10,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (sale_id)    REFERENCES sales(id)    ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id),
  INDEX idx_sale    (sale_id),
  INDEX idx_product (product_id)
);

-- Tuma payment tracking
CREATE TABLE IF NOT EXISTS tuma_transactions (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  sale_id          INT          NOT NULL,
  checkout_request_id VARCHAR(100) NOT NULL UNIQUE,
  merchant_request_id VARCHAR(100),
  phone            VARCHAR(20)  NOT NULL,
  amount           DECIMAL(10,2) NOT NULL,
  payment_ref      VARCHAR(50),
  result_code      INT,
  result_desc      VARCHAR(255),
  status           ENUM('pending','success','failed','timeout') NOT NULL DEFAULT 'pending',
  initiated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at     DATETIME,
  FOREIGN KEY (sale_id) REFERENCES sales(id),
  INDEX idx_checkout_id (checkout_request_id),
  INDEX idx_status      (status)
);

-- Tuma STK cancellation blocks
CREATE TABLE IF NOT EXISTS tuma_cancel_blocks (
  phone               VARCHAR(20) PRIMARY KEY,
  consecutive_cancels INT NOT NULL DEFAULT 0,
  last_cancel_at      DATETIME,
  blocked_at          DATETIME
);

-- Activity logs
CREATE TABLE IF NOT EXISTS activity_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  user_name   VARCHAR(100) NOT NULL,
  user_role   VARCHAR(20)  NOT NULL,
  action      VARCHAR(80)  NOT NULL,
  target      VARCHAR(200),
  detail      TEXT,
  category    ENUM('auth','sale','inventory','users','settings','general') NOT NULL DEFAULT 'general',
  ip_address  VARCHAR(45),
  logged_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_user     (user_id),
  INDEX idx_category (category),
  INDEX idx_logged   (logged_at)
);

-- App settings (key-value store)
CREATE TABLE IF NOT EXISTS settings (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  key_name    VARCHAR(80)   NOT NULL UNIQUE,
  key_value   TEXT,
  updated_by  INT,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

-- Default brand/sub_type seeds
INSERT IGNORE INTO brands (name, top_type, sort_order) VALUES
  ('Nike',        'shoes',   1),
  ('Adidas',      'shoes',   2),
  ('Jordan',      'shoes',   3),
  ('Puma',        'shoes',   4),
  ('New Balance', 'shoes',   5),
  ('Converse',    'shoes',   6),
  ('Vans',        'shoes',   7),
  ('Reebok',      'shoes',   8),
  ('Shirts',      'clothes', 1),
  ('T-Shirts',    'clothes', 2),
  ('Vests',       'clothes', 3),
  ('Belts',       'clothes', 4),
  ('Trousers',    'clothes', 5),
  ('Shorts',      'clothes', 6),
  ('Jeans',       'clothes', 7),
  ('Hoodies',     'clothes', 8),
  ('Jackets',     'clothes', 9),
  ('Caps',        'clothes', 10),
  ('Tracksuits',  'clothes', 11);

INSERT IGNORE INTO sub_types (brand_id, name, sort_order)
SELECT b.id, s.name, s.ord FROM brands b
JOIN (
  SELECT 'Nike'        AS bn, 'Air Force 1'  AS name, 1 AS ord UNION ALL
  SELECT 'Nike',              'Air Max',              2 UNION ALL
  SELECT 'Nike',              'Dunk',                 3 UNION ALL
  SELECT 'Nike',              'Blazer',               4 UNION ALL
  SELECT 'Nike',              'React',                5 UNION ALL
  SELECT 'Nike',              'Pegasus',              6 UNION ALL
  SELECT 'Nike',              'Cortez',               7 UNION ALL
  SELECT 'Jordan',            'Jordan 1',             1 UNION ALL
  SELECT 'Jordan',            'Jordan 4',             2 UNION ALL
  SELECT 'Jordan',            'Jordan 11',            3 UNION ALL
  SELECT 'Adidas',            'Superstar',            1 UNION ALL
  SELECT 'Adidas',            'Stan Smith',           2 UNION ALL
  SELECT 'Adidas',            'NMD',                  3 UNION ALL
  SELECT 'Adidas',            'Ultraboost',           4 UNION ALL
  SELECT 'Adidas',            'Gazelle',              5 UNION ALL
  SELECT 'Puma',              'Suede',                1 UNION ALL
  SELECT 'Puma',              'RS-X',                 2 UNION ALL
  SELECT 'Puma',              'Clyde',                3 UNION ALL
  SELECT 'New Balance',       '574',                  1 UNION ALL
  SELECT 'New Balance',       '990',                  2 UNION ALL
  SELECT 'New Balance',       '993',                  3 UNION ALL
  SELECT 'Converse',          'Chuck Taylor All Star',1 UNION ALL
  SELECT 'Converse',          'Run Star',             2 UNION ALL
  SELECT 'Vans',              'Old Skool',            1 UNION ALL
  SELECT 'Vans',              'Sk8-Hi',               2 UNION ALL
  SELECT 'Reebok',            'Classic Leather',      1 UNION ALL
  SELECT 'Reebok',            'Club C 85',            2
) s ON b.name = s.bn WHERE b.top_type = 'shoes';
