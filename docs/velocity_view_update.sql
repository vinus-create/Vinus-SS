-- ============================================================
-- ShopeeScope — Update variant_velocity view
-- Adds sold_1d and sold_3d columns so velocity shows data
-- from day 2 onwards (instead of requiring 7+ days).
--
-- Run this ONCE in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/zckargstzrskphpkukir/sql/new
-- ============================================================

CREATE OR REPLACE VIEW variant_velocity AS
WITH latest AS (
  SELECT DISTINCT ON (shopid, itemid, model_id)
    shopid, itemid, model_id, username, product_name, variant_name,
    variation_type, price, stock, sold, scraped_date
  FROM snapshots ORDER BY shopid, itemid, model_id, scraped_date DESC
),
day1 AS (
  SELECT DISTINCT ON (shopid, itemid, model_id)
    shopid, itemid, model_id, sold AS sold_1d_ago
  FROM snapshots WHERE scraped_date <= CURRENT_DATE - 1
  ORDER BY shopid, itemid, model_id, scraped_date DESC
),
day3 AS (
  SELECT DISTINCT ON (shopid, itemid, model_id)
    shopid, itemid, model_id, sold AS sold_3d_ago
  FROM snapshots WHERE scraped_date <= CURRENT_DATE - 3
  ORDER BY shopid, itemid, model_id, scraped_date DESC
),
day7 AS (
  SELECT DISTINCT ON (shopid, itemid, model_id)
    shopid, itemid, model_id, sold AS sold_7d_ago
  FROM snapshots WHERE scraped_date <= CURRENT_DATE - 7
  ORDER BY shopid, itemid, model_id, scraped_date DESC
),
day14 AS (
  SELECT DISTINCT ON (shopid, itemid, model_id)
    shopid, itemid, model_id, sold AS sold_14d_ago
  FROM snapshots WHERE scraped_date <= CURRENT_DATE - 14
  ORDER BY shopid, itemid, model_id, scraped_date DESC
),
day30 AS (
  SELECT DISTINCT ON (shopid, itemid, model_id)
    shopid, itemid, model_id, sold AS sold_30d_ago
  FROM snapshots WHERE scraped_date <= CURRENT_DATE - 30
  ORDER BY shopid, itemid, model_id, scraped_date DESC
)
SELECT
  l.shopid, l.itemid, l.model_id,
  l.username, l.product_name, l.variant_name, l.variation_type,
  l.price, l.stock, l.sold AS sold_total,
  COALESCE(l.sold - d1.sold_1d_ago,  0) AS sold_1d,
  COALESCE(l.sold - d3.sold_3d_ago,  0) AS sold_3d,
  COALESCE(l.sold - d7.sold_7d_ago,  0) AS sold_7d,
  COALESCE(l.sold - d14.sold_14d_ago, 0) AS sold_14d,
  COALESCE(l.sold - d30.sold_30d_ago, 0) AS sold_30d,
  l.scraped_date AS last_snapshot
FROM latest l
LEFT JOIN day1  d1  ON d1.shopid=l.shopid  AND d1.itemid=l.itemid  AND d1.model_id=l.model_id
LEFT JOIN day3  d3  ON d3.shopid=l.shopid  AND d3.itemid=l.itemid  AND d3.model_id=l.model_id
LEFT JOIN day7  d7  ON d7.shopid=l.shopid  AND d7.itemid=l.itemid  AND d7.model_id=l.model_id
LEFT JOIN day14 d14 ON d14.shopid=l.shopid AND d14.itemid=l.itemid AND d14.model_id=l.model_id
LEFT JOIN day30 d30 ON d30.shopid=l.shopid AND d30.itemid=l.itemid AND d30.model_id=l.model_id;

-- Verify:
SELECT 'sold_1d' IN (SELECT column_name FROM information_schema.columns WHERE table_name='variant_velocity') AS has_sold_1d;
