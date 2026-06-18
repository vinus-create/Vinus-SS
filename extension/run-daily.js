// ShopeeScope — Daily Runner
// Wrapped in IIFE so re-injection doesn't throw "already declared" errors

;(async () => {

// Guard: don't re-run if already running
if (window._RD?.running) { console.log('[RD] already running'); return; }

// Clear old intervals from any previous run
if (window._rdRelay)   { clearInterval(window._rdRelay);   window._rdRelay = null; }
if (window._rdWatcher) { clearInterval(window._rdWatcher); window._rdWatcher = null; }

const VERCEL       = 'https://vinus-ss.vercel.app';
const DELAY_SEARCH = 2000;   // between search pages
const DELAY_ITEM   = 5000;   // between item/get calls
const MAX_ENRICH   = 50;     // max enrich per shop per run
const SHOP_REST    = 180000; // 3 min rest between shops
const BATCH        = 60;

// 硬编码兜底列表（数据库拉取失败时使用）
let SHOPS = [
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
// 从数据库动态加载，自动包含通过扩展添加的新店
try {
  const _sr = await fetch(`${VERCEL}/api/data?type=shops`);
  const _sd = await _sr.json();
  if (Array.isArray(_sd) && _sd.length > 0) {
    const dyn = _sd.filter(s => s.username && s.shopid).map(s => ({ username: s.username, shopid: s.shopid }));
    if (dyn.length >= SHOPS.length) { SHOPS = dyn; console.log('[RD] 动态店铺列表：', dyn.length, '个'); }
  }
} catch(e) { console.log('[RD] 使用硬编码店铺列表'); }

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

  // Upsert minimal shop record so it appears in shop_stats (which JOINs the shops table)
  await fetch(`${VERCEL}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'shops?on_conflict=username', data: [{ username: shop.username, shopid: shop.shopid }] })
  });

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

  // 同时存 snapshots
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

// 写 scrape_log — 让 Dashboard Scrape Log 页显示 Extension 运行记录
const logShop = async (shop, totalItems, status, durationMs, errorMsg) => {
  try {
    const row = { username: shop.username, shopid: shop.shopid, total_items: totalItems, status, duration_ms: durationMs };
    if (errorMsg) row.error_msg = String(errorMsg).substring(0, 200);
    await fetch(`${VERCEL}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'scrape_log', data: [row] })
    });
    // 记录已写过 log，避免重复
    if (status === 'success') {
      const LS_LOGGED = `SS_logged_${today}`;
      const lst = JSON.parse(localStorage.getItem(LS_LOGGED) || '[]');
      if (!lst.includes(shop.username)) { lst.push(shop.username); localStorage.setItem(LS_LOGGED, JSON.stringify(lst)); }
    }
  } catch(e) { log(`  ⚠️ logShop failed: ${e.message}`); }
};

// ── Progress state ────────────────────────────────────────────
window._RD = {
  running: true, phase: '', shop: '', shopIdx: 0, shopTotal: SHOPS.length,
  searchPage: 0, itemI: 0, itemN: 0,
  products: 0, variants: 0, errors: 0,
  shops: [], shopList: SHOPS.map(s => s.username)
};
const W = window._RD;
const log = (...a) => console.log('[RD]', ...a);

// Direct relay via postMessage → content.js → background → popup
function _rdSend() {
  window.postMessage({ type: 'RD_UPDATE', data: { ...W } }, '*');
}
window._rdRelay = setInterval(() => {
  if (!W.running) { clearInterval(window._rdRelay); _rdSend(); return; }
  _rdSend();
  const ph = W.phase === 'search' ? `搜索${W.searchPage}页` : `Enrich ${W.itemI}/${W.itemN}`;
  document.title = `[${W.shop} ${ph} | ${W.products}p ${W.variants}v] RD`;
}, 3000);

// ── CAPTCHA 检测与处理 ────────────────────────────────────────
let _lastI = 0, _lastProg = Date.now();
window._rdWatcher = setInterval(() => {
  if (!W.running) { clearInterval(window._rdWatcher); return; }
  if (W.itemI !== _lastI) { _lastI = W.itemI; _lastProg = Date.now(); }
  // stuck > 120s (above 90s rate-limit cooldown) OR URL has captcha
  const stuck = W.phase === 'enrich' && (Date.now() - _lastProg > 120000);
  const onCaptcha = location.href.includes('captcha') || location.href.includes('verify');
  if (stuck || onCaptcha) {
    window.postMessage({ type: 'CAPTCHA_DETECTED', shop: W.shop }, '*');
  }
}, 15000);

// CAPTCHA 检测到 → 暂停并等待解决（手动滑或自动解），解开后【自动继续】同一个 run。
// 不再停止整个 run，所以采集（含变体 enrich）会从中断处接着跑，无需停止/重跑。
const onCaptchaNow = () => location.href.includes('captcha') || location.href.includes('/verify');

// 找到 GeeTest 滑块的位置（视口 CSS 像素），交给 background 用 chrome.debugger 真实拖动
function getSliderRects() {
  const pick = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r && r.width > 10 && r.height > 5) return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    return null;
  };
  const bg = pick(['.geetest_canvas_bg', '.geetest_bg', 'canvas.geetest_canvas_bg', '[class*="captcha"] canvas', '[class*="puzzle"] canvas', '.captcha-bg']);
  const handle = pick(['.geetest_slider_button', '.geetest_btn', '.secsdk-captcha-drag-icon', '[class*="slider"] [class*="btn"]', '[class*="drag"][class*="btn"]', '[class*="drag"]']);
  const slice = pick(['.geetest_canvas_slice', '.geetest_slice', 'canvas.geetest_canvas_slice', '[class*="slice"] canvas', '[class*="piece"] canvas']);
  if (!bg || !handle) return null;
  return { bg, handle, slice };
}

async function waitForCaptchaClear(maxMs = 900000) {
  if (!onCaptchaNow()) return true;
  W.paused = true;
  W.phase = 'captcha';
  window.postMessage({ type: 'CAPTCHA_DETECTED', shop: W.shop }, '*');
  document.title = '⚠️ CAPTCHA — 自动解中／解不开就手动滑，会自动继续';
  log('⏸️ CAPTCHA — 尝试自动解；解不开就手动滑一下，会【自动继续】');

  let htmlLogged = false;
  const requestSolve = () => {
    if (!onCaptchaNow()) return;
    const rects = getSliderRects();
    if (rects) {
      window.postMessage({ type: 'SS_SOLVE_CAPTCHA', rects }, '*'); // → content.js → background(chrome.debugger)
    } else if (!htmlLogged) {
      htmlLogged = true;
      const w = document.querySelector('[class*="geetest"],[class*="captcha"],[class*="verify"]');
      log('🧩 未识别滑块元素（请手动滑）。调试HTML:', (w ? w.outerHTML : '').slice(0, 300));
    }
  };
  requestSolve();

  const start = Date.now();
  let lastSolve = Date.now();
  while (onCaptchaNow()) {
    if (!W.running) return false;                       // 用户手动按了停止
    if (Date.now() - start > maxMs) { log('⌛ 等待 CAPTCHA 超时，停止'); return false; }
    if (Date.now() - lastSolve > 12000) { requestSolve(); lastSolve = Date.now(); } // 每 12s 重试自动解
    await new Promise(r => setTimeout(r, 3000));        // 每 3s 检查一次是否已解开
  }
  W.paused = false;
  log('✅ CAPTCHA 已解决 — 继续采集');
  window.postMessage({ type: 'RD_UPDATE', data: { ...W } }, '*');
  await sleep(2500); // 让页面稳定后再继续请求
  return true;
}

// ── Main ──────────────────────────────────────────────────────
const today = new Date().toLocaleDateString('en-CA');
log(`🚀 run-daily 开始 — ${today} | ${SHOPS.length} 个店`);
let grandProducts = 0, grandVariants = 0, grandErrors = 0;

// 加载今日已采集的店：查数据库（最可靠）+ localStorage（当前会话缓存）
const LS_KEY = `SS_done_${today}`;
const _doneList = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
const scrapedToday = new Set(_doneList);
const scrapedTodayCounts = {}; // username → product count
try {
  const r = await fetch(`${VERCEL}/api/data?type=scraped-today`);
  const d = await r.json();
  (d.shops || []).forEach(u => {
    scrapedToday.add(u);
    if (!_doneList.includes(u)) _doneList.push(u);
    if (d.counts?.[u]) scrapedTodayCounts[u] = d.counts[u];
  });
  localStorage.setItem(LS_KEY, JSON.stringify(_doneList));
  // 对今日已采集但还没写过 log 的店，补写 success 记录（兼容旧版没有 logShop 时跑的采集）
  const LS_LOGGED = `SS_logged_${today}`;
  const _loggedList = JSON.parse(localStorage.getItem(LS_LOGGED) || '[]');
  const loggedSet = new Set(_loggedList);
  const toLog = (d.shops || []).filter(u => !loggedSet.has(u));
  if (toLog.length) {
    log(`📝 补写 ${toLog.length} 个店的 scrape log...`);
    for (const u of toLog) {
      const shop = SHOPS.find(s => s.username === u);
      if (!shop) continue;
      await logShop(shop, scrapedTodayCounts[u] || 0, 'success', 0, null);
      _loggedList.push(u);
    }
    localStorage.setItem(LS_LOGGED, JSON.stringify(_loggedList));
  }
} catch(e) {}
if (scrapedToday.size) log(`⏭️ 今日已完成，跳过: ${[...scrapedToday].join(', ')}`);

for (let si = 0; si < SHOPS.length; si++) {
  if (!W.running) break; // 停止信号（CAPTCHA/用户手动停止）
  const shop = SHOPS[si];

  // 产品今日已采？→ 只跳过【产品搜索】，仍然继续补 variants（之前遇 CAPTCHA 停了没采到变体）
  const productsDone = scrapedToday.has(shop.username);

  W.shop = shop.username;
  W.shopIdx = si + 1;
  W.phase = productsDone ? 'enrich' : 'search';
  const shopStarted = Date.now();
  log(`\n${'─'.repeat(50)}`);
  log(`📡 [${si+1}/${SHOPS.length}] ${shop.username}${productsDone ? '（产品已采，补 variants）' : ''}`);

  // ── Phase 1: 爬产品列表（今日已采则跳过搜索，直接去补 variants）──────────
  let products = [];
  if (productsDone) {
    log(`  ⏭️ 跳过产品搜索（今日已采 ${scrapedTodayCounts[shop.username] || 0} 个），直接补 variants`);
  } else try {
    const seenIds = new Set();
    const prodsMap = {};

    for (const sortBy of ['sales', 'ctime', 'price']) {
      let offset = 0, pageCount = 0, rateRetries = 0;
      while (true) {
        W.searchPage = ++pageCount;
        await sleep(DELAY_SEARCH);
        let d;
        try { d = await shopeeSearch(shop.shopid, sortBy, offset); }
        catch(e) {
          if (onCaptchaNow()) { if (await waitForCaptchaClear()) { pageCount--; continue; } else { W.running = false; break; } }
          if (e.message.includes('429') || e.message.includes('403') || e.message.includes('90309999')) {
            rateRetries++;
            if (rateRetries >= 3) { log(`  ⚠️ search [${sortBy}] 限流超3次，跳过此排序`); break; }
            log(`  ⚠️ search 限流 (${rateRetries}/3) — 冷却90s...`);
            await sleep(90000);
            pageCount--; // don't count rate-limit retries as page advances
            continue;
          }
          throw e;
        }
        rateRetries = 0; // reset on success
        if (onCaptchaNow()) { if (!(await waitForCaptchaClear())) { W.running = false; break; } pageCount--; continue; }
        const batch = (d.items || []).map(i => i.item_basic).filter(Boolean);
        if (!batch.length) break;
        let newCount = 0;
        batch.forEach(p => {
          if (!seenIds.has(p.itemid)) { seenIds.add(p.itemid); prodsMap[p.itemid] = p; newCount++; }
        });
        W.products = grandProducts + seenIds.size; // show found count during search
        if (batch.length < 60 || newCount === 0) break; // stop if last page or all duplicates
        offset += 60;
      }
      log(`  [${sortBy}] ${seenIds.size} 个唯一产品`);
      await sleep(1500);
    }

    products = Object.values(prodsMap);
    if (!products.length) throw new Error('0 products — 可能需要登录或已被限流');

    const saved = await saveProducts(shop, products, today);
    grandProducts += saved;
    W.products = grandProducts;
    // 记录已完成，下次重跑（包括换账号后）会跳过
    scrapedToday.add(shop.username);
    _doneList.push(shop.username);
    localStorage.setItem(LS_KEY, JSON.stringify(_doneList));
    log(`  ✅ Phase 1: ${saved} 个产品已保存`);

  } catch(e) {
    if (e.message === 'CAPTCHA_STOP') break; // 停止整个 run
    log(`  ❌ Phase 1 失败: ${e.message}`);
    W.shops.push({ shop: shop.username, products: 0, active: 0, variants: 0, error: e.message });
    grandErrors++;
    await logShop(shop, 0, 'error', Date.now() - shopStarted, e.message);
    await sleep(5000);
    continue;
  }

  // ── Phase 2: 获取需要 enrich 的产品 ─────────────────────
  W.phase = 'enrich';
  let active = [];
  try {
    await sleep(2000);
    const r = await fetch(`${VERCEL}/api/data?type=active-sellers&shopid=${shop.shopid}`);
    const d = await r.json();
    active = d.active || [];
    // Sort by delta desc, cap at MAX_ENRICH to avoid account bans
    active.sort((a, b) => (b.sold_today_est || 0) - (a.sold_today_est || 0));
    if (active.length > MAX_ENRICH) {
      log(`  ⚡ ${active.length} active → 限制为 ${MAX_ENRICH}`);
      active = active.slice(0, MAX_ENRICH);
    }
    log(`  Phase 2: ${products.length} 产品 → ${active.length} enrich`);
  } catch(e) {
    log(`  ❌ Phase 2 失败: ${e.message}`);
  }

  // ── Phase 3: item/get Enrichment ─────────────────────────
  if (!active.length) {
    log(`  ⏭️ 无活跃产品，跳过 enrich`);
    W.shops.push({ shop: shop.username, products: products.length, active: 0, variants: 0 });
    await logShop(shop, products.length, 'success', Date.now() - shopStarted, null);
    await sleep(3000);
    continue;
  }

  const buf = [];
  let shopVars = 0, shopErrs = 0;
  W.itemN = active.length;
  W.itemI = 0;

  for (let i = 0; i < active.length; i++) {
    if (!W.running) break;
    if (onCaptchaNow()) { if (!(await waitForCaptchaClear())) break; } // 解开滑块后接着 enrich
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
      if (onCaptchaNow()) { if (await waitForCaptchaClear()) { i--; continue; } else break; } // 解开后重试本商品
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
  await logShop(shop, products.length, 'success', Date.now() - shopStarted, null);
  if (!W.running) break;
  if (si < SHOPS.length - 1) {
    log(`  ⏸️ 店间休息 3 分钟...`);
    const restSec = Math.round(SHOP_REST / 1000);
    for (let t = restSec; t > 0 && W.running; t--) {
      W.phase = `rest:${t}`;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
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

})(); // end IIFE
