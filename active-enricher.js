// ============================================================
// ShopeeScope — Active Seller Enricher (Multi-Profile)
// Run via Claude in Chrome javascript_tool (shopee.com.my tab)
//
// 3 Chrome profiles, each logged into a different Shopee account:
//   Profile 1 → set SHARD = 0  (shops 0–4)
//   Profile 2 → set SHARD = 1  (shops 5–8)
//   Profile 3 → set SHARD = 2  (shops 9–12)
//
// All 3 run simultaneously — ~3× faster, separate rate limit counters.
// ============================================================

const SHARD  = 0;     // ← CHANGE THIS: 0, 1, or 2
const VERCEL = 'https://vinus-ss.vercel.app';
const DELAY  = 3500;  // ms between item/get — each profile has its own counter
const BATCH  = 60;    // variants per save call

// ── Shop list split into 3 shards ────────────────────────────
const ALL_SHOPS = [
  // Shard 0 — Profile 1
  { username: 'buddysnack',           shopid: 3693884 },
  { username: 'winstartech',          shopid: 65231794 },
  { username: '1stopbatteries',       shopid: 436346628 },
  { username: 'icare4allshop',        shopid: 101702703 },
  { username: 'energizerbatteryhub', shopid: 1616613112 },
  // Shard 1 — Profile 2
  { username: 'gadgetspecialist',     shopid: 57639219 },
  { username: 'gou.ori',             shopid: 3614138 },
  { username: 'tenbucksfood',         shopid: 299773965 },
  { username: 'dsconcept_store',      shopid: 1494888251 },
  // Shard 2 — Profile 3
  { username: 'sxmixempire',          shopid: 902193943 },
  { username: 'r_in_g',              shopid: 1421385614 },
  { username: 'nextgenhardware.os',   shopid: 1088905843 },
  { username: 'ham_radios.my',        shopid: 1231953709 },
];

const SHARD_RANGES = { 0: [0, 5], 1: [5, 9], 2: [9, 13] };
const [from, to] = SHARD_RANGES[SHARD] || [0, ALL_SHOPS.length];
const SHOPS = ALL_SHOPS.slice(from, to);

// ── Helpers ──────────────────────────────────────────────────
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

// ── Progress monitor ──────────────────────────────────────────
window._AE = window._AE || {};
window._AE[`shard${SHARD}`] = { running: true, shop: '', i: 0, n: 0, variants: 0, errors: 0, shops: [] };
const W = window._AE[`shard${SHARD}`];
const log = (...a) => console.log(`[S${SHARD}]`, ...a);

// ── Main ──────────────────────────────────────────────────────
(async () => {
  const today = new Date().toISOString().split('T')[0];
  log(`🚀 Shard ${SHARD} started — ${today} | shops: ${SHOPS.map(s=>s.username).join(', ')}`);
  log(`⚙️  Delay: ${DELAY}ms | ${SHOPS.length} shops`);

  let grandTotal = 0, grandActive = 0, grandVariants = 0, grandErrors = 0;

  for (const shop of SHOPS) {
    W.shop = shop.username;
    log(`\n📡 ${shop.username}`);

    let active = [], total = 0;
    try {
      const r = await fetch(`${VERCEL}/api/data?type=active-sellers&shopid=${shop.shopid}`);
      if (!r.ok) throw new Error(`API ${r.status}`);
      const d = await r.json();
      active = d.active || [];
      total  = d.total || 0;
      grandTotal  += total;
      grandActive += active.length;
      const byDelta = active.filter(p => p.needs_enrich_reason === 'delta').length;
      const byForce = active.filter(p => p.needs_enrich_reason === 'high_volume_force').length;
      log(`  ${total} products → ${active.length} to enrich (${byDelta} delta + ${byForce} high-vol)`);
    } catch(e) {
      log(`  ❌ Load failed: ${e.message}`);
      continue;
    }

    if (!active.length) {
      log(`  ⏭️ No active sellers — skip`);
      W.shops.push({ shop: shop.username, total, active: 0, variants: 0 });
      await sleep(800);
      continue;
    }

    const buf = [];
    let shopVars = 0, shopErrs = 0;
    W.n = active.length;

    for (let i = 0; i < active.length; i++) {
      const p = active[i];
      W.i = i + 1;

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

        if (i % 10 === 9) log(`  [${i+1}/${active.length}] ${shop.username} — ${buf.length} variants buffered`);

        if (buf.length >= BATCH) {
          shopVars += await saveBatch(buf.splice(0, BATCH));
          W.variants = grandVariants + shopVars;
        }

      } catch(e) {
        shopErrs++;
        grandErrors++;
        const msg = e.message;
        if (msg.includes('90309999') || msg.includes('429') || msg.includes('403')) {
          log(`  ⚠️ Rate limit [${i+1}/${active.length}] — cooling 90s...`);
          await sleep(90000);
          i--;
          continue;
        }
        if (shopErrs % 5 === 1) log(`  ✗ ${p.itemid}: ${msg}`);
      }
    }

    if (buf.length > 0) shopVars += await saveBatch(buf);
    grandVariants += shopVars;
    W.variants = grandVariants;
    W.errors   = grandErrors;

    log(`  ✅ ${shop.username}: ${active.length} enriched → ${shopVars} variants | ${shopErrs} err`);
    W.shops.push({ shop: shop.username, total, active: active.length, variants: shopVars, errors: shopErrs });
    await sleep(5000);
  }

  W.running = false;
  log(`\n📊 Shard ${SHARD} done`);
  log(`  Products checked: ${grandTotal}`);
  log(`  Active sellers:   ${grandActive}`);
  log(`  Variants saved:   ${grandVariants}`);
  log(`  Errors:           ${grandErrors}`);
  console.table(W.shops);
})();

// Monitor: window._AE.shard0 / shard1 / shard2
`✅ Shard ${SHARD} launched — window._AE.shard${SHARD} for progress`;
