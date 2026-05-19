// ============================================================
// ShopeeScope — Reviews Scraper (No Login Required)
// Run via Claude in Chrome javascript_tool
// Can use any Chrome profile — Shopee login NOT needed
//
// What it does:
//   - Scrapes reviews for ALL products across all 13 shops
//   - Prioritises products with no reviews in DB yet
//   - Skips products already reviewed recently (within SKIP_DAYS)
//   - Up to MAX_REVIEWS per product (paginated)
//   - Saves to reviews table via /api/save
//
// Runs independently — no competition with active-enricher profiles.
// ============================================================

const VERCEL      = 'https://vinus-ss.vercel.app';
const DELAY       = 1200;    // ms between get_ratings calls — lighter than item/get
const MAX_REVIEWS = 30;      // reviews per product (3 pages × 10)
const SKIP_DAYS   = 7;       // skip products reviewed within this many days
const BATCH_SAVE  = 50;      // reviews per save call

const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 600)));

// Shopee reviews API — works without login
const getReviews = async (itemid, shopid, offset = 0) => {
  const url = `https://shopee.com.my/api/v2/item/get_ratings` +
    `?itemid=${itemid}&shopid=${shopid}&limit=10&offset=${offset}` +
    `&filter=0&type=0&exclude_filter=1&flag=1&fold_filter=0` +
    `&relevant_reviews=false&request_source=2`;
  const r = await fetch(url, {
    headers: {
      'x-api-source': 'pc',
      'x-shopee-language': 'en',
      'Accept': 'application/json',
      'Referer': `https://shopee.com.my/product/${shopid}/${itemid}`
    }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error && j.error !== 0) throw new Error(`err ${j.error}`);
  return j.data?.ratings || [];
};

const saveReviews = async (rows) => {
  if (!rows.length) return 0;
  const r = await fetch(`${VERCEL}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'reviews?on_conflict=shopid,itemid,ctime', data: rows })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'save failed');
  return j.saved || rows.length;
};

// Load all products for a shop, with existing review counts
const loadProducts = async (shopid) => {
  const [prodRes, revRes] = await Promise.all([
    fetch(`${VERCEL}/api/data?type=products&shopid=${shopid}&limit=2000`),
    fetch(`${VERCEL}/api/get-reviews?shopid=${shopid}&limit=5000`)
  ]);
  const products = prodRes.ok ? await prodRes.json() : [];
  const revData  = revRes.ok  ? await revRes.json()  : {};
  const reviews  = revData.reviews || [];

  // Map: itemid → { count, latest_ctime }
  const revMap = {};
  reviews.forEach(rv => {
    if (!revMap[rv.itemid]) revMap[rv.itemid] = { count: 0, latest: 0 };
    revMap[rv.itemid].count++;
    if ((rv.ctime || 0) > revMap[rv.itemid].latest) revMap[rv.itemid].latest = rv.ctime;
  });

  return { products, revMap };
};

// Progress monitor
window._RS = { running: true, shop: '', i: 0, n: 0, saved: 0, skipped: 0, shops: [] };
const log = (...a) => console.log('[Reviews]', ...a);

const SHOPS = [
  { username: 'buddysnack',           shopid: 3693884 },
  { username: 'winstartech',          shopid: 65231794 },
  { username: '1stopbatteries',       shopid: 436346628 },
  { username: 'icare4allshop',        shopid: 101702703 },
  { username: 'energizerbatteryhub', shopid: 1616613112 },
  { username: 'gadgetspecialist',     shopid: 57639219 },
  { username: 'gou.ori',             shopid: 3614138 },
  { username: 'tenbucksfood',         shopid: 299773965 },
  { username: 'dsconcept_store',      shopid: 1494888251 },
  { username: 'sxmixempire',          shopid: 902193943 },
  { username: 'r_in_g',              shopid: 1421385614 },
  { username: 'nextgenhardware.os',   shopid: 1088905843 },
  { username: 'ham_radios.my',        shopid: 1231953709 },
];

const skipCutoff = Date.now() / 1000 - SKIP_DAYS * 86400; // unix timestamp

(async () => {
  log(`🚀 Reviews scraper started | delay: ${DELAY}ms | max: ${MAX_REVIEWS}/product | skip if reviewed within ${SKIP_DAYS}d`);
  let grandSaved = 0, grandSkipped = 0, grandErrors = 0;

  for (const shop of SHOPS) {
    window._RS.shop = shop.username;
    log(`\n📡 ${shop.username}`);

    let products, revMap;
    try {
      ({ products, revMap } = await loadProducts(shop.shopid));
    } catch(e) {
      log(`  ❌ Load failed: ${e.message}`);
      continue;
    }

    // Sort: no reviews first, then oldest reviews first (prioritise gaps)
    const sorted = [...products].sort((a, b) => {
      const aRev = revMap[a.itemid];
      const bRev = revMap[b.itemid];
      if (!aRev && bRev)  return -1; // a has no reviews → first
      if (aRev  && !bRev) return 1;
      if (!aRev && !bRev) return (b.historical_sold || 0) - (a.historical_sold || 0);
      return (aRev.latest || 0) - (bRev.latest || 0); // oldest review first
    });

    // Skip products reviewed recently (latest review ctime > cutoff)
    const toScrape = sorted.filter(p => {
      const rv = revMap[p.itemid];
      if (!rv) return true;                          // never reviewed
      if (rv.latest < skipCutoff) return true;       // reviews are old — refresh
      return false;                                  // reviewed recently — skip
    });

    log(`  ${products.length} products | ${toScrape.length} to scrape | ${products.length - toScrape.length} skipped (recent)`);
    grandSkipped += products.length - toScrape.length;
    window._RS.n = toScrape.length;

    let shopSaved = 0, shopErrors = 0;
    const buf = [];

    for (let i = 0; i < toScrape.length; i++) {
      const p = toScrape[i];
      window._RS.i = i + 1;

      try {
        // Paginate: fetch up to MAX_REVIEWS (3 pages × 10)
        let productReviews = [];
        for (let offset = 0; offset < MAX_REVIEWS; offset += 10) {
          await sleep(DELAY);
          const batch = await getReviews(p.itemid, shop.shopid, offset);
          if (!batch.length) break;
          batch.forEach(rv => {
            if (!rv.comment) return;
            productReviews.push({
              shopid: shop.shopid,
              itemid: p.itemid,
              product_name: p.name,
              rating_star: rv.rating_star || 0,
              comment: rv.comment.substring(0, 500),
              author: rv.author_username || '',
              variant_bought: rv.product_items?.[0]?.variation_name || '',
              tags: (rv.tags || []).join(','),
              has_seller_reply: !!(rv.reply?.comment),
              ctime: rv.ctime || 0,
              scraped_at: new Date().toISOString()
            });
          });
          if (batch.length < 10) break; // last page
        }

        buf.push(...productReviews);
        if (i % 20 === 19) log(`  [${i+1}/${toScrape.length}] ${shop.username} — ${buf.length} reviews buffered`);

        // Flush buffer
        if (buf.length >= BATCH_SAVE) {
          shopSaved += await saveReviews(buf.splice(0, BATCH_SAVE));
          window._RS.saved = grandSaved + shopSaved;
        }

      } catch(e) {
        shopErrors++;
        grandErrors++;
        const msg = e.message;
        if (msg.includes('429') || msg.includes('403') || msg.includes('90309999')) {
          log(`  ⚠️ Rate limit [${i+1}/${toScrape.length}] — cooling 60s...`);
          await sleep(60000);
          i--;
          continue;
        }
        if (shopErrors % 10 === 1) log(`  ✗ ${p.itemid}: ${msg}`);
      }
    }

    // Flush remaining
    if (buf.length > 0) shopSaved += await saveReviews(buf);
    grandSaved  += shopSaved;
    grandSkipped += (products.length - toScrape.length);
    window._RS.saved   = grandSaved;
    window._RS.skipped = grandSkipped;

    log(`  ✅ ${shop.username}: ${shopSaved} reviews saved | ${shopErrors} errors`);
    window._RS.shops.push({ shop: shop.username, products: products.length, scraped: toScrape.length, saved: shopSaved, errors: shopErrors });
    await sleep(3000);
  }

  window._RS.running = false;
  log(`\n📊 Reviews scraper done`);
  log(`  Reviews saved:  ${grandSaved}`);
  log(`  Products skipped (recent): ${grandSkipped}`);
  log(`  Errors: ${grandErrors}`);
  console.table(window._RS.shops);
})();

// Monitor: window._RS
'✅ Reviews scraper launched — window._RS for progress';
