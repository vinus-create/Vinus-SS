// ShopeeScope — Playwright scraper for GitHub Actions
// No login required — uses stealth Chromium from 2 parallel jobs (different IPs)
// SHOP_BATCH=0 → shops 0-6, SHOP_BATCH=1 → shops 7-12

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const VERCEL_URL = process.env.VERCEL_URL || 'https://vinus-ss.vercel.app';
const BATCH      = parseInt(process.env.SHOP_BATCH ?? '0', 10);

const ALL_SHOPS = [
  'buddysnack','winstartech','1stopbatteries','icare4allshop',
  'energizerbatteryhub','gadgetspecialist','gou.ori',
  'tenbucksfood','dsconcept_store','sxmixempire',
  'r_in_g','nextgenhardware.os','ham_radios.my'
];

// Split into 2 batches of ~6-7 shops each
const BATCHES = [ALL_SHOPS.slice(0, 7), ALL_SHOPS.slice(7)];
const SHOPS   = BATCHES[BATCH] ?? ALL_SHOPS;

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🗂️  Batch ${BATCH}: scraping ${SHOPS.length} shops → [${SHOPS.join(', ')}]`);

  console.log('🌐 Launching Chromium (stealth, no cookies)...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 720 },
    locale:    'en-MY',
    timezoneId: 'Asia/Kuala_Lumpur',
    extraHTTPHeaders: { 'Accept-Language': 'en-MY,en;q=0.9,ms;q=0.8' },
  });

  const page = await context.newPage();

  // Warm up — visit Shopee homepage first to establish session
  console.log('🏠 Warming up on shopee.com.my...');
  await page.goto('https://shopee.com.my', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const finalUrl = page.url();
  console.log('   Final URL:', finalUrl);
  if (finalUrl.includes('verify/traffic')) {
    await browser.close();
    throw new Error('Bot detection on warmup. Try again later.');
  }

  // ── Scrape inside browser context ─────────────────────────────────────────
  const results = await page.evaluate(async ({ shops, vercelUrl, batchNum }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * ms * 0.3)));

    const api = async path => {
      const r = await fetch('https://shopee.com.my' + path, {
        credentials: 'include',
        headers: {
          'x-api-source': 'pc',
          'x-shopee-language': 'en',
          'Accept': 'application/json',
          'Referer': 'https://shopee.com.my/',
        }
      });
      const json = await r.json();
      if (json.error && json.error !== 0) throw new Error(`API error ${json.error}: ${path}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${path}`);
      return json;
    };

    async function allProds(shopid, username) {
      const seen = new Set(), map = {};
      for (const by of ['sales', 'ctime', 'price']) {
        let off = 0;
        while (true) {
          let d;
          try {
            d = await api(
              `/api/v4/search/search_items?by=${by}&limit=60&match_id=${shopid}` +
              `&newest=${off}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`
            );
          } catch(e) {
            console.log(`  [${username}] by=${by}: ${e.message}`);
            break;
          }
          const b = (d.items || []).map(i => i.item_basic).filter(Boolean);
          if (!b.length) break;
          b.forEach(p => { if (!seen.has(p.itemid)) { seen.add(p.itemid); map[p.itemid] = p; } });
          if (b.length < 60) break;
          off += 60;
          await sleep(1500);
        }
        await sleep(2000);
      }
      return Object.values(map);
    }

    const results = [];
    for (const username of shops) {
      try {
        const sr = await api(`/api/v4/shop/get_shop_detail?username=${username}`);
        if (!sr.data) throw new Error('shop not found');
        const shop = sr.data;
        console.log(`  [${username}] shopid=${shop.shopid} declared_items=${shop.item_count||'?'}`);

        const prods = await allProds(shop.shopid, username);
        console.log(`  [${username}] fetched ${prods.length} products`);

        const rv = await (await fetch(`${vercelUrl}/api/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shop, products: prods, username }),
        })).json();

        results.push({ username, ok: true, saved: rv.saved || 0, fetched: prods.length });
        await sleep(20000); // 20s between shops to avoid rate limit
      } catch(e) {
        console.log(`  [${username}] ERROR: ${e.message}`);
        results.push({ username, ok: false, error: e.message });
        await sleep(5000);
      }
    }
    return results;
  }, { shops: SHOPS, vercelUrl: VERCEL_URL, batchNum: BATCH });

  await browser.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  const ok = results.filter(r => r.ok && r.fetched > 0).length;
  console.log(`\n📊 Batch ${BATCH} done: ${ok}/${SHOPS.length} shops with data`);
  console.table(results);

  if (results.every(r => !r.ok)) process.exit(1);
}

main().catch(e => {
  console.error('❌ Fatal:', e.message);
  process.exit(1);
});
