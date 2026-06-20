// ShopeeScope — CDP Network-interception scraper (runs in the service worker).
// =============================================================================
// WHY THIS EXISTS:
// Synthesizing /api/v4 fetches (run-daily.js) lacks Shopee's per-request signature
// headers — x-sap-ri / x-sap-sec / af-ac-enc-dat / af-ac-enc-sz-token — generated
// by Shopee's Security SDK from device fingerprint + session + timing. Missing them
// => error 90309999 + canvas captcha, even from the real logged-in browser.
//
// THE FIX (the "right way"): don't synthesize. NAVIGATE the real tab so Shopee's
// OWN front-end fires the calls (valid signatures) and CAPTURE the responses via
// chrome.debugger Network domain. We just read the JSON the browser already fetched.
//
// Loaded by background.js via importScripts('interceptor.js'). Needs 'debugger' perm
// (already granted). Shows the "ShopeeScope started debugging this browser" banner
// for the whole run — expected for an owner-run tool.
//
// v1 scope: product-list capture (search_items) for N shops, saved to Vercel, with
// rich diagnostics (response count, error codes, pagination offsets) so we learn the
// real pagination before building variant capture (item/get / pdp/get_pc).
// =============================================================================

const _IC_VERCEL = 'https://vinus-ss.vercel.app';
const _icSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _icLog = (...a) => console.log('[intercept]', ...a);
let _icRunning = false;

// Full run state lives in the SW (survives popup open/close). var → readable from background.js.
var _icState = null;
function _icExplainErr(d) {
  if (d.blocked) return '验证页中断 — 在标签页手动解开验证码，再点采集会从未完成的店继续';
  if (d.err === 90309999) return 'Shopee 限流（请求太快）— 稍后再试或放慢节奏';
  if (d.err && d.err !== 0) return `Shopee 接口错误 ${d.err}`;
  return '0 产品 — 可能未登录 / 店铺无货 / 被限流';
}
function _icReport(d) {
  if (!_icState || d.phase === 'run-start') {
    _icState = { startTs: Date.now(), endTs: null, total: d.total || 1, cur: '采集中', shops: {}, prod: 0, vars: 0, errors: [] };
  }
  const st = _icState;
  if (d.phase === 'start') { st.shops[d.shop] = { label: '采集中...', done: false }; st.cur = d.shop; }
  else if (d.phase === 'capture') { if (st.shops[d.shop]) st.shops[d.shop].label = `${d.products} 产品`; }
  else if (d.phase === 'variants') { if (st.shops[d.shop]) st.shops[d.shop].label = `变体 ${d.i}/${d.n}`; st.cur = `${d.shop}（变体）`; }
  else if (d.phase === 'captcha') { st.cur = '⏸️ 验证码 — 自动解中 / 手动解亦可，会自动继续'; }
  else if (d.phase === 'done') {
    const err = !!(d.blocked || (d.err && d.err !== 0) || !d.products);
    st.shops[d.shop] = { label: `${d.products || 0}产品 ${d.variants || 0}变体`, done: true, err };
    st.prod += d.products || 0; st.vars += d.variants || 0;
    if (err) st.errors.push(`${d.shop}：${_icExplainErr(d)}`);
  }
  else if (d.phase === 'complete') { st.endTs = Date.now(); st.cur = '✅ 完成'; }
  else if (d.phase === 'error') { st.errors.push(d.msg || '未知错误'); }
  try { chrome.runtime.sendMessage({ type: 'IC_UPDATE', state: st }).catch(() => {}); } catch (e) {}
}

// Run controls (read by the loops). var → callable from background.js.
var _icControl = { stop: false, paused: false };
function icStop() { _icControl.stop = true; _icControl.paused = false; }
function icPause(p) {
  _icControl.paused = !!p;
  if (_icState && !_icState.endTs) { _icState.paused = !!p; _icState.cur = p ? '⏸️ 已暂停' : '采集中'; try { chrome.runtime.sendMessage({ type: 'IC_UPDATE', state: _icState }).catch(() => {}); } catch (e) {} }
}
async function _icWaitIfPaused() { while (_icControl.paused && !_icControl.stop) await _icSleep(500); }

// Attach a Network-response capture to a tab. onJson(url, json) fires for matched
// API responses. Returns a detach function. The debugger must already be attached.
function _icCapture(tabId, onJson) {
  const pending = new Map(); // requestId -> url (only endpoints we care about)
  const want = (u) => /\/api\/v4\/(search\/search_items|item\/get|pdp\/)/.test(u || '');
  const listener = async (src, method, params) => {
    if (!src || src.tabId !== tabId || !params) return;
    if (method === 'Network.responseReceived' && params.response && want(params.response.url)) {
      pending.set(params.requestId, params.response.url);
    } else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
      const url = pending.get(params.requestId);
      pending.delete(params.requestId);
      try {
        const res = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId });
        const text = res.base64Encoded ? atob(res.body) : res.body;
        onJson(url, JSON.parse(text));
      } catch (e) { _icLog('body read failed:', url, e && e.message); }
    }
  };
  chrome.debugger.onEvent.addListener(listener);
  return () => { try { chrome.debugger.onEvent.removeListener(listener); } catch (e) {} };
}

async function _icEval(tabId, expression) {
  try { return await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true }); }
  catch (e) { return null; }
}

// Scroll to the bottom to trigger lazy-loaded search pages / pagination.
async function _icScroll(tabId) {
  await _icEval(tabId, 'window.scrollTo(0, document.body.scrollHeight)');
}

async function _icCurrentUrl(tabId) {
  const r = await _icEval(tabId, 'location.href');
  return (r && r.result && r.result.value) || '';
}

// The 2026 shop search returns each item as a "card": item_basic=null, rich data in
// item_data with prices/sold further nested under item_card_display_price /
// item_card_display_sold_count, and name/image under item_card_displayed_asset.
// _icD() returns the rich object (with legacy item_basic fallback).
function _icD(p) { return (p && (p.item_data || p.item_basic)) || p || {}; }
function _icNum(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
function _icName(p) {
  const d = _icD(p), da = (p && p.item_card_displayed_asset) || {};
  return (p && (da.name || d.name || p.display_name || p.name || p.title)) || '';
}

// Normalize one raw search card → the products-table row shape. Handles BOTH the new
// nested card format and the legacy flat item_basic format (fallbacks).
function _icProductRow(p, shop, today) {
  const d = _icD(p);
  const dp = d.item_card_display_price || {};        // new price block
  const ds = d.item_card_display_sold_count || {};   // new sold block
  const da = p.item_card_displayed_asset || {};      // name / image(s)
  const rating = d.item_rating || {};
  const price = _icNum(dp.price) || _icNum(d.price_min) || _icNum(d.price);
  const before = _icNum(dp.original_price) || _icNum(dp.strikethrough_price)
    || _icNum(d.price_min_before_discount) || price;
  return {
    shopid: shop.shopid,
    itemid: d.itemid || p.itemid,
    username: shop.username,
    name: _icName(p),
    price_min: price,
    price_max: _icNum(d.price_max) || price,
    price_min_before_discount: before,
    raw_discount: _icNum(dp.discount) || _icNum(d.raw_discount),
    historical_sold: _icNum(ds.historical_sold_count) || _icNum(d.historical_sold),
    sold: _icNum(ds.monthly_sold_count) || _icNum(d.sold),
    liked_count: _icNum(d.liked_count),
    stock: _icNum(d.stock), // not in search card → 0; filled by variant capture (item/get)
    rating_star: _icNum(rating.rating_star),
    rating_count: (rating.rating_count && rating.rating_count.reduce((a, b) => a + b, 0)) || 0,
    brand: (d.global_brand && (d.global_brand.brand_name || d.global_brand.name)) || d.brand || '',
    catid: _icNum(d.catid),
    image: da.image || d.image || '',
    images: da.images || d.images || [], // all product photo hashes
    ctime: _icNum(d.ctime),
    scraped_date: today,
    scraped_at: new Date().toISOString(),
  };
}

// ── product save (ported from run-daily.js saveProducts) ─────────────────────
async function _icSaveProducts(shop, products, today) {
  const rows = products
    .map((p) => _icProductRow(p, shop, today))
    .filter((r) => r.itemid && r.name); // drop incomplete rows (avoids not-null crash)

  if (!rows.length) { _icLog('  ⚠️ 0 saveable rows (no name/itemid) — check the SHAPE log to fix mapping'); return 0; }

  // upsert minimal shop record so it appears in shop_stats
  await fetch(`${_IC_VERCEL}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'shops?on_conflict=username', data: [{ username: shop.username, shopid: shop.shopid }] }),
  });

  const SAVE_BATCH = 50;
  for (let i = 0; i < rows.length; i += SAVE_BATCH) {
    const r = await fetch(`${_IC_VERCEL}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'products?on_conflict=shopid,itemid,scraped_date', data: rows.slice(i, i + SAVE_BATCH) }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'save products failed');
  }

  const snaps = rows.map((p) => ({
    shopid: p.shopid, itemid: p.itemid, model_id: 0, username: p.username,
    product_name: p.name, variant_name: 'Default', variant_sku: '', variation_type: 'product',
    price: (p.price_min || 0) / 100000, stock: p.stock || 0, sold: p.historical_sold || 0,
    scraped_date: today, scraped_at: new Date().toISOString(),
  }));
  for (let i = 0; i < snaps.length; i += SAVE_BATCH) {
    await fetch(`${_IC_VERCEL}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'snapshots?on_conflict=shopid,itemid,model_id,scraped_date', data: snaps.slice(i, i + SAVE_BATCH) }),
    });
  }
  return rows.length;
}

// ── per-shop product capture (explicit ?page=N navigation) ───────────────────
async function _icScrapeShopProducts(tabId, shop) {
  const prodsMap = {};
  let respCount = 0, lastErr = 0, dumped = false, lastBatch = 0;
  const offsets = new Set();
  const detach = _icCapture(tabId, (url, j) => {
    if (!/search_items/.test(url)) return;
    respCount++;
    const m = url.match(/[?&]newest=(\d+)/); if (m) offsets.add(+m[1]);
    if (j && j.error && j.error !== 0) { lastErr = j.error; _icLog('  search_items ERROR', j.error, '←', url.slice(0, 90)); return; }
    const items = (j.items || []);
    lastBatch = items.length;
    // One-time shape dump so we map price/stock/sold to the REAL (new) field layout.
    if (!dumped && items.length) {
      dumped = true;
      const it = items[0];
      _icLog('  SHAPE item_data keys:', Object.keys((it && it.item_data) || {}).join(','));
      _icLog('  SHAPE item_data:', JSON.stringify(it && it.item_data).slice(0, 1600));
      _icLog('  SHAPE displayed_asset:', JSON.stringify(it && it.item_card_displayed_asset).slice(0, 700));
      _icLog('  SHAPE item_card_price:', JSON.stringify(it && it.item_card_price).slice(0, 500));
    }
    let added = 0;
    items.filter(Boolean).forEach((i) => {
      const id = i.itemid || (i.item_data && i.item_data.itemid);
      if (id && !prodsMap[id]) { prodsMap[id] = i; added++; } // store RAW item; normalize at save
    });
    if (added) _icReport({ shop: shop.username, products: Object.keys(prodsMap).length, phase: 'capture' });
  });

  try {
    // Walk pages by navigating ?page=N (newest sort = stable enumeration). Each full
    // navigation makes Shopee's own front-end fire a SIGNED search_items for that page.
    let stale = 0;
    for (let page = 0; page < 30 && stale < 2; page++) {
      if (typeof _icControl !== 'undefined' && _icControl.stop) break;
      const before = Object.keys(prodsMap).length;
      lastBatch = -1;
      const url = `https://shopee.com.my/shop/${shop.shopid}/search?page=${page}&sortBy=ctime`;
      _icLog(`  → page ${page}`);
      await chrome.tabs.update(tabId, { url });
      await _icSleep(5500);

      const cur = await _icCurrentUrl(tabId);
      if (/\/verify|captcha/i.test(cur)) {
        _icLog('  ⚠️ landed on verify/captcha — solve by hand, then re-run');
        return { products: Object.values(prodsMap), respCount, lastErr: lastErr || -1, offsets: [...offsets], blocked: true };
      }
      const after = Object.keys(prodsMap).length;
      if (after === before) stale++; else stale = 0;
      if (lastBatch >= 0 && lastBatch < 60) break; // last page reached
    }
  } finally { detach(); }

  return { products: Object.values(prodsMap), respCount, lastErr, offsets: [...offsets], blocked: false };
}

// ── variant capture (navigate product pages, intercept item/get | pdp/get_pc) ──
function _icModelStock(m) {
  return _icNum(m.stock) || _icNum(m.normal_stock)
    || (m.stock_info && (_icNum(m.stock_info.stock) || (m.stock_info.summary_info && _icNum(m.stock_info.summary_info.total_available_stock)))) || 0;
}
function _icItemStock(it) {
  return _icNum(it.stock)
    || (it.stock_info && it.stock_info.summary_info && _icNum(it.stock_info.summary_info.total_available_stock)) || 0;
}

// Variant photo hash: the model's own sku image, else its first-tier option image (the color
// tier usually carries per-option images keyed by tier_index).
function _icTierImage(tierVariations, m) {
  if (m.extinfo && m.extinfo.sku_image) return m.extinfo.sku_image;
  const ti = (m.extinfo && m.extinfo.tier_index) || [];
  for (let t = 0; t < (tierVariations || []).length; t++) {
    const imgs = tierVariations[t].images;
    if (imgs && imgs[ti[t]]) return imgs[ti[t]];
  }
  return '';
}

async function _icSaveVariants(variants) {
  if (!variants.length) return 0;
  const r = await fetch(`${_IC_VERCEL}/api/save-variants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variants }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'save variants failed');
  return j.saved || variants.length;
}

// Upsert reviews (with variant_bought) on the unique cmtid index. This is the per-variant
// "which sells more" signal — each Shopee review records the variant the buyer purchased.
async function _icSaveReviews(reviews) {
  const rows = reviews.filter((r) => r.cmtid);
  if (!rows.length) return 0;
  let saved = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const r = await fetch(`${_IC_VERCEL}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'reviews?on_conflict=cmtid', data: rows.slice(i, i + 50) }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'save reviews failed');
    saved += rows.slice(i, i + 50).length;
  }
  return saved;
}

// Extract review rows (incl. variant_bought) from a get_ratings response.
function _icRatingRows(j, shop) {
  const ratings = (j && j.data && j.data.ratings) || [];
  return ratings.map((rt) => {
    const pi = (rt.product_items && rt.product_items[0]) || {};
    return {
      cmtid: rt.cmtid || rt.comment_id || null,
      shopid: rt.shopid || shop.shopid,
      itemid: rt.itemid || pi.itemid || 0,
      product_name: pi.name || rt.product_name || '',
      rating_star: rt.rating_star || 0,
      comment: (rt.comment || '').slice(0, 2000),
      author: rt.author_username || rt.author || '',
      variant_bought: pi.model_name || '',
      tags: Array.isArray(rt.tags) ? rt.tags.map((t) => (t && (t.tag || t.name)) || t).join(',') : (rt.tags || ''),
      has_seller_reply: !!(rt.ItemRatingReply || rt.reply),
      ctime: rt.ctime || 0,
      scraped_at: new Date().toISOString(),
    };
  });
}

// Walk an object and report any key path matching rx with a short value preview —
// used to locate where stock/models live in the get_pc response regardless of nesting.
function _icProbe(obj, rx, path = '', out = [], depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object' || out.length >= 30) return out;
  for (const k of Object.keys(obj)) {
    if (out.length >= 30) break;
    const p = path ? `${path}.${k}` : k;
    const v = obj[k];
    if (rx.test(k)) {
      const s = (v && typeof v === 'object') ? (Array.isArray(v) ? `[${v.length}]` : JSON.stringify(v).slice(0, 90)) : JSON.stringify(v);
      out.push(`${p}=${s}`);
    }
    _icProbe(v, rx, p, out, depth + 1);
  }
  return out;
}

// Read the PDP's server-rendered product JSON embedded in the page — the technique the
// ZhiXia extension uses: <script type="text/mfe-initial-data" data-module="<b64 of
// 'pcmall-productdetailspage'>"> → initialState.item.items[itemId].models, where each
// model carries price/sold/STOCK. No API call, no eviction, no timing race.
async function _icExtractPdpSSR(tabId, itemid) {
  const expr = `(function(id){try{
    var ss=document.querySelectorAll('script[type="text/mfe-initial-data"]');
    for(var i=0;i<ss.length;i++){
      var d; try{d=JSON.parse(ss[i].textContent||ss[i].innerText||'{}');}catch(e){continue;}
      var items=d&&d.initialState&&d.initialState.item&&d.initialState.item.items;
      if(!items)continue;
      var it=items[id]||items[String(id)]||items[Object.keys(items)[0]];
      if(it&&(it.item_id||it.itemid)){
        return JSON.stringify({
          itemid: it.item_id||it.itemid,
          name: it.name||it.title||'',
          tier: (it.tier_variations||[]).map(function(v){return v.name;}),
          models: (it.models||[]).map(function(m){return {modelid:m.modelid||m.model_id,name:m.name,price:m.price,sold:m.sold,stock:m.stock,normal_stock:m.normal_stock,sku:m.model_sku||m.sku};}),
          stock: it.stock, sold: it.sold, price: it.price
        });
      }
    }
    return '';
  }catch(e){return 'ERR:'+e.message;}})(${itemid})`;
  const r = await _icEval(tabId, expr);
  const val = r && r.result && r.result.value;
  if (!val || typeof val !== 'string') return null;
  if (val.startsWith('ERR:')) { _icLog('  SSR err:', val); return null; }
  try { return JSON.parse(val); } catch (e) { return null; }
}

// Extract models[] (with stock) from a get_pc / get_pc_vsku / item/get response,
// wherever the array lives. Returns [] if none.
function _icModelsFrom(data, item) {
  let m = item.models || data.models || (data.product_price && data.product_price.models)
    || data.models_list || data.sku_list || (data.product_variation && data.product_variation.models);
  if ((!m || !m.length) && Array.isArray(data.skus)) m = data.skus;
  return m || [];
}

// "202" -> 202, "1k+" -> 1000, "1.2k" -> 1200 (Shopee rounds product sold for big numbers).
function _icParseSold(s) {
  if (!s) return 0;
  const m = String(s).toLowerCase().replace(/[, ]/g, '').match(/([\d.]+)\s*(k)?/);
  return m ? Math.round((parseFloat(m[1]) || 0) * (m[2] ? 1000 : 1)) : 0;
}

// Update product-level historical_sold from the PDP's real "X sold" (the search list hides it as 0).
// Rows already exist from the product phase, so this partial upsert only touches historical_sold.
async function _icSaveProductSold(shop, soldMap, today, validIds) {
  const rows = Object.entries(soldMap).filter(([itemid, s]) => s > 0 && (!validIds || validIds.has(+itemid)))
    .map(([itemid, s]) => ({ shopid: shop.shopid, itemid: +itemid, historical_sold: s, scraped_date: today }));
  if (!rows.length) return 0;
  const r = await fetch(`${_IC_VERCEL}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'products?on_conflict=shopid,itemid,scraped_date', data: rows }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'save sold failed');
  return rows.length;
}

// Select a variant on the PDP (click its tier option(s) by label → fires select_variation_pc),
// then read the real "X pieces available" the page shows for that variant. Returns the number,
// 0 if sold out, or null if it couldn't read it. This is BigSeller's approach — the only way
// Shopee exposes a true per-variant stock count to a non-owner.
async function _icVariantStockByClick(tabId, tierVariations, model) {
  const labels = (model.tier_index || []).map((idx, t) => {
    const opts = (tierVariations[t] && tierVariations[t].options) || [];
    return opts[idx] || '';
  }).filter(Boolean);
  if (!labels.length) return null;
  const clickExpr = `(function(labels){
    function norm(s){return (s||'').replace(/\\s+/g,' ').trim();}
    function clickByText(txt){
      var t=norm(txt); if(!t) return false;
      var els=[].slice.call(document.querySelectorAll('button,[class*="product-variation"],[class*="variation"] button,[role="button"]'));
      var el=els.find(function(e){return norm(e.textContent)===t && e.offsetParent!==null;});
      if(!el)el=els.find(function(e){var n=norm(e.textContent);return n.indexOf(t)>-1 && n.length<=t.length+24 && e.offsetParent!==null;});
      if(el){el.click();return true;}return false;
    }
    return labels.map(clickByText);
  })(${JSON.stringify(labels)})`;
  await _icEval(tabId, clickExpr);
  await _icSleep(1100); // wait for select_variation_pc + the "X available" DOM update
  const r = await _icEval(tabId, "(function(){var t=document.body.innerText||'';var m=t.match(/([\\d,]+)\\s*(?:pieces?\\s*)?(?:available|in stock)/i);return m?m[1].replace(/,/g,''):(/out of stock|sold out/i.test(t)?'0':'');})()");
  const v = r && r.result && r.result.value;
  return (v === '' || v == null) ? null : parseInt(v, 10);
}

// Verify page appeared → pause and poll until the user solves it by hand, then continue.
async function _icWaitVerifyCleared(tabId, maxMs = 600000) {
  _icLog('  ⏸️ 验证码 — SadCaptcha 自动解 / 手动解亦可，会自动继续...');
  _icReport({ phase: 'captcha' });
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (!/\/verify|captcha/i.test(await _icCurrentUrl(tabId))) { _icLog('  ✅ 验证已解，继续'); await _icSleep(2000); return true; }
    await _icSleep(3000);
  }
  return false; // timed out → caller stops
}

async function _icScrapeShopVariants(tabId, shop, products, maxEnrich) {
  // Enrich the products that matter: newest-listed (last 30d) + highest-sold (the opportunity set).
  const newCut = Math.floor(Date.now() / 1000) - 30 * 86400;
  const scored = products.map((p) => {
    const d = _icD(p);
    return { itemid: d.itemid || p.itemid, sold: _icNum((d.item_card_display_sold_count || {}).historical_sold_count) || _icNum(d.historical_sold), ctime: _icNum(d.ctime) };
  }).filter((t) => t.itemid);
  const news = scored.filter((t) => t.ctime > newCut).map((t) => t.itemid);
  const sold = scored.filter((t) => t.sold > 0).sort((a, b) => b.sold - a.sold).map((t) => t.itemid);
  const targets = [...new Set([...news, ...sold])].slice(0, maxEnrich); // new + every product with sales
  if (!targets.length) return { variants: 0, enriched: 0, blocked: false };

  const today = new Date().toLocaleDateString('en-CA');
  // get_pc gives the tier structure + per-model has_stock + product_review sold. The real
  // per-variant stock NUMBER only appears when a variant is clicked (select_variation_pc) — done below.
  const apiModels = {}; // itemid -> { name, tierVariations:[], models:[{modelid,name,price,sold,has_stock,tier_index,sku}] }
  const reviewsBuf = [];
  const pdpSold = {};   // itemid -> real product-level units sold (from get_pc product_review)
  const dumped = {};
  const svLast = { stock: null }; // real stock from the last select_variation_pc (set on each variant click)
  const validIds = new Set(products.map((p) => _icD(p).itemid || p.itemid)); // products actually saved today
  const detach = _icCapture(tabId, (url, j) => {
    if (/item\/get_ratings/.test(url)) { _icRatingRows(j, shop).forEach((r) => reviewsBuf.push(r)); return; }
    if (/select_variation_pc/.test(url)) {
      const d = (j && j.data) || j || {};
      if (!dumped.SV) { dumped.SV = true; _icLog('  SV-probe:', _icProbe(d, /stock|qty|quantity|model|tier/i).join(' | ')); }
      const sv = d.selected_variation || {};
      const n = _icNum(d.stock) || _icNum(sv.max_quantity) || _icNum(d.max_quantity);
      svLast.stock = n > 0 ? n : null;
      return;
    }
    const isVsku = /get_pc_vsku/.test(url);
    const isPc = /pdp\/get_pc(\?|\/|$)/.test(url) || /item\/get(\?|$)/.test(url);
    if (!isVsku && !isPc) return;
    const data = (j && j.data) || j || {};
    const item = data.item || data;
    const itemid = +(item.item_id || item.itemid || (url.match(/item_?id=(\d+)/) || [])[1] || 0);
    if (!itemid) return;
    if (data.product_review) pdpSold[itemid] = _icParseSold(data.product_review.historical_sold_display);
    const models = _icModelsFrom(data, item);
    if (!models.length) return;
    apiModels[itemid] = {
      name: item.title || item.name || (apiModels[itemid] && apiModels[itemid].name) || '',
      tierVariations: item.tier_variations || data.tier_variations || [],
      models: models.map((m) => ({
        modelid: m.modelid || m.model_id || m.id || 0, name: m.name || 'Default',
        price: m.price, sold: m.sold, has_stock: m.has_stock !== false,
        tier_index: (m.extinfo && m.extinfo.tier_index) || [], sku: m.model_sku || m.sku || '',
        image: _icTierImage(item.tier_variations || data.tier_variations, m),
      })),
    };
  });

  const buf = [];
  let saved = 0, savedR = 0, captured = 0, blocked = false;
  try {
    for (let i = 0; i < targets.length; i++) {
      await _icWaitIfPaused();
      if (_icControl.stop) break;
      const id = targets[i];
      await chrome.tabs.update(tabId, { url: `https://shopee.com.my/product/${shop.shopid}/${id}` });

      // Wait until this product's get_pc is captured before navigating on (eviction-safe).
      let waited = 0;
      while (waited < 11000) {
        const cur = await _icCurrentUrl(tabId);
        if (/\/verify|captcha/i.test(cur)) {
          if (!(await _icWaitVerifyCleared(tabId))) { blocked = true; break; }
          await chrome.tabs.update(tabId, { url: `https://shopee.com.my/product/${shop.shopid}/${id}` });
          waited = 0; continue; // re-loaded the product, keep waiting for its get_pc
        }
        if (apiModels[id]) break;
        await _icSleep(700); waited += 700;
      }
      if (blocked) break;

      const rec = apiModels[id];
      if (rec && rec.models.length) {
        const tierName = (rec.tierVariations || []).map((t) => t.name).filter(Boolean).join(' / ') || 'single';
        const stockLog = [];
        for (const m of rec.models.slice(0, 14)) { // cap clicks/product
          // Click in-stock variants → select_variation_pc gives the real stock; sold-out = 0 (no click).
          let stock = 0;
          if (m.has_stock) {
            svLast.stock = null;
            const dom = await _icVariantStockByClick(tabId, rec.tierVariations, m);
            stock = (svLast.stock != null) ? svLast.stock : (dom != null ? dom : 1); // API stock > DOM read > "in stock"
          }
          stockLog.push(`${m.name}=${stock}`);
          buf.push({
            shopid: shop.shopid, itemid: id, model_id: m.modelid || 0, username: shop.username,
            product_name: rec.name, variant_name: m.name || 'Default', variant_sku: m.sku || '',
            variation_type: tierName, price: _icNum(m.price) / 100000, stock, sold: _icNum(m.sold),
            image: m.image || '', scraped_date: today, scraped_at: new Date().toISOString(),
          });
        }
        if (i === 0) _icLog('  CLICK-STOCK:', stockLog.slice(0, 8).join(', '));
        captured++;
      }

      _icReport({ shop: shop.username, phase: 'variants', i: i + 1, n: targets.length });
      if (buf.length >= 60) { try { saved += await _icSaveVariants(buf.splice(0, 60)); } catch (e) { _icLog('    saveVariants err:', e.message); } }
      await _icSleep(1800); // gentle spacing between PDP visits — verify-avoidance
    }
  } finally { detach(); }
  if (buf.length) { try { saved += await _icSaveVariants(buf); } catch (e) { _icLog('    saveVariants err:', e.message); } }
  if (reviewsBuf.length) { try { savedR += await _icSaveReviews(reviewsBuf); } catch (e) { _icLog('    saveReviews err:', e.message); } }
  let soldN = 0;
  try { soldN = await _icSaveProductSold(shop, pdpSold, today, validIds); } catch (e) { _icLog('    saveSold err:', e.message); }
  _icLog(`  ✅ variants: ${captured} products | product-sold updated: ${soldN}${savedR ? ` | reviews: ${savedR}` : ''}`);
  return { variants: saved, enriched: captured, reviews: savedR, productSold: soldN, blocked };
}

// ── orchestrator ─────────────────────────────────────────────────────────────
async function runIntercept(opts = {}) {
  if (_icRunning) { _icLog('already running'); return; }
  _icRunning = true;
  _icControl = { stop: false, paused: false };
  const maxShops = opts.maxShops || 1;
  const maxEnrich = opts.maxEnrich != null ? opts.maxEnrich : 8; // PDP crawling trips verify; keep low
  try {
    let tabId = opts.tabId;
    if (!tabId) { const tabs = await chrome.tabs.query({ url: 'https://shopee.com.my/*' }); tabId = tabs[0] && tabs[0].id; }
    if (!tabId) { _icLog('no shopee.com.my tab open'); _icReport({ phase: 'error', msg: 'no shopee tab' }); return; }

    const today = new Date().toLocaleDateString('en-CA');
    let shops = [];
    try { const r = await fetch(`${_IC_VERCEL}/api/data?type=shops`); const d = await r.json(); shops = (Array.isArray(d) ? d : []).filter((s) => s.username && s.shopid); } catch (e) {}
    const done = new Set();
    try { const r = await fetch(`${_IC_VERCEL}/api/data?type=scraped-today`); const d = await r.json(); (d.shops || []).forEach((u) => done.add(u)); } catch (e) {}
    // opts.all → every shop (variant runs ignore the products done-set); else skip product-done shops.
    const pending = (opts.all ? shops : shops.filter((s) => !done.has(s.username))).slice(0, maxShops);
    if (!pending.length) { _icLog('nothing pending today (all shops done)'); _icReport({ phase: 'complete', products: 0 }); return; }
    _icLog(`▶ interception run — ${pending.length} shop(s): ${pending.map((s) => s.username).join(', ')}`);
    _icReport({ phase: 'run-start', total: pending.length }); // 1 tab, serial — drives the N/total bar

    let attached = false;
    try {
      await chrome.debugger.attach({ tabId }, '1.3'); attached = true;
      // Big response buffers so large get_pc JSON isn't evicted before we read it.
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxTotalBufferSize: 100000000, maxResourceBufferSize: 20000000 });
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}).catch(() => {});

      for (const shop of pending) {
        await _icWaitIfPaused();
        if (_icControl.stop) { _icLog('■ 已停止'); break; }
        _icReport({ shop: shop.username, phase: 'start' });
        _icLog(`\n📡 ${shop.username} (${shop.shopid})`);
        const r = await _icScrapeShopProducts(tabId, shop);
        _icLog(`  captured ${r.products.length} products | responses=${r.respCount} lastErr=${r.lastErr} offsets=[${r.offsets.join(',')}]${r.blocked ? ' BLOCKED' : ''}`);
        if (r.products.length) {
          try { const saved = await _icSaveProducts(shop, r.products, today); _icLog(`  ✅ saved ${saved} products to Vercel`); }
          catch (e) { _icLog('  ❌ product save failed:', e && e.message); }
        }
        // scrape_log row for the dashboard's Scrape Log page (fire-and-forget)
        fetch(`${_IC_VERCEL}/api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'scrape_log', data: [{ username: shop.username, shopid: shop.shopid, total_items: r.products.length, status: r.products.length ? 'success' : 'error', duration_ms: 0 }] }) }).catch(() => {});
        if (r.blocked) { _icReport({ shop: shop.username, phase: 'done', products: r.products.length, blocked: true }); break; }

        // Phase 2: per-product PDP visits → variant stock + reviews-per-variant (variant_bought).
        let vres = { variants: 0, enriched: 0, reviews: 0, blocked: false };
        if (maxEnrich > 0 && r.products.length) {
          _icLog(`  🔎 variants+reviews: visiting up to ${maxEnrich} products...`);
          vres = await _icScrapeShopVariants(tabId, shop, r.products, maxEnrich);
          _icLog(`  ✅ enriched ${vres.enriched} products → ${vres.variants} variant rows, ${vres.productSold || 0} real-sold updated${vres.blocked ? ' (stopped — verify)' : ''}`);
        }
        _icReport({ shop: shop.username, phase: 'done', products: r.products.length, variants: vres.variants, reviews: vres.reviews, err: r.lastErr, blocked: vres.blocked });
        if (vres.blocked) break;
        await _icSleep(4000);
      }
    } catch (e) { _icLog('run error:', e && e.message); _icReport({ phase: 'error', msg: (e && e.message) || 'error' }); }
    finally { if (attached) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} } }

    _icLog('■ interception run complete');
    _icReport({ phase: 'complete' });
  } finally { _icRunning = false; }
}
