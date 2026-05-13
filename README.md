# ShopeeScope — Competitor Intelligence Dashboard

Shopee competitor scraping + analysis dashboard.
Built with: Supabase (database) + Vercel (hosting) + Vanilla HTML/JS (no build step needed)

## Project Structure

```
shopee-scope/
├── index.html          ← Main dashboard (Vercel serves this)
├── scraper.js          ← Run in Claude in Chrome javascript_tool
├── vercel.json         ← Vercel config (API route rewrites)
├── api/
│   └── products.js     ← Vercel serverless function (keeps Supabase key secret)
├── .env.local          ← Local dev secrets (never commit this)
└── README.md
```

## Setup

1. Create Supabase project → run SQL in `supabase_schema.sql`
2. Deploy to Vercel → add env vars SUPABASE_URL + SUPABASE_SERVICE_KEY
3. Open shopee.com.my in Claude in Chrome → run `scraper.js` via javascript_tool
4. Visit your Vercel URL on phone to see dashboard

## Environment Variables (set in Vercel dashboard)

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key   ← from Supabase Settings > API
```
