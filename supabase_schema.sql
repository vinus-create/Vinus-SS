-- ============================================
-- ShopeeScope — Full Supabase Schema
-- Paste entire thing into SQL Editor → Run
-- ============================================

-- 1. SHOPS TABLE
CREATE TABLE IF NOT EXISTS shops (
  id                  SERIAL PRIMARY KEY,
  username            TEXT UNIQUE NOT NULL,
  shopid              BIGINT UNIQUE NOT NULL,
  name                TEXT,
  follower_count      INT DEFAULT 0,
  following_count     INT DEFAULT 0,
  rating_star         FLOAT DEFAULT 0,
  rating_normal       INT DEFAULT 0,
  rating_good         INT DEFAULT 0,
  rating_bad          INT DEFAULT 0,
  item_count          INT DEFAULT 0,
  response_rate       INT DEFAULT 0,
  response_time       INT DEFAULT 0,
  is_official_shop    BOOLEAN DEFAULT false,
  is_shopee_verified  BOOLEAN DEFAULT false,
  vacation            BOOLEAN DEFAULT false,
  cancellation_rate   FLOAT DEFAULT 0,
  description         TEXT,
  scraped_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 2. PRODUCTS TABLE
CREATE TABLE IF NOT EXISTS products (
  id                        SERIAL PRIMARY KEY,
  shopid                    BIGINT NOT NULL,
  itemid                    BIGINT NOT NULL,
  username                  TEXT,
  name                      TEXT NOT NULL,
  price_min                 BIGINT DEFAULT 0,
  price_max                 BIGINT DEFAULT 0,
  price_min_before_discount BIGINT DEFAULT 0,
  raw_discount              INT DEFAULT 0,
  historical_sold           INT DEFAULT 0,
  sold                      INT DEFAULT 0,
  liked_count               INT DEFAULT 0,
  view_count                INT DEFAULT 0,
  stock                     INT DEFAULT 0,
  rating_star               FLOAT DEFAULT 0,
  rating_count              INT DEFAULT 0,
  brand                     TEXT DEFAULT '',
  catid                     BIGINT DEFAULT 0,
  cb_option                 INT DEFAULT 0,
  image                     TEXT DEFAULT '',
  ctime                     BIGINT DEFAULT 0,
  scraped_date              DATE NOT NULL DEFAULT CURRENT_DATE,
  scraped_at                TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shopid, itemid, scraped_date)
);

-- 3. SCRAPE LOG TABLE
CREATE TABLE IF NOT EXISTS scrape_log (
  id          SERIAL PRIMARY KEY,
  username    TEXT,
  shopid      BIGINT,
  total_items INT,
  status      TEXT DEFAULT 'success',
  error_msg   TEXT,
  duration_ms INT,
  scraped_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 4. INDEXES
CREATE INDEX IF NOT EXISTS idx_products_shopid
  ON products(shopid);

CREATE INDEX IF NOT EXISTS idx_products_scraped_at
  ON products(scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_historical_sold
  ON products(historical_sold DESC);

CREATE INDEX IF NOT EXISTS idx_products_shopid_date
  ON products(shopid, scraped_at DESC);

-- 5. ROW LEVEL SECURITY
ALTER TABLE shops      ENABLE ROW LEVEL SECURITY;
ALTER TABLE products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE scrape_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_shops"
  ON shops FOR SELECT USING (true);

CREATE POLICY "public_read_products"
  ON products FOR SELECT USING (true);

CREATE POLICY "public_read_log"
  ON scrape_log FOR SELECT USING (true);

CREATE POLICY "service_insert_shops"
  ON shops FOR INSERT WITH CHECK (true);

CREATE POLICY "service_upsert_shops"
  ON shops FOR UPDATE USING (true);

CREATE POLICY "service_insert_products"
  ON products FOR INSERT WITH CHECK (true);

CREATE POLICY "service_insert_log"
  ON scrape_log FOR INSERT WITH CHECK (true);

-- 6. VIEW: latest snapshot per product per shop
CREATE OR REPLACE VIEW latest_products AS
SELECT DISTINCT ON (shopid, itemid)
  *
FROM products
ORDER BY shopid, itemid, scraped_at DESC;

-- 7. VIEW: shop summary stats (used by dashboard)
CREATE OR REPLACE VIEW shop_stats AS
SELECT
  p.shopid,
  s.username,
  s.name                                          AS shop_name,
  s.follower_count,
  s.rating_star                                   AS shop_rating,
  COUNT(DISTINCT p.itemid)                        AS total_products,
  SUM(p.historical_sold)                          AS total_sold,
  ROUND(AVG(p.price_min / 100000.0)::numeric, 2) AS avg_price_rm,
  MAX(p.raw_discount)                             AS max_discount,
  ROUND(AVG(p.rating_star)::numeric, 2)           AS avg_product_rating,
  MAX(p.scraped_at)                               AS last_scraped
FROM latest_products p
JOIN shops s ON s.shopid = p.shopid
GROUP BY
  p.shopid,
  s.username,
  s.name,
  s.follower_count,
  s.rating_star;