// ============================================================
// ShopeeScope Scraper — Run via Claude in Chrome javascript_tool
// Must be on any shopee.com.my tab when running
// ============================================================

const VERCEL_URL = 'https://YOUR-PROJECT.vercel.app'; // ← change this
const SHOP_USERNAMES = [
  'competitor_shop_1.my',   // ← add your competitor usernames
  'competitor_shop_2.my',
];

// ── Helpers ──────────────────────────────────────────────────
const H = { 'x-api-source': 'pc', 'x-shopee-language': 'en' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shopee = async (path) => {
  const r = await fetch(`https://shopee.com.my${path}`, { headers: H });
  if (!r.ok) throw new Error(`Shopee API ${r.status}: ${path}`);
  return r.json();
};

// ── Scrape one shop ──────────────────────────────────────────
async function scrapeShop(username) {
  console.log(`\n📡 Scraping: ${username}`);

  // 1. Shop profile
  const shopRes = await shopee(`/api/v4/shop/get_shop_detail?username=${username}`);
  if (!shopRes.data) throw new Error(`Shop not found: ${username}`);
  const shop = shopRes.data;
  console.log(`✓ Shop: ${shop.name} | ${shop.item_count} items | ${shop.follower_count} followers`);

  // 2. All product listings (paginated)
  let items = [], offset = 0;
  while (true) {
    const d = await shopee(
      `/api/v4/search/search_items?by=sales&limit=60&match_id=${shop.shopid}` +
      `&newest=${offset}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`
    );
    const batch = d.items || [];
    if (!batch.length) break;
    items.push(...batch.map(i => i.item_basic));
    console.log(`  ↳ fetched ${items.length} products...`);
    if (batch.length < 60) break;
    offset += 60;
    await sleep(400);
  }
  console.log(`✓ Total: ${items.length} products`);

  // 3. Save to Supabase via Vercel API
  const res = await fetch(`${VERCEL_URL}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shop, products: items, username })
  });
  const result = await res.json();
  if (!result.ok) throw new Error(`Save failed: ${result.error}`);
  console.log(`✅ Saved ${result.saved} products for ${result.shop}`);
  return result;
}

// ── Main: scrape all shops ────────────────────────────────────
const results = [];
for (const username of SHOP_USERNAMES) {
  try {
    const r = await scrapeShop(username);
    results.push({ username, status: 'ok', saved: r.saved });
    await sleep(1000); // be polite between shops
  } catch (err) {
    console.error(`❌ Failed ${username}: ${err.message}`);
    results.push({ username, status: 'error', error: err.message });
  }
}

console.log('\n📊 Scrape Summary:');
console.table(results);
return results;
