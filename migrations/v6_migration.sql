-- ══════════════════════════════════════════════════════════════════════════════
-- Permic Wear v6 — Full PostgreSQL Migration
-- Multi-Store · Tuma · Returns · Barcodes · Smart SKU · Feature Flags
-- Safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- ══════════════════════════════════════════════════════════════════════════════

-- STORES
CREATE TABLE IF NOT EXISTS stores (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(150) NOT NULL,
  location   VARCHAR(255),
  phone      VARCHAR(30),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO stores (name, location, phone)
SELECT COALESCE((SELECT key_value FROM settings WHERE key_name='store_name'),'Permic Men''s Wear'),
       COALESCE((SELECT key_value FROM settings WHERE key_name='store_location'),'Nairobi, Kenya'),
       COALESCE((SELECT key_value FROM settings WHERE key_name='store_phone'),'')
WHERE NOT EXISTS (SELECT 1 FROM stores LIMIT 1);

-- Link existing tables
ALTER TABLE users    ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE SET NULL;
ALTER TABLE sales    ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id INT REFERENCES stores(id) ON DELETE SET NULL;
UPDATE users    SET store_id=(SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL;
UPDATE sales    SET store_id=(SELECT id FROM stores ORDER BY id LIMIT 1) WHERE store_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_store    ON sales(store_id);
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);

-- Tuma
CREATE TABLE IF NOT EXISTS tuma_transactions (
  id                  SERIAL PRIMARY KEY,
  sale_id             INT NOT NULL REFERENCES sales(id),
  checkout_request_id VARCHAR(100) NOT NULL UNIQUE,
  merchant_request_id VARCHAR(100),
  phone               VARCHAR(20) NOT NULL,
  amount              DECIMAL(10,2) NOT NULL,
  payment_ref         VARCHAR(50),
  result_code         INT,
  result_desc         VARCHAR(255),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','success','failed','timeout')),
  initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tuma_checkout ON tuma_transactions(checkout_request_id);
CREATE INDEX IF NOT EXISTS idx_tuma_status   ON tuma_transactions(status);

-- STK cancellation
CREATE TABLE IF NOT EXISTS tuma_cancel_blocks (
  phone               VARCHAR(20) PRIMARY KEY,
  consecutive_cancels INT NOT NULL DEFAULT 0,
  last_cancel_at      TIMESTAMPTZ,
  blocked_at          TIMESTAMPTZ
);

-- Product favorites
CREATE TABLE IF NOT EXISTS product_favorites (
  user_id    INT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  use_count  INT NOT NULL DEFAULT 1,
  last_used  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_user ON product_favorites(user_id, use_count DESC);

-- Returns / Refunds
CREATE TABLE IF NOT EXISTS returns (
  id               SERIAL PRIMARY KEY,
  return_ref       VARCHAR(30) NOT NULL UNIQUE,
  original_sale_id INT NOT NULL REFERENCES sales(id),
  store_id         INT REFERENCES stores(id),
  processed_by     INT NOT NULL REFERENCES users(id),
  approved_by      INT REFERENCES users(id),
  reason           TEXT,
  notes            TEXT,
  total_refund     DECIMAL(10,2) NOT NULL DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'completed'
                     CHECK (status IN ('pending_approval','completed','rejected')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS return_items (
  id           SERIAL PRIMARY KEY,
  return_id    INT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  sale_item_id INT NOT NULL REFERENCES sale_items(id),
  product_id   INT NOT NULL REFERENCES products(id),
  product_name VARCHAR(150) NOT NULL,
  sku          VARCHAR(50) NOT NULL,
  size         VARCHAR(10) NOT NULL,
  qty          INT NOT NULL,
  refund_price DECIMAL(10,2) NOT NULL,
  restock      BOOLEAN NOT NULL DEFAULT TRUE,
  condition    VARCHAR(20) NOT NULL DEFAULT 'good'
                 CHECK (condition IN ('good','damaged','unsellable'))
);
CREATE INDEX IF NOT EXISTS idx_returns_sale     ON returns(original_sale_id);
CREATE INDEX IF NOT EXISTS idx_returns_store    ON returns(store_id);
CREATE INDEX IF NOT EXISTS idx_return_items_ret ON return_items(return_id);

-- Barcode print queue
CREATE TABLE IF NOT EXISTS print_jobs (
  id           SERIAL PRIMARY KEY,
  store_id     INT REFERENCES stores(id),
  created_by   INT NOT NULL REFERENCES users(id),
  job_name     VARCHAR(150),
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','printing','done','failed')),
  total_labels INT NOT NULL DEFAULT 0,
  printed      INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS print_job_items (
  id         SERIAL PRIMARY KEY,
  job_id     INT NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  sku        VARCHAR(50) NOT NULL,
  copies     INT NOT NULL DEFAULT 1,
  status     VARCHAR(20) NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','done','failed'))
);
CREATE INDEX IF NOT EXISTS idx_print_job ON print_job_items(job_id);

-- Module feature flags
CREATE TABLE IF NOT EXISTS store_modules (
  store_id   INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  module     VARCHAR(50) NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, module)
);
INSERT INTO store_modules (store_id, module, enabled)
SELECT id, m, TRUE FROM stores, unnest(ARRAY['returns','barcodes','analytics','commission']) AS m
ON CONFLICT DO NOTHING;

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_products_fts ON products USING gin(
  to_tsvector('simple',
    coalesce(name,'') || ' ' || coalesce(brand,'') || ' ' ||
    coalesce(color,'') || ' ' || coalesce(sku,'') || ' ' ||
    coalesce(size,'') || ' ' || coalesce(category,'')
  )
);

-- New settings
INSERT INTO settings (key_name, key_value) VALUES
  ('tuma_email',         'permicwear@gmail.com'),
  ('tuma_api_key',       'tuma_15ffd8e39429707c92171d713f3bdb55d0ed5e9718b320f65d872e0132b0d302_1775248635'),
  ('tuma_callback_url',  ''),
  ('return_window_days', '30'),
  ('return_approval_threshold', '5000'),
  ('barcode_label_width', '62'),
  ('barcode_label_height','29')
ON CONFLICT (key_name) DO NOTHING;

-- Triggers
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stores_updated_at ON stores;
CREATE TRIGGER trg_stores_updated_at
  BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION update_updated_at();
