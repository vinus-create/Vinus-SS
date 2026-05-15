# ShopeeScope

Shopee competitor intelligence dashboard for Malaysian e-commerce sellers. Tracks competitor shops, products, variants, reviews, and sales velocity — built for the battery/electronics niche on Shopee Malaysia.

**Live:** https://vinus-ss.vercel.app  
**Owner:** VINUSTORE (Bayan Lepas, Penang, Malaysia)

---

## Stack

| Layer | Technology |
|---|---|
| Database | Supabase (PostgreSQL) |
| Hosting | Vercel (serverless functions + cron) |
| Frontend | Vanilla HTML/CSS/JS — single `index.html`, no build step |
| Charts | Chart.js 4.4.1 |
| Scraper | Browser-based (Claude in Chrome) + Vercel Cron |

---

## Features

| Tab | Description |
|---|---|
| 📊 Overview | KPI cards, top 20 sales chart, price distribution, category breakdown |
| 🏆 Best Sellers | Sortable product table with photos, inline variants, 15 toggleable columns |
| 🧬 Variants | All product variants with price/sold/stock, grouped by product |
| 💰 Pricing Intel | Price buckets, sweet spot analysis, discount impact |
| 🔑 Keywords | Keyword cloud from product titles, title pattern analysis |
| ⭐ Reviews | Star breakdown, top tags, customer comments with variant bought |
| 📈 Velocity | 7d/14d/30d sales velocity per variant (from daily snapshots) |
| 🔀 Compare | Cross-shop variant comparison by keyword search |
| 🏪 Competitors | Side-by-side shop cards + benchmark table + charts |
| 🌐 Market | All-shop leaderboard across tracked + auto-discovered shops |
| 🔍 Discover | Browser-based category crawler — auto-finds new competitor shops |
| 📋 Scrape Log | History of all scrape runs |
| ⚙️ Setup Guide | Architecture + how-to guide |

---

## Project Structure

```
Vinus-SS/
├── index.html              — full dashboard (no build step)
├── scraper.js              — manual browser scraper (run in Claude in Chrome)
├── vercel.json             — routing + cron schedule (daily 8am MYT)
├── supabase_schema.sql     — original DB schema
├── api/
│   ├── save.js             — POST: save products + shop from browser scraper
│   ├── save-enriched.js    — POST: generic upsert (snapshots, reviews)
│   ├── save-variants.js    — POST: save product_variants
│   ├── data.js             — GET: shops, products, market stats, category data
│   ├── get-variants.js     — GET: product_variants by shopid/itemid
│   ├── get-velocity.js     — GET: variant_velocity view (7/14/30d delta)
│   ├── get-reviews.js      — GET: reviews + summary stats
│   ├── discover.js         — POST/GET: category crawler + bulk shop discovery
│   └── cron-scrape.js      — Vercel cron: daily scrape all DB shops
└── docs/
    ├── SHOPEE_API.md       — Shopee internal v4 API + Open API v2 reference
    └── schema_v2.sql       — DB migration SQL (v2 schema changes)
```

---

## Setup

### 1. Supabase
1. Create a new Supabase project
2. Run `supabase_schema.sql` in the SQL Editor
3. Run `docs/schema_v2.sql` for v2 schema additions (market_rankings view)
4. Copy your project URL and service role key

### 2. Vercel
1. Import this repo to Vercel
2. Set environment variables:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_KEY=your_service_role_key
   CRON_SECRET=shopeescope2026
   ```
3. Deploy — dashboard is live at your Vercel URL

### 3. First Scrape
Open shopee.com.my in Claude in Chrome and run `scraper.js`, or trigger the cron manually:
```bash
curl -H "Authorization: Bearer shopeescope2026" https://your-app.vercel.app/api/cron-scrape
```

---

## Tracked Shops (13 Battery/Electronics Competitors)

| Username | Shop Name |
|---|---|
| buddysnack | Buddy Power |
| winstartech | WinstarTech |
| 1stopbatteries | 1 Stop Batteries Solution |
| icare4allshop | icare4all |
| energizerbatteryhub | ENERGIZER BATTERY HUB |
| gadgetspecialist | gadgetspecialist |
| gou.ori | GRATEFUL GADGET SDN BHD |
| tenbucksfood | Ten Bucks Food |
| dsconcept_store | D&S CONCEPT STORE |
| sxmixempire | Sx Mix Empire |
| r_in_g | R IN G Studio |
| nextgenhardware.os | NextGen Hardware |
| ham_radios.my | Ham_radios.my |

---

## How the Scraper Works

Shopee's internal API requires browser session cookies — server-side requests return empty results. Two modes:

**Manual (browser):** Open shopee.com.my → use Claude in Chrome → runs `scraper.js` → POSTs to `/api/save` → Supabase

**Automatic (cron):** Vercel cron at 0:00 UTC (8am MYT) calls `/api/cron-scrape` — reads all shops from DB dynamically

---

## Velocity Tracking

Shopee shows only lifetime sold, never daily. Velocity is calculated from daily snapshots:

```
7d_sold = today_sold - sold_7_days_ago   (from snapshots table)
```

First snapshots: **2026-05-15**  
Velocity data available: 7d from 2026-05-22 · 14d from 2026-05-29 · 30d from 2026-06-14

---

## Changelog

### V1.6 — 2026-05-15 — Market Discovery Expansion
- **🌐 Market tab** — all-shop leaderboard (tracked + auto-discovered), sort by sales/products/rating/followers, filter by name, top-12 charts, jump-to-shop
- **🔍 Discover tab** — browser-based category crawler; select categories (Batteries 11042, Chargers 11041, Power Banks 11139, etc.), set crawl depth, auto-discovers shops selling in those categories
- `api/discover.js` — new POST/GET endpoint: receives browser-crawled products, bulk-saves to DB, creates minimal shop records for new shops with source=discovered
- `api/data.js` — new query types: `market` (market_rankings view), `category`, `top-products`
- `cron-scrape.js` — dynamic shop list read from DB instead of hardcoded 13; falls back to hardcoded list if DB read fails
- `docs/schema_v2.sql` — DB migration: add `source` / `first_seen` / `is_tracked` columns to shops, create `market_rankings` LEFT JOIN view (shows discovered shops even without full shop record)
- `docs/SHOPEE_API.md` — comprehensive Shopee API reference (internal v4 endpoints + Open Platform v2 auth/endpoints)
- Fixed `cron-scrape.js` syntax error in catch block (`}catch(e){api/cron-scrape.js` garbage text)
- Fixed `cron-scrape.js` `maxDuration: 300` in `vercel.json` for long-running scrape
- Fixed `save.js`: added `on_conflict=username` for shops upsert
- Fixed `save.js`: added `on_conflict=shopid,itemid,scraped_date` for products upsert

### V1.5 — 2026-05-15 — Best Sellers Overhaul + Photo Fix
- **Column selector** (⚙ Columns button) — 15 toggleable columns: Price, Discount, Unit Sold, Total Sold RM, Rating, Likes, Stock, 7d/14d/30d Units, 7d/14d/30d Sales RM, Created, Last Updated; state saved to localStorage
- **Product photos** — thumbnail from Shopee CDN (`down-my.img.susercontent.com/file/{hash}`); `imgErr()` fallback to 📦 placeholder
- **Inline variants** — all variants shown directly under each product name (price / sold / stock per variant)
- **Clickable product links** — product name links to `shopee.com.my/{username}-i.{shopid}.{itemid}`
- **Rating to 2dp** — e.g. 4.85 instead of rounded 5
- Fixed `cron-scrape.js` root cause of missing photos: was saving `image_url` column (doesn't exist in schema) instead of `image` (MD5 hash); `api/data.js` now constructs `image_url` and `product_url` at query time

### V1.4 — 2026-05-14 — Cross-Shop Compare Tab
- **🔀 Compare tab** — keyword search across all 13 shops' variants simultaneously
- KPI summary: match count, cheapest price, top seller, price range min–max
- Results table sorted by sold with cheapest/hottest badges
- Parallel fetch of all shop variants via `Promise.all`

### V1.3 — 2026-05-14 — Variant Scraping + Daily Snapshots
- Scraped product variants for all 13 shops (buddysnack: 620 variants)
- Day-1 snapshot baseline saved 2026-05-15 — velocity tracking starts here
- **🧬 Variants tab** — accordion grouped by product, sort by sold/price/stock/name, keyword search
- `api/get-variants.js` — variants by shopid/itemid
- `api/save-variants.js` — bulk save product_variants
- `api/get-velocity.js` — 7d/14d/30d delta from `variant_velocity` Supabase view
- `snapshots` table + `variant_velocity` VIEW in Supabase schema

### V1.2 — 2026-05-13 — Velocity Tab + Reviews
- **📈 Velocity tab** — ranks variants by 7d/14d/30d sales growth; period switcher; velocity bar chart; notice banner when data not yet available
- **⭐ Reviews tab** — star breakdown bars, top 20 customer tags cloud, review table with sort (date/rating/product), click to expand comment
- `api/get-reviews.js` — reviews by shopid/itemid + computed summary (total, avg, stars dict, topTags)
- `api/save-enriched.js` — generic bulk upsert for reviews + snapshots
- Scraped 986 reviews from buddysnack top 50 products

### V1.1 — 2026-05-13 — Multi-Shop Scrape + Competitors Tab
- Scraped all 12 other competitor shops (products only)
- **🏪 Competitors tab** — shop cards + benchmark table + sales/price comparison charts
- Shop selector dropdown populated from `shop_stats` view
- Demo mode with 20 synthetic products (no API required)
- `vercel.json` cron schedule: `0 0 * * *` (daily 8am MYT)

### V1.0 — 2026-05-12 — Initial Release
- Core dashboard: 📊 Overview, 🏆 Best Sellers, 💰 Pricing Intel, 🔑 Keywords, 📋 Scrape Log, ⚙️ Setup Guide
- Supabase schema: `shops`, `products`, `scrape_log`, `latest_products` view, `shop_stats` view
- `api/save.js` — browser scraper POST endpoint with batch upsert
- `api/data.js` — shop list + products GET endpoint
- `cron-scrape.js` — Vercel cron scraper with rate-limited pagination
- `scraper.js` — browser-side scraper for Claude in Chrome
- First data: buddysnack scraped (223 products, images, pricing, ratings)
- Light theme: Inter font, orange accent (#f97316), mobile-first responsive design

---

## Roadmap

- [ ] V1.7 — Stock Alert System (flag competitors going low stock)
- [ ] V1.8 — Price Change Detection (daily price delta per product)
- [ ] V1.9 — Discovered Shop Enrichment (auto-fetch real username/followers for `disc_` placeholder shops)
- [ ] V2.0 — Multi-niche support (expand beyond battery/electronics category)
