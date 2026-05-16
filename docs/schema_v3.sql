-- ============================================================
-- ShopeeScope Schema v3 — Auto-Scrape Cookie Support
-- Run this in Supabase SQL Editor
-- ============================================================

-- Config table: stores key-value pairs (e.g. Shopee session cookies)
CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Allow service role full access, public read blocked
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_only" ON config USING (auth.role() = 'service_role');

-- Verify
SELECT 'config table created' AS status;
