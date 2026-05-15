-- ============================================================
-- ShopeeScope Schema v2 — Market Discovery Expansion
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Add new columns to shops table
ALTER TABLE shops ADD COLUMN IF NOT EXISTS source      TEXT    DEFAULT 'manual';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS first_seen  DATE    DEFAULT CURRENT_DATE;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS is_tracked  BOOLEAN DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS catids      TEXT    DEFAULT '';

-- 2. Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_shops_source     ON shops(source);
CREATE INDEX IF NOT EXISTS idx_shops_is_tracked ON shops(is_tracked);
CREATE INDEX IF NOT EXISTS idx_products_catid   ON products(catid);

-- 3. market_rankings VIEW — all shops from products (even without full shop record)
--    Uses LEFT JOIN so discovered shops with no shop record still appear
CREATE OR REPLACE VIEW market_rankings AS
SELECT
  p.shopid,
  COALESCE(s.username, 'disc_' || p.shopid::text)     AS username,
  COALESCE(s.name,     'Shop '  || p.shopid::text)     AS shop_name,
  s.follower_count,
  s.rating_star                                         AS shop_rating,
  s.is_official_shop,
  s.is_shopee_verified,
  COALESCE(s.source, 'discovered')                     AS source,
  s.is_tracked,
  s.first_seen,
  COUNT(DISTINCT p.itemid)                             AS total_products,
  SUM(p.historical_sold)                               AS total_sold,
  ROUND(AVG(p.price_min / 100000.0)::numeric, 2)      AS avg_price_rm,
  MAX(p.raw_discount)                                  AS max_discount,
  ROUND(AVG(p.rating_star)::numeric, 2)               AS avg_product_rating,
  MAX(p.scraped_at)                                    AS last_scraped,
  MIN(p.scraped_at)                                    AS first_scraped,
  -- Most common catid for this shop
  MODE() WITHIN GROUP (ORDER BY p.catid)              AS primary_catid
FROM latest_products p
LEFT JOIN shops s ON s.shopid = p.shopid
GROUP BY
  p.shopid, s.username, s.name, s.follower_count,
  s.rating_star, s.is_official_shop, s.is_shopee_verified,
  s.source, s.is_tracked, s.first_seen;

-- 4. RLS policy for new view (public read)
-- Note: Views inherit RLS from their base tables, so this may already be covered.
-- If you get permission errors, run:
-- GRANT SELECT ON market_rankings TO anon, authenticated;

-- 5. Update shop_stats view to include source info
CREATE OR REPLACE VIEW shop_stats AS
SELECT
  p.shopid,
  s.username,
  s.name                                              AS shop_name,
  s.follower_count,
  s.rating_star                                       AS shop_rating,
  COALESCE(s.source, 'manual')                       AS source,
  s.is_tracked,
  s.first_seen,
  COUNT(DISTINCT p.itemid)                            AS total_products,
  SUM(p.historical_sold)                              AS total_sold,
  ROUND(AVG(p.price_min / 100000.0)::numeric, 2)    AS avg_price_rm,
  MAX(p.raw_discount)                                AS max_discount,
  ROUND(AVG(p.rating_star)::numeric, 2)             AS avg_product_rating,
  MAX(p.scraped_at)                                  AS last_scraped
FROM latest_products p
JOIN shops s ON s.shopid = p.shopid
GROUP BY
  p.shopid, s.username, s.name, s.follower_count,
  s.rating_star, s.source, s.is_tracked, s.first_seen;

-- 6. RLS for shops — allow discovered shops to be inserted via service key
CREATE POLICY IF NOT EXISTS "service_insert_shops_discovered"
  ON shops FOR INSERT WITH CHECK (true);

-- Done! Verify with:
-- SELECT source, COUNT(*) FROM shops GROUP BY source;
-- SELECT COUNT(*) FROM market_rankings;
