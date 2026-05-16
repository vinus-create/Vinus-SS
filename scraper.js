// ============================================================
// ShopeeScope Scraper — Run via Claude in Chrome javascript_tool
// Must be on any shopee.com.my tab when running (logged in)
// ============================================================

const VERCEL_URL = 'https://vinus-ss.vercel.app';
const SHOP_USERNAMES = [
  'buddysnack',
  'winstartech',
  '1stopbatteries',
  'icare4allshop',
  'energizerbatteryhub',
  'gadgetspecialist',
  'gou.ori',
  'tenbucksfood',
  'dsconcept_store',
  'sxmixempire',
  'r_in_g',
  'nextgenhardware.os',
  'ham_radios.my',
];

// ── Helpers ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random()*400)));
const shopee = async (path) => {
  const r = await fetch(`https://shopee.com.my${path}`, {
    credentials: 'include',
    headers: { 'x-api-source': 'pc', 'x-shopee-language': 'en', 'Accept': 'application/json', 'Referer': 'https://shopee.com.my/' }
  });
  if (!r.ok) throw new Error(`Shopee API ${r.status}: ${path}`);
  return r.json();
};

// ── Scrape all products using 3 sort orders to bypass ~240 item cap ──
async function scrapeAllProducts(shopid) {
  const seenIds = new Set();
  const prodsMap = {};
  for (const sortBy of ['sales', 'ctime', 'price']) {
    let offset = 0, sortCount = 0;
    while (true) {
      const d = await shopee(
        `/api/v4/search/search_items?by=${sortBy}&limit=60&match_id=${shopid}` +
        `&newest=${offset}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`
      );
      const batch = (d.items || []).map(i => i.item_basic).filter(Boolean);
      if (!batch.length) break;
      let newItems = 0;
      batch.forEach(p => {
        if (!seenIds.has(p.itemid)) { seenIds.add(p.itemid); prodsMap[p.itemid] = p; newItems++; }
      });
      sortCount += batch.length;
      console.log(`  [${sortBy}] offset ${offset}: ${batch.length} items, ${newItems} new (total unique: ${seenIds.size})`);
      if (batch.length < 60) break;
      offset += 60;
      await sleep(800);
    }
    console.log(`  [${sortBy}] done: ${sortCount} fetched`);
    await sleep(1500); // pause between sort orders
  }
  return Object.values(prodsMap);
}

// ── Scrape one shop ──────────────────────────────────────────
async function scrapeShop(username) {
  console.log(`\n📡 Scraping: ${username}`);

  // 1. Shop profile
  const shopRes = await shopee(`/api/v4/shop/get_shop_detail?username=${username}`);
  if (!shopRes.data) throw new Error(`Shop not found: ${username}`);
  const shop = shopRes.data;
  console.log(`✓ Shop: ${shop.name} | ${shop.item_count} actual items | ${shop.follower_count} followers`);

  // 2. All products via 3-sort dedup strategy
  const items = await scrapeAllProducts(shop.shopid);
  console.log(`✓ Total scraped: ${items.length} / ${shop.item_count} (Shopee API cap may limit further)`);

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
    await sleep(8000); // 8s between shops to avoid CAPTCHA
  } catch (err) {
    console.error(`❌ Failed ${username}: ${err.message}`);
    results.push({ username, status: 'error', error: err.message });
  }
}

console.log('\n📊 Scrape Summary:');
console.table(results);
results;
