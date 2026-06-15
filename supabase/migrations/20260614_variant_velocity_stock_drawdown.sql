-- 2026-06-14 — Fix dead Velocity tab (variant_velocity)
--
-- Problem: variant_velocity computed sold_7d/14d/30d as deltas of the
-- product_variants.sold column. Shopee hides per-variant `sold` for visitor
-- (non-owner) sessions, so it is 0 in ~99.3% of rows (20,629 / 20,767). Every
-- 7/14/30-day window therefore read 0 and the flagship Velocity tab showed
-- nothing, even though variant data is scraped through 2026-06-09.
--
-- Fix: compute ALL windows from STOCK drawdown (stock_Nd_ago - current_stock),
-- the same approach sold_1d/sold_3d already used. Stock is populated in ~89% of
-- rows. Restocks make the delta negative and are clamped to 0 via GREATEST, so
-- this conservatively under-counts rather than inventing sales.
--
-- Output schema is unchanged (same column names/order/types), so api/get-velocity.js
-- and the dashboard need no changes. Applied live via Supabase migration
-- "variant_velocity_use_stock_drawdown".
--
-- Note: sold_1d/sold_3d will read 0 until daily scraping resumes (the 1-/3-day-ago
-- baseline currently resolves to the same latest snapshot, 2026-06-09).

CREATE OR REPLACE VIEW variant_velocity AS
 WITH latest AS (
         SELECT DISTINCT ON (pv.shopid, pv.itemid, pv.variant_name) pv.shopid,
            pv.itemid,
            pv.variant_name,
            pv.variant_sku,
            pv.variation_type,
            pv.price,
            pv.stock,
            pv.sold,
            pv.scraped_date,
            pv.product_name,
            p.username,
                CASE
                    WHEN ((p.image IS NOT NULL) AND (p.image <> ''::text)) THEN ('https://down-my.img.susercontent.com/file/'::text || p.image)
                    ELSE ''::text
                END AS image_url,
                CASE
                    WHEN ((p.username IS NOT NULL) AND (p.itemid IS NOT NULL)) THEN ((((('https://shopee.com.my/'::text || p.username) || '-i.'::text) || p.shopid) || '.'::text) || p.itemid)
                    ELSE ''::text
                END AS product_url
           FROM (product_variants pv
             LEFT JOIN latest_products p ON (((p.shopid = pv.shopid) AND (p.itemid = pv.itemid))))
          ORDER BY pv.shopid, pv.itemid, pv.variant_name, pv.scraped_date DESC
        ), day1 AS (
         SELECT DISTINCT ON (product_variants.shopid, product_variants.itemid, product_variants.variant_name) product_variants.shopid,
            product_variants.itemid,
            product_variants.variant_name,
            product_variants.stock AS stock_1d_ago
           FROM product_variants
          WHERE (product_variants.scraped_date <= (CURRENT_DATE - 1))
          ORDER BY product_variants.shopid, product_variants.itemid, product_variants.variant_name, product_variants.scraped_date DESC
        ), day3 AS (
         SELECT DISTINCT ON (product_variants.shopid, product_variants.itemid, product_variants.variant_name) product_variants.shopid,
            product_variants.itemid,
            product_variants.variant_name,
            product_variants.stock AS stock_3d_ago
           FROM product_variants
          WHERE (product_variants.scraped_date <= (CURRENT_DATE - 3))
          ORDER BY product_variants.shopid, product_variants.itemid, product_variants.variant_name, product_variants.scraped_date DESC
        ), day7 AS (
         SELECT DISTINCT ON (product_variants.shopid, product_variants.itemid, product_variants.variant_name) product_variants.shopid,
            product_variants.itemid,
            product_variants.variant_name,
            product_variants.stock AS stock_7d_ago
           FROM product_variants
          WHERE (product_variants.scraped_date <= (CURRENT_DATE - 7))
          ORDER BY product_variants.shopid, product_variants.itemid, product_variants.variant_name, product_variants.scraped_date DESC
        ), day14 AS (
         SELECT DISTINCT ON (product_variants.shopid, product_variants.itemid, product_variants.variant_name) product_variants.shopid,
            product_variants.itemid,
            product_variants.variant_name,
            product_variants.stock AS stock_14d_ago
           FROM product_variants
          WHERE (product_variants.scraped_date <= (CURRENT_DATE - 14))
          ORDER BY product_variants.shopid, product_variants.itemid, product_variants.variant_name, product_variants.scraped_date DESC
        ), day30 AS (
         SELECT DISTINCT ON (product_variants.shopid, product_variants.itemid, product_variants.variant_name) product_variants.shopid,
            product_variants.itemid,
            product_variants.variant_name,
            product_variants.stock AS stock_30d_ago
           FROM product_variants
          WHERE (product_variants.scraped_date <= (CURRENT_DATE - 30))
          ORDER BY product_variants.shopid, product_variants.itemid, product_variants.variant_name, product_variants.scraped_date DESC
        )
 SELECT l.shopid,
    l.itemid,
    NULL::bigint AS model_id,
    l.username,
    l.product_name,
    l.variant_name,
    l.variation_type,
    l.price,
    l.stock,
    l.sold AS sold_total,
    l.image_url,
    l.product_url,
    COALESCE(GREATEST(0, (d1.stock_1d_ago - l.stock)), 0) AS sold_1d,
    COALESCE(GREATEST(0, (d3.stock_3d_ago - l.stock)), 0) AS sold_3d,
    COALESCE(GREATEST(0, (d7.stock_7d_ago - l.stock)), 0) AS sold_7d,
    COALESCE(GREATEST(0, (d14.stock_14d_ago - l.stock)), 0) AS sold_14d,
    COALESCE(GREATEST(0, (d30.stock_30d_ago - l.stock)), 0) AS sold_30d,
    l.scraped_date AS last_snapshot
   FROM (((((latest l
     LEFT JOIN day1 d1 ON (((d1.shopid = l.shopid) AND (d1.itemid = l.itemid) AND (d1.variant_name = l.variant_name))))
     LEFT JOIN day3 d3 ON (((d3.shopid = l.shopid) AND (d3.itemid = l.itemid) AND (d3.variant_name = l.variant_name))))
     LEFT JOIN day7 d7 ON (((d7.shopid = l.shopid) AND (d7.itemid = l.itemid) AND (d7.variant_name = l.variant_name))))
     LEFT JOIN day14 d14 ON (((d14.shopid = l.shopid) AND (d14.itemid = l.itemid) AND (d14.variant_name = l.variant_name))))
     LEFT JOIN day30 d30 ON (((d30.shopid = l.shopid) AND (d30.itemid = l.itemid) AND (d30.variant_name = l.variant_name))));
