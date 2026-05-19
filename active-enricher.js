// ============================================================
// ShopeeScope — Active Seller Enricher
// Run via Claude in Chrome javascript_tool (on any shopee.com.my tab)
//
// Strategy:
//   1. /api/data?type=active-sellers → products with historical_sold delta > 0 today
//   2. item/get for each active seller → exact variant stock (no rounding)
//   3. Save to product_variants → variant_velocity view shows precise stock delta
//
// Coverage: ALL products are checked. Only active sellers get item/get.
// Accuracy: stock delta (not historical_sold) → exact units sold per SKU.
// ============================================================

const VERCEL  = 'https://vinus-ss.vercel.app';
const DELAY   = 4200;  // ms between item/get calls — adjust up if you get 90309999
const BATCH   = 60;    // variants per save call

const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 1000)));

const shopeeItem = async (itemid, shopid) => {
  const r = await fetch(
    `https://shopee.com.my/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`,
    { credentials: 'include', headers: { 'x-api-source': 'pc', 'x-shopee-language': 'en', 'Accept': 'application/json', 'Referer': `https://shopee.com.my/product/${shopid}/${itemid}` } }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error && j.error !== 0) throw new Error(`err ${j.error}`);
  return j;
};

const saveBatch = async (variants) => {
  if (!variants.length) return 0;
  const r = await fetch(`${VERCEL}/api/save-variants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variants })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'save failed');
  return j.saved || variants.length;
};

// Track in window for monitoring
window._AE = { running: true, shop: '', i: 0, n: 0, variants: 0, errors: 0, skipped: 0, shops: [] };
const log = (...a) => { console.log(...a); };

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

(async () => {
  const today = new Date().toISOString().split('T')[0];
  log(`\n🚀 Active Enricher — ${today} | delay: ${DELAY}ms`);

  let grandTotal = 0, grandActive = 0, grandVariants = 0, grandErrors = 0;

  for (const shop of SHOPS) {
    window._AE.shop = shop.username;
    log(`\n📡 ${shop.username}`);

    // 1. Get active sellers for this shop
    let active = [], total = 0;
    try {
      const r = await fetch(`${VERCEL}/api/data?type=active-sellers&shopid=${shop.shopid}`);
      if (!r.ok) throw new Error(`API ${r.status}`);
      const d = await r.json();
      active = d.active || [];
      total  = d.total || 0;
      grandTotal += total;
      grandActive += active.length;
      const byDelta  = active.filter(p => p.needs_enrich_reason === 'delta').length;
      const byForce  = active.filter(p => p.needs_enrich_reason === 'high_volume_force').length;
      log(`  ${total} products checked → ${active.length} to enrich (${byDelta} delta, ${byForce} high-vol force)`);
    } catch(e) {
      log(`  ❌ Failed to load: ${e.message}`);
      continue;
    }

    if (!active.length) {
      log(`  ⏭️ No sales today — skipping`);
      window._AE.shops.push({ shop: shop.username, total, active: 0, variants: 0 });
      window._AE.skipped++;
      await sleep(1000);
      continue;
    }

    // 2. item/get for each active seller
    const buf = [];
    let shopVars = 0, shopErrs = 0;
    window._AE.n = active.length;

    for (let i = 0; i < active.length; i++) {
      const p = active[i];
      window._AE.i = i + 1;

      try {
        await sleep(DELAY);
        const d = await shopeeItem(p.itemid, shop.shopid);
        if (!d.data) { shopErrs++; continue; }

        const item = d.data;
        const vt = (item.tier_variations || []).map(v => v.name).join(' / ') || 'single';

        if (item.models && item.models.length > 0) {
          item.models.forEach(m => buf.push({
            shopid: shop.shopid, itemid: p.itemid, model_id: m.modelid || 0,
            username: shop.username, product_name: p.name,
            variant_name: m.name || 'Default', variant_sku: m.model_sku || '',
            variation_type: vt,
            price: (m.price || 0) / 100000,
            stock: m.stock || 0,
            sold: m.sold || 0,
            scraped_date: today, scraped_at: new Date().toISOString()
          }));
        } else {
          buf.push({
            shopid: shop.shopid, itemid: p.itemid, model_id: 0,
            username: shop.username, product_name: p.name,
            variant_name: 'Default', variant_sku: '', variation_type: 'single',
            price: (p.price_min || 0) / 100000,
            stock: item.stock_info?.summary_info?.total_available_stock ?? p.stock ?? 0,
            sold: item.sold || 0,
            scraped_date: today, scraped_at: new Date().toISOString()
          });
        }

        if (i % 10 === 9) log(`  [${i+1}/${active.length}] buffered ${buf.length} variants`);

        // Flush buffer every BATCH variants
        if (buf.length >= BATCH) {
          const chunk = buf.splice(0, BATCH);
          shopVars += await saveBatch(chunk);
          window._AE.variants = grandVariants + shopVars;
        }

      } catch(e) {
        shopErrs++;
        grandErrors++;
        const msg = e.message;
        // Rate limit: wait and retry
        if (msg.includes('90309999') || msg.includes('429') || msg.includes('403')) {
          log(`  ⚠️ Rate limit at [${i+1}/${active.length}] — cooling 90s...`);
          await sleep(90000);
          i--; // retry
          continue;
        }
        if (i % 20 === 0) log(`  ✗ ${p.itemid}: ${msg}`);
      }
    }

    // Flush remaining
    if (buf.length > 0) shopVars += await saveBatch(buf);
    grandVariants += shopVars;
    window._AE.variants = grandVariants;

    log(`  ✅ ${shop.username}: ${active.length} enriched → ${shopVars} variants saved | ${shopErrs} errors`);
    window._AE.shops.push({ shop: shop.username, total, active: active.length, variants: shopVars, errors: shopErrs });
    window._AE.errors = grandErrors;
    await sleep(6000); // pause between shops
  }

  window._AE.running = false;
  log(`\n📊 Done — ${today}`);
  log(`  Products checked:   ${grandTotal}`);
  log(`  Active sellers:     ${grandActive} (${grandTotal ? (grandActive/grandTotal*100).toFixed(1) : 0}%)`);
  log(`  Variants saved:     ${grandVariants}`);
  log(`  Errors:             ${grandErrors}`);
  console.table(window._AE.shops);
})();

// To monitor:  window._AE
'✅ Enricher launched — window._AE for progress';
