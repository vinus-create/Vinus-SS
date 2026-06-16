// ShopeeScope — unattended daily scraper
// =============================================================================
// Runs from Windows Task Scheduler (hourly) on the user's PC = residential MY IP.
// Uses a DEDICATED Chrome profile (not the live one) so it never collides with
// normal browsing and never hits "profile already in use".
//
// Each run scrapes up to MAX_SHOPS_PER_RUN shops that aren't done today (resume
// via /api/data?type=scraped-today), then exits. Hourly slots + resume complete
// all shops over the day. On CAPTCHA it stops cleanly and retries next slot —
// no human needed. Velocity uses STOCK drawdown, so we only need fresh stock.
//
// Usage:
//   node daily.js --login                 one-time: open visible browser, log in
//   node daily.js                         a normal scheduled run
//   node daily.js --once --max-shops=2    test run, limit shops
//   node daily.js --shop=buddysnack       force a single shop (ignores resume)
//   node daily.js --no-save               dry run (fetch only, don't persist)
// =============================================================================

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth); // mask automation fingerprints so Shopee serves normal pages
const { notify } = require('./lib/notify');
const { solveCaptcha } = require('./lib/captcha');

// ── tiny .env loader (so `node daily.js` works without the PS launcher) ───────
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2]
        .replace(/(^|\s)#.*$/, '')     // strip "# comment" at start or after space (our URLs have no '#')
        .trim()
        .replace(/^["']|["']$/g, '');  // strip surrounding quotes
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) { /* ignore */ }
})();

// ── config ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};

const VERCEL          = process.env.VERCEL_URL || 'https://vinus-ss.vercel.app';
const PROFILE_DIR     = process.env.SCRAPER_PROFILE_DIR || 'D:\\ShopeeScope\\chrome-scraper-profile';
const MAX_SHOPS       = parseInt(opt('max-shops', process.env.MAX_SHOPS_PER_RUN || '4'), 10);
const ENRICH_TOP      = parseInt(process.env.ENRICH_TOP_N || '40', 10);
const REVIEWS_EVERY_N = parseInt(process.env.SCRAPE_REVIEWS_EVERY_N_DAYS || '7', 10);
const REVIEWS_SHOPS   = parseInt(process.env.REVIEWS_SHOPS_PER_RUN || '2', 10);
const COOLDOWN_MIN    = parseInt(process.env.CAPTCHA_COOLDOWN_MIN || '30', 10);
const SORTS           = (process.env.PRODUCT_SORTS || 'sales').split(',').map(s => s.trim()).filter(Boolean);
const DELAY_PAGE      = parseInt(process.env.DELAY_PAGE_MS || '2500', 10);
const DELAY_ITEM      = parseInt(process.env.DELAY_ITEM_MS || '5000', 10);
const SHOP_REST_MS    = parseInt(process.env.SHOP_REST_MS || '60000', 10);
const SOLVER_ON       = (process.env.CAPTCHA_SOLVER || 'local') !== 'off';
const SOLVES_PER_RUN  = parseInt(process.env.CAPTCHA_SOLVES_PER_RUN || '3', 10);
const NO_SAVE         = flag('no-save');
const COOLDOWN_FILE   = path.join(__dirname, '.captcha-cooldown');

const today = new Date().toISOString().split('T')[0]; // UTC date — matches api/save.js + scraped-today
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 800)));

// ── backend helpers (write through the Vercel API — no DB secret needed here) ─
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}
async function postJSON(pathname, body) {
  const r = await fetch(`${VERCEL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `POST ${pathname} → ${r.status}`);
  return j;
}
const logShop = (shop, totalItems, status, durationMs, errorMsg) =>
  postJSON('/api/save', { type: 'scrape_log', data: [{
    username: shop.username, shopid: shop.shopid, total_items: totalItems, status,
    duration_ms: durationMs, ...(errorMsg ? { error_msg: String(errorMsg).slice(0, 200) } : {}),
  }]}).catch(() => {});

// Save products via the GENERIC upsert form (mirrors the extension). We do NOT use
// /api/save's full {shop,products} form because it would overwrite shops.follower_count,
// rating, item_count, description, etc. with zeros (we only know shopid here).
async function saveProducts(shop, products) {
  const rows = products.map(p => ({
    shopid: shop.shopid, itemid: p.itemid, username: shop.username, name: p.name,
    price_min: p.price_min || 0, price_max: p.price_max || p.price_min || 0,
    price_min_before_discount: p.price_min_before_discount || p.price_min || 0,
    raw_discount: p.raw_discount || 0,
    historical_sold: p.historical_sold || 0, sold: p.sold || 0,
    liked_count: p.liked_count || 0, stock: p.stock || 0,
    rating_star: p.item_rating?.rating_star || 0,
    rating_count: p.item_rating?.rating_count?.reduce((a, b) => a + b, 0) || 0,
    brand: p.brand || '', catid: p.catid || 0,
    image: p.image || '', ctime: p.ctime || 0,
    scraped_date: today, scraped_at: new Date().toISOString(),
  }));
  // keep the shop visible in shop_stats without clobbering its profile fields
  await postJSON('/api/save', { type: 'shops?on_conflict=username', data: [{ username: shop.username, shopid: shop.shopid }] });
  await postJSON('/api/save', { type: 'products?on_conflict=shopid,itemid,scraped_date', data: rows });
  // product-level snapshots (parity with the extension)
  const snaps = rows.map(p => ({
    shopid: p.shopid, itemid: p.itemid, model_id: 0, username: p.username,
    product_name: p.name, variant_name: 'Default', variant_sku: '', variation_type: 'product',
    price: (p.price_min || 0) / 100000, stock: p.stock || 0, sold: p.historical_sold || 0,
    scraped_date: today, scraped_at: new Date().toISOString(),
  }));
  await postJSON('/api/save', { type: 'snapshots?on_conflict=shopid,itemid,model_id,scraped_date', data: snaps });
  return rows.length;
}

// ── in-page Shopee fetchers (run in the shopee.com.my context → cookies+CORS) ─
async function fetchProducts(page, shopid) {
  return page.evaluate(async ({ shopid, sorts, delayMs }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 700)));
    const blocked = () => location.href.includes('captcha') || location.href.includes('/verify');
    const seen = new Set(), map = {};
    let status = 'ok';
    for (const by of sorts) {
      let off = 0, rl = 0;
      while (true) {
        if (blocked()) { status = 'captcha'; break; }
        let r;
        try {
          r = await fetch(`/api/v4/search/search_items?by=${by}&limit=60&match_id=${shopid}&newest=${off}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`,
            { credentials: 'include', headers: { 'x-api-source': 'pc', 'x-shopee-language': 'en', 'Accept': 'application/json', 'Referer': `https://shopee.com.my/shop/${shopid}/search` } });
        } catch (e) { status = 'neterr'; break; }
        if (r.status === 403 || r.status === 429) { if (++rl >= 2) { status = 'ratelimit'; break; } await sleep(90000); continue; }
        let j;
        try { j = await r.json(); } catch (e) { status = 'captcha'; break; } // non-JSON ⇒ block/interstitial
        if (j.error && j.error !== 0) { status = 'apierr'; break; }
        const batch = (j.items || []).map(i => i.item_basic).filter(Boolean);
        if (!batch.length) break;
        let added = 0;
        batch.forEach(p => { if (!seen.has(p.itemid)) { seen.add(p.itemid); map[p.itemid] = p; added++; } });
        if (batch.length < 60 || added === 0) break;
        off += 60;
        await sleep(delayMs);
      }
      if (status !== 'ok') break;
      await sleep(1500);
    }
    return { status, products: Object.values(map) };
  }, { shopid, sorts: SORTS, delayMs: DELAY_PAGE });
}

async function fetchVariants(page, shop, items) {
  return page.evaluate(async ({ shopid, username, items, delayMs, today }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 900)));
    const blocked = () => location.href.includes('captcha') || location.href.includes('/verify');
    const out = [];
    let status = 'ok';
    for (const p of items) {
      if (blocked()) { status = 'captcha'; break; }
      await sleep(delayMs);
      let r;
      try {
        r = await fetch(`/api/v4/item/get?itemid=${p.itemid}&shopid=${shopid}`,
          { credentials: 'include', headers: { 'x-api-source': 'pc', 'x-shopee-language': 'en', 'Accept': 'application/json', 'Referer': `https://shopee.com.my/product/${shopid}/${p.itemid}` } });
      } catch (e) { status = 'neterr'; break; }
      if (r.status === 403 || r.status === 429) { status = 'ratelimit'; break; }
      let j;
      try { j = await r.json(); } catch (e) { status = 'captcha'; break; }
      if (j.error && j.error !== 0) continue;
      const it = j.data;
      if (!it) continue;
      const vt = (it.tier_variations || []).map(v => v.name).join(' / ') || 'single';
      if (it.models && it.models.length) {
        it.models.forEach(m => out.push({
          shopid, itemid: p.itemid, model_id: m.modelid || 0, username, product_name: p.name,
          variant_name: m.name || 'Default', variant_sku: m.model_sku || '', variation_type: vt,
          price: (m.price || 0) / 100000, stock: m.stock || 0, sold: m.sold || 0,
          scraped_date: today, scraped_at: new Date().toISOString(),
        }));
      } else {
        out.push({
          shopid, itemid: p.itemid, model_id: 0, username, product_name: p.name,
          variant_name: 'Default', variant_sku: '', variation_type: 'single',
          price: (p.price_min || 0) / 100000,
          stock: it.stock_info?.summary_info?.total_available_stock ?? p.stock ?? 0,
          sold: it.sold || 0, scraped_date: today, scraped_at: new Date().toISOString(),
        });
      }
    }
    return { status, variants: out };
  }, { shopid: shop.shopid, username: shop.username, items, delayMs: DELAY_ITEM, today });
}

async function fetchReviews(page, shop, items) {
  return page.evaluate(async ({ shopid, items, delayMs }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 700)));
    const blocked = () => location.href.includes('captcha') || location.href.includes('/verify');
    const out = [];
    let status = 'ok';
    for (const p of items) {
      if (blocked()) { status = 'captcha'; break; }
      await sleep(delayMs);
      let r;
      try {
        r = await fetch(`/api/v2/item/get_ratings?itemid=${p.itemid}&shopid=${shopid}&limit=20&offset=0&filter=0&type=0&exclude_filter=1&flag=1&fold_filter=0&relevant_reviews=false&request_source=2`,
          { credentials: 'include', headers: { 'x-api-source': 'pc', 'x-shopee-language': 'en', 'Accept': 'application/json', 'Referer': `https://shopee.com.my/product/${shopid}/${p.itemid}` } });
      } catch (e) { status = 'neterr'; break; }
      if (r.status === 403 || r.status === 429) { status = 'ratelimit'; break; }
      let j;
      try { j = await r.json(); } catch (e) { status = 'captcha'; break; }
      (j.data?.ratings || []).forEach(rv => {
        if (!rv.comment) return;
        out.push({
          shopid, itemid: p.itemid, product_name: p.name,
          rating_star: rv.rating_star || 0, comment: rv.comment.slice(0, 500),
          author: rv.author_username || '', variant_bought: rv.product_items?.[0]?.variation_name || '',
          tags: (rv.tags || []).join(','), has_seller_reply: !!(rv.reply?.comment),
          ctime: rv.ctime || 0, scraped_at: new Date().toISOString(),
        });
      });
    }
    return { status, reviews: out };
  }, { shopid: shop.shopid, items, delayMs: Math.round(DELAY_ITEM * 0.6) });
}

// ── cooldown after a CAPTCHA so we don't hammer the next hourly slot ──────────
function inCooldown() {
  try {
    const ts = parseInt(fs.readFileSync(COOLDOWN_FILE, 'utf8').trim(), 10);
    const mins = (Date.now() - ts) / 60000;
    if (mins < COOLDOWN_MIN) return Math.ceil(COOLDOWN_MIN - mins);
  } catch (e) {}
  return 0;
}
const setCooldown = () => { try { fs.writeFileSync(COOLDOWN_FILE, String(Date.now())); } catch (e) {} };
const clearCooldown = () => { try { fs.existsSync(COOLDOWN_FILE) && fs.unlinkSync(COOLDOWN_FILE); } catch (e) {} };

// ── browser launch (dedicated profile) ───────────────────────────────────────
async function launch(visible) {
  // Real Chrome + stealth, no --no-sandbox (that flag shows a banner and is a bot tell),
  // and NO user-agent override (let Chrome send its true, current UA + matching client
  // hints — a stale UA is an instant give-away). viewport:null uses the real window size.
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--disable-features=IsolateOrigins,site-per-process',
           ...(visible ? [] : ['--start-minimized'])],
    viewport: null,
    locale: 'en-MY',
    timezoneId: 'Asia/Kuala_Lumpur',
    // Drop the "controlled by automation" flag AND --no-sandbox (the stealth plugin
    // injects --no-sandbox, which shows a banner + is a bot tell — strip it here).
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
  });
  return ctx;
}

function isBlockedUrl(url) {
  return url.includes('/verify/') || url.includes('captcha') || url.includes('/login');
}

// Surface the slider widget (navigate to a page that renders it), then solve it.
// Returns { solved, reason }. Caller decides whether to retry the phase.
async function attemptSolve(page, shop) {
  try {
    const url = shop ? `https://shopee.com.my/shop/${shop.shopid}` : 'https://shopee.com.my/';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2500);
  } catch (e) {}
  const r = await solveCaptcha(page).catch(e => ({ solved: false, reason: e.message }));
  log(`🧩 captcha solve: ${r.solved ? 'SOLVED' : 'failed (' + r.reason + ')'}`);
  return r;
}

// ── login mode ───────────────────────────────────────────────────────────────
async function runLogin() {
  log(`🔑 Login mode — opening Chrome with profile: ${PROFILE_DIR}`);
  const ctx = await launch(true);
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://shopee.com.my/buyer/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('\n  → Log into Shopee in the browser window, then press ENTER here to save the session.\n');
  await new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); res(); });
  });
  await ctx.close(); // persists cookies to the profile dir
  log('✅ Session saved. You can now run scheduled scrapes.');
}

// ── one scheduled run ────────────────────────────────────────────────────────
async function runScrape() {
  const cd = inCooldown();
  if (cd && !flag('force')) { log(`❄️ In CAPTCHA cooldown (${cd} min left) — skipping this slot.`); return 0; }

  const forcedShop = opt('shop', null);
  let ctx;
  try {
    ctx = await launch(false);
  } catch (e) {
    await notify(`🔴 ShopeeScope: browser launch failed — ${e.message}`);
    log('launch failed:', e.message);
    return 1;
  }
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    await page.goto('https://shopee.com.my/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);
    if (isBlockedUrl(page.url())) {
      const where = page.url();
      if (where.includes('/login')) {
        setCooldown();
        await notify('🟠 ShopeeScope: not logged in. Run `node daily.js --login` in the scraper profile to refresh the session.');
        log('blocked at startup:', where);
        return 2;
      }
      // CAPTCHA/verify at startup — try to solve it before bailing
      let cleared = false;
      if (SOLVER_ON) { const sr = await solveCaptcha(page).catch(() => ({ solved: false })); cleared = sr.solved; }
      if (!cleared) {
        setCooldown();
        await notify(`🟠 ShopeeScope: blocked at startup (${where.includes('captcha') ? 'CAPTCHA' : 'verify'}) and couldn't solve it. Will retry next slot.`);
        log('blocked at startup, unsolved:', where);
        return 2;
      }
      log('startup CAPTCHA solved ✓');
    }

    // shop list + resume
    let shops = await getJSON(`${VERCEL}/api/data?type=shops`).catch(() => []);
    shops = (Array.isArray(shops) ? shops : []).filter(s => s.username && s.shopid).map(s => ({ username: s.username, shopid: s.shopid }));
    if (!shops.length) { await notify('🔴 ShopeeScope: shop list empty from API.'); return 1; }

    let pending;
    if (forcedShop) {
      pending = shops.filter(s => s.username === forcedShop);
      if (!pending.length) pending = [{ username: forcedShop, shopid: shops.find(s => s.username === forcedShop)?.shopid }];
    } else {
      const done = await getJSON(`${VERCEL}/api/data?type=scraped-today`).catch(() => ({ shops: [] }));
      const doneSet = new Set(done.shops || []);
      pending = shops.filter(s => !doneSet.has(s.username));
      if (doneSet.size) log(`⏭️ already done today: ${[...doneSet].join(', ')}`);
    }

    if (!pending.length) { log('✅ all shops already scraped today — nothing to do.'); clearCooldown(); return 0; }

    const batch = pending.slice(0, MAX_SHOPS);
    log(`🚀 ${today} — ${pending.length} pending, doing ${batch.length} this run (sorts=${SORTS.join('+')})`);

    const doReviews = REVIEWS_EVERY_N > 0 && (Math.floor(Date.parse(today) / 86400000) % REVIEWS_EVERY_N === 0);
    let reviewsBudget = doReviews ? REVIEWS_SHOPS : 0;
    let captchaHit = false;
    let solvesUsed = 0;
    const summary = [];

    for (const shop of batch) {
      const started = Date.now();
      log(`\n📡 ${shop.username} (${shop.shopid})`);

      // Phase 1 — product list
      let pr = await fetchProducts(page, shop.shopid);
      // If blocked by a CAPTCHA, try to solve it locally then re-fetch (capped per run)
      if (pr.status === 'captcha' && SOLVER_ON && solvesUsed < SOLVES_PER_RUN) {
        solvesUsed++;
        const sr = await attemptSolve(page, shop);
        if (sr.solved) pr = await fetchProducts(page, shop.shopid);
      }
      if (pr.status !== 'ok' || !pr.products.length) {
        log(`  ⚠️ products: ${pr.status} (${pr.products.length} got) — stopping run, will resume next slot`);
        await logShop(shop, 0, 'error', Date.now() - started, `products:${pr.status}`);
        if (pr.status === 'captcha' || pr.status === 'ratelimit') captchaHit = true;
        break; // leave this shop un-done so it retries
      }
      if (!NO_SAVE) await saveProducts(shop, pr.products);
      log(`  ✅ products: ${pr.products.length} saved`);
      // mark the shop in the dashboard log (resume itself keys off the products table)
      if (!NO_SAVE) await logShop(shop, pr.products.length, 'success', Date.now() - started, null);

      // Phase 2 — variant stock (feeds velocity)
      const top = [...pr.products].sort((a, b) => (b.historical_sold || 0) - (a.historical_sold || 0)).slice(0, ENRICH_TOP);
      let vr = await fetchVariants(page, shop, top);
      if (vr.status === 'captcha' && SOLVER_ON && solvesUsed < SOLVES_PER_RUN) {
        solvesUsed++;
        const sr = await attemptSolve(page, shop);
        if (sr.solved) { const more = await fetchVariants(page, shop, top); vr = { status: more.status, variants: vr.variants.concat(more.variants) }; }
      }
      if (!NO_SAVE && vr.variants.length) {
        await postJSON('/api/save-variants', { variants: vr.variants });
      }
      log(`  ✅ variants: ${vr.variants.length} saved (${vr.status})`);

      // Phase 3 — reviews (occasional)
      let revCount = 0;
      if (reviewsBudget > 0 && vr.status === 'ok') {
        const rv = await fetchReviews(page, shop, top.slice(0, 10));
        if (!NO_SAVE && rv.reviews.length) {
          // Needs a UNIQUE(shopid,itemid,ctime) index on reviews (see README); guard so
          // a missing index / save error never aborts the whole run.
          try {
            await postJSON('/api/save', { type: 'reviews?on_conflict=shopid,itemid,ctime', data: rv.reviews });
            revCount = rv.reviews.length;
          } catch (e) { log(`  ⚠️ reviews save skipped: ${e.message.slice(0, 80)}`); }
        }
        reviewsBudget--;
        log(`  ✅ reviews: ${revCount} (${rv.status})`);
        if (rv.status === 'captcha' || rv.status === 'ratelimit') { captchaHit = true; summary.push({ shop: shop.username, products: pr.products.length, variants: vr.variants.length, reviews: revCount }); break; }
      }

      summary.push({ shop: shop.username, products: pr.products.length, variants: vr.variants.length, reviews: revCount });
      if (vr.status === 'captcha' || vr.status === 'ratelimit') { captchaHit = true; break; }

      if (shop !== batch[batch.length - 1]) { log(`  ⏸️ rest ${Math.round(SHOP_REST_MS / 1000)}s`); await sleep(SHOP_REST_MS); }
    }

    if (captchaHit) {
      setCooldown();
      await notify(`🟠 ShopeeScope: CAPTCHA/limit during run. Scraped ${summary.length} shop(s) this slot; cooling down ${COOLDOWN_MIN}m, will resume automatically.`);
    } else {
      clearCooldown();
    }

    log(`\n🏁 run done — ${summary.map(s => `${s.shop}:${s.products}p/${s.variants}v`).join(', ') || 'nothing'}`);
    return 0;
  } catch (e) {
    log('run error:', e.message);
    await notify(`🔴 ShopeeScope: run error — ${e.message}`);
    return 1;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── solve-now mode (manual test: open visible, surface a widget, try one solve) ─
async function runSolveNow() {
  log('🧩 solve-now — opening visible Chrome to test the CAPTCHA solver');
  const ctx = await launch(true);
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.goto('https://shopee.com.my/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(2500);
    const shops = await getJSON(`${VERCEL}/api/data?type=shops`).catch(() => []);
    const shop = (Array.isArray(shops) ? shops : []).find(s => s.shopid);
    const r = await attemptSolve(page, shop ? { shopid: shop.shopid } : null);
    log(`result: ${JSON.stringify(r)}`);
    log('Leaving the window open 20s so you can inspect — set CAPTCHA_DEBUG=1 to dump screenshots.');
    await sleep(20000);
  } finally { await ctx.close().catch(() => {}); }
}

// ── entry ────────────────────────────────────────────────────────────────────
(async () => {
  let code = 0;
  try {
    if (flag('login')) await runLogin();
    else if (flag('solve-now')) await runSolveNow();
    else code = await runScrape();
  } catch (e) {
    console.error('fatal:', e);
    await notify(`🔴 ShopeeScope: fatal — ${e.message}`).catch(() => {});
    code = 1;
  }
  process.exit(code);
})();
