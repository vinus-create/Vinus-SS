-- ============================================================
-- ShopeeScope — product_velocity view
-- Tracks ALL products (not just top N) using historical_sold
-- delta from the products table (already scraped daily by cron).
--
-- historical_sold = Shopee lifetime cumulative sold count
-- delta = today - N_days_ago = actual sales in that period
--
-- Run this ONCE in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/zckargstzrskphpkukir/sql/new
-- ============================================================

CREATE OR REPLACE VIEW product_velocity AS
WITH latest AS (
  SELECT DISTINCT ON (shopid, itemid)
    shopid, itemid, username, name, image,
    price_min, historical_sold, scraped_date
  FROM products
  ORDER BY shopid, itemid, scraped_date DESC
),
day1 AS (
  SELECT DISTINCT ON (shopid, itemid)
    shopid, itemid, historical_sold AS hs_1d_ago
  FROM products
  WHERE scraped_date <= CURRENT_DATE - 1
  ORDER BY shopid, itemid, scraped_date DESC
),
day3 AS (
  SELECT DISTINCT ON (shopid, itemid)
    shopid, itemid, historical_sold AS hs_3d_ago
  FROM products
  WHERE scraped_date <= CURRENT_DATE - 3
  ORDER BY shopid, itemid, scraped_date DESC
),
day7 AS (
  SELECT DISTINCT ON (shopid, itemid)
    shopid, itemid, historical_sold AS hs_7d_ago
  FROM products
  WHERE scraped_date <= CURRENT_DATE - 7
  ORDER BY shopid, itemid, scraped_date DESC
),
day14 AS (
  SELECT DISTINCT ON (shopid, itemid)
    shopid, itemid, historical_sold AS hs_14d_ago
  FROM products
  WHERE scraped_date <= CURRENT_DATE - 14
  ORDER BY shopid, itemid, scraped_date DESC
),
day30 AS (
  SELECT DISTINCT ON (shopid, itemid)
    shopid, itemid, historical_sold AS hs_30d_ago
  FROM products
  WHERE scraped_date <= CURRENT_DATE - 30
  ORDER BY shopid, itemid, scraped_date DESC
)
SELECT
  l.shopid,
  l.itemid,
  l.username,
  l.name                                            AS product_name,
  l.image,
  ROUND(l.price_min / 100000.0::numeric, 2)         AS price,
  l.historical_sold                                 AS sold_total,
  GREATEST(COALESCE(l.historical_sold - d1.hs_1d_ago,  0), 0) AS sold_1d,
  GREATEST(COALESCE(l.historical_sold - d3.hs_3d_ago,  0), 0) AS sold_3d,
  GREATEST(COALESCE(l.historical_sold - d7.hs_7d_ago,  0), 0) AS sold_7d,
  GREATEST(COALESCE(l.historical_sold - d14.hs_14d_ago, 0), 0) AS sold_14d,
  GREATEST(COALESCE(l.historical_sold - d30.hs_30d_ago, 0), 0) AS sold_30d,
  l.scraped_date                                    AS last_snapshot
FROM latest l
LEFT JOIN day1  d1  ON d1.shopid=l.shopid  AND d1.itemid=l.itemid
LEFT JOIN day3  d3  ON d3.shopid=l.shopid  AND d3.itemid=l.itemid
LEFT JOIN day7  d7  ON d7.shopid=l.shopid  AND d7.itemid=l.itemid
LEFT JOIN day14 d14 ON d14.shopid=l.shopid AND d14.itemid=l.itemid
LEFT JOIN day30 d30 ON d30.shopid=l.shopid AND d30.itemid=l.itemid;

-- Add index to speed up delta queries (if not exists)
CREATE INDEX IF NOT EXISTS idx_products_shopid_itemid_date
  ON products(shopid, itemid, scraped_date DESC);

-- Verify:
SELECT
  COUNT(*) AS total_products,
  COUNT(*) FILTER (WHERE sold_1d > 0) AS products_with_1d_sales,
  COUNT(*) FILTER (WHERE sold_3d > 0) AS products_with_3d_sales,
  MAX(sold_1d) AS max_1d_sales
FROM product_velocity;
