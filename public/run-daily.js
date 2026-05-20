// ============================================================
// ShopeeScope — Daily Runner (Browser版，整合产品爬取 + Variant Enrichment)
// 在 shopee.com.my 标签页运行（需要登录）
//
// 每个店流程：
//   Phase 1 → search_items (3 sort orders) → 存 products 表
//   Phase 2 → active-sellers API → 找今日有销量的产品
//   Phase 3 → item/get → 存 product_variants 表
// ============================================================

const VERCEL       = 'https://vinus-ss.vercel.app';
const DELAY_SEARCH = 800;   // ms between search_items pages
const DELAY_ITEM   = 3500;  // ms between item/get calls
const BATCH        = 60;    // variants per save call

const SHOPS = [
  { username: 'buddysnack',           shopid: 3693884 },
  { username: 'winstartech',          shopid: 65231794 },
  { username: '1stopbatteries',       shopid: 436346628 },
  { username: 'icare4allshop',        shopid: 101702703 },
  { username: 'energizerbatteryhub',  shopid: 1616613112 },
  { username: 'gadgetspecialist',     shopid: 57639219 },
  { username: 'gou.ori',              shopid: 3614138 },
  { username: 'tenbucksfood',         shopid: 299773965 },
  { username: 'dsconcept_store',      shopid: 1494888251 },
  { username: 'sxmixempire',          shopid: 902193943 },
  { username: 'r_in_g',               shopid: 1421385614 },
  { username: 'nextgenhardware.os',   shopid: 1088905843 },
  { username: 'ham_radios.my',        shopid: 1231953709 },
];

// ── Helpers ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 500)));

const shopeeHeaders = (shopid) => ({
  credentials: 'include',
  headers: {
    'x-api-source': 'pc', 'x-shopee-language': 'en',
    'Accept': 'application/json',
    'Referer': `https://shopee.com.my/shop/${shopid}/search`
  }
});

const shopeeSearch = async (shopid, sortBy, offset) => {
  const url = `https://shopee.com.my/api/v4/search/search_items?by=${sortBy}&limit=60&match_id=${shopid}&newest=${offset}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`;
  const r = await fetch(url, shopeeHeaders(shopid));
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  const j = await r.json();
  if (j.error && j.error !== 0) throw new Error(`search err ${j.error}`);
  return j;
};

const shopeeItem = async (itemid, shopid) => {
  const r = await fetch(
    `https://shopee.com.my/api/v4/item/get?itemid=${itemid}&shopid=${shopid}`,
    { credentials: 'include', headers: { 'x-api-source': 'pc', 'x-shopee-language': 'en', 'Accept': 'application/json', 'Referer': `https://shopee.com.my/product/${shopid}/${itemid}` } }
  );
  if (!r.ok) throw new Error(`item HTTP ${r.status}`);
  const j = await r.json();
  if (j.error && j.error !== 0) throw new Error(`item err ${j.error}`);
  return j;
};

const saveProducts = async (shop, products, today) => {
  const rows = products.map(p => ({
    shopid: shop.shopid, itemid: p.itemid, username: shop.username,
    name: p.name,
    price_min: p.price_min || 0,
    price_max: p.price_max || p.price_min || 0,
    price_min_before_discount: p.price_min_before_discount || p.price_min || 0,
    raw_discount: p.raw_discount || 0,
    historical_sold: p.historical_sold || 0,
    sold: p.sold || 0,
    liked_count: p.liked_count || 0,
    stock: p.stock || 0,
    rating_star: p.item_rating?.rating_star || 0,
    rating_count: p.item_rating?.rating_count?.reduce((a,b)=>a+b,0) || 0,
    brand: p.brand || '', catid: p.catid || 0,
    image: p.image || '', ctime: p.ctime || 0,
    scraped_date: today, scraped_at: new Date().toISOString()
  }));

  const SAVE_BATCH = 50;
  for (let i = 0; i < rows.length; i += SAVE_BATCH) {
    const r = await fetch(`${VERCEL}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'products?on_conflict=shopid,itemid,scraped_date', data: rows.slice(i, i + SAVE_BATCH) })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'save products failed');
  }

  // 同时存 snapshots（用于 product_velocity）
  const snaps = rows.map(p => ({
    shopid: p.shopid, itemid: p.itemid, model_id: 0, username: p.username,
    product_name: p.name, variant_name: 'Default', variant_sku: '',
    variation_type: 'product',
    price: (p.price_min || 0) / 100000,
    stock: p.stock || 0,
    sold: p.historical_sold || 0,
    scraped_date: today, scraped_at: new Date().toISOString()
  }));
  for (let i = 0; i < snaps.length; i += SAVE_BATCH) {
    await fetch(`${VERCEL}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'snapshots?on_conflict=shopid,itemid,model_id,scraped_date', data: snaps.slice(i, i + SAVE_BATCH) })
    });
  }

  return rows.length;
};

const saveVariants = async (variants) => {
  if (!variants.length) return 0;
  const r = await fetch(`${VERCEL}/api/save-variants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variants })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'save variants failed');
  return j.saved || variants.length;
};

// ── Progress monitor ──────────────────────────────────────────
window._RD = {
  running: true, phase: '', shop: '', shopIdx: 0, shopTotal: SHOPS.length,
  searchPage: 0, itemI: 0, itemN: 0,
  products: 0, variants: 0, errors: 0,
  shops: []
};
const W = window._RD;
const log = (...a) => console.log('[RD]', ...a);

// CAPTCHA 检测
let _lastI = 0, _lastProg = Date.now();
window._rdWatcher = setInterval(() => {
  if (!W.running) { clearInterval(window._rdWatcher); return; }
  if (W.itemI !== _lastI) { _lastI = W.itemI; _lastProg = Date.now(); }
  const stuck = W.phase === 'enrich' && (Date.now() - _lastProg > 70000);
  const onCaptcha = location.href.includes('captcha') || location.href.includes('verify');
  if (stuck || onCaptcha) {
    document.title = '⚠️ CAPTCHA NEEDED';
    try { new Notification('ShopeeScope', { body: `${W.shop} — 请解CAPTCHA！` }); } catch(e){}
    const ctx = new AudioContext();
    [880, 1100].forEach((f, i) => setTimeout(() => {
      const o = ctx.createOscillator(); o.connect(ctx.destination);
      o.frequency.value = f; o.start(); setTimeout(()=>o.stop(), 300);
    }, i * 400));
  } else {
    const ph = W.phase === 'search' ? `搜索${W.searchPage}页` : `Enrich ${W.itemI}/${W.itemN}`;
    document.title = `[${W.shop} ${ph} | ${W.products}p ${W.variants}v] RD`;
  }
}, 20000);

// ── Main ──────────────────────────────────────────────────────
(async () => {
  const today = new Date().toISOString().split('T')[0];
  log(`🚀 run-daily 开始 — ${today} | ${SHOPS.length} 个店`);
  let grandProducts = 0, grandVariants = 0, grandErrors = 0;

  for (let si = 0; si < SHOPS.length; si++) {
    const shop = SHOPS[si];
    W.shop = shop.username;
    W.shopIdx = si + 1;
    W.phase = 'search';
    log(`\n${'─'.repeat(50)}`);
    log(`📡 [${si+1}/${SHOPS.length}] ${shop.username}`);

    // ── Phase 1: 爬产品列表 ──────────────────────────────────
    let products = [];
    try {
      const seenIds = new Set();
      const prodsMap = {};

      for (const sortBy of ['sales', 'ctime', 'price']) {
        let offset = 0, pageCount = 0;
        while (true) {
          W.searchPage = ++pageCount;
          await sleep(DELAY_SEARCH);
          let d;
          try { d = await shopeeSearch(shop.shopid, sortBy, offset); }
          catch(e) {
            if (e.message.includes('429') || e.message.includes('403')) {
              log(`  ⚠️ search 限流 — 冷却60s...`);
              await sleep(60000);
              continue;
            }
            throw e;
          }
          const batch = (d.items || []).map(i => i.item_basic).filter(Boolean);
          if (!batch.length) break;
          let newCount = 0;
          batch.forEach(p => {
            if (!seenIds.has(p.itemid)) { seenIds.add(p.itemid); prodsMap[p.itemid] = p; newCount++; }
          });
          if (batch.length < 60) break;
          offset += 60;
        }
        log(`  [${sortBy}] ${seenIds.size} 个唯一产品`);
        await sleep(1500);
      }

      products = Object.values(prodsMap);
      if (!products.length) throw new Error('0 products — 可能需要登录或已被限流');

      // 保存产品
      const saved = await saveProducts(shop, products, today);
      grandProducts += saved;
      W.products = grandProducts;
      log(`  ✅ Phase 1: ${saved} 个产品已保存`);

    } catch(e) {
      log(`  ❌ Phase 1 失败: ${e.message}`);
      W.shops.push({ shop: shop.username, products: 0, active: 0, variants: 0, error: e.message });
      grandErrors++;
      await sleep(5000);
      continue;
    }

    // ── Phase 2: 获取需要 enrich 的产品 ─────────────────────
    W.phase = 'enrich';
    let active = [];
    try {
      await sleep(2000); // 等 DB 写入完成
      const r = await fetch(`${VERCEL}/api/data?type=active-sellers&shopid=${shop.shopid}`);
      const d = await r.json();
      active = d.active || [];
      const byDelta = active.filter(p => p.needs_enrich_reason === 'delta').length;
      const byForce = active.filter(p => p.needs_enrich_reason === 'high_volume_force').length;
      log(`  Phase 2: ${products.length} 产品 → ${active.length} 需要 enrich (${byDelta} delta + ${byForce} 高量)`);
    } catch(e) {
      log(`  ❌ Phase 2 失败: ${e.message}`);
    }

    // ── Phase 3: item/get Enrichment ─────────────────────────
    if (!active.length) {
      log(`  ⏭️ 无活跃产品，跳过 enrich`);
      W.shops.push({ shop: shop.username, products: products.length, active: 0, variants: 0 });
      await sleep(3000);
      continue;
    }

    const buf = [];
    let shopVars = 0, shopErrs = 0;
    W.itemN = active.length;
    W.itemI = 0;

    for (let i = 0; i < active.length; i++) {
      const p = active[i];
      W.itemI = i + 1;
      try {
        await sleep(DELAY_ITEM);
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
            stock: m.stock || 0, sold: m.sold || 0,
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
          try { shopVars += await saveVariants(buf.splice(0, BATCH)); W.variants = grandVariants + shopVars; }
          catch(e) { log(`  ❌ saveVariants: ${e.message}`); }
        }

      } catch(e) {
        shopErrs++; grandErrors++;
        if (e.message.includes('90309999') || e.message.includes('429') || e.message.includes('403')) {
          log(`  ⚠️ 限流 [${i+1}/${active.length}] — 冷却90s...`);
          await sleep(90000); i--; continue;
        }
        if (shopErrs % 5 === 1) log(`  ✗ ${p.itemid}: ${e.message}`);
      }
    }

    if (buf.length > 0) {
      try { shopVars += await saveVariants(buf); }
      catch(e) { log(`  ❌ 最终 saveVariants: ${e.message}`); }
    }

    grandVariants += shopVars;
    W.variants = grandVariants;
    W.errors = grandErrors;

    log(`  ✅ ${shop.username}: ${products.length} 产品 | ${active.length} enrich | ${shopVars} variants | ${shopErrs} err`);
    W.shops.push({ shop: shop.username, products: products.length, active: active.length, variants: shopVars, errors: shopErrs });
    await sleep(5000);
  }

  W.running = false;
  clearInterval(window._rdWatcher);
  document.title = `✅ RD done — ${grandProducts}p ${grandVariants}v`;
  log(`\n${'═'.repeat(50)}`);
  log(`📊 run-daily 完成`);
  log(`  产品保存: ${grandProducts}`);
  log(`  Variants: ${grandVariants}`);
  log(`  错误:     ${grandErrors}`);
  console.table(W.shops);
})();

// 进度监控: window._RD
`✅ run-daily 已启动 — window._RD 查进度`;
