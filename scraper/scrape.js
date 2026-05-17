// ShopeeScope — Playwright scraper for GitHub Actions
// Each shop runs in its own job with its own IP — no rate limits.
// Visitor cookies (no account) injected to bypass bot detection.

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const VERCEL_URL    = process.env.VERCEL_URL || 'https://vinus-ss.vercel.app';
const SHOP_NAME     = process.env.SHOP_NAME;
const COOKIE_STRING = process.env.SHOPEE_COOKIES || '';

if (!SHOP_NAME) {
  console.error('❌ SHOP_NAME env var is required');
  process.exit(1);
}

// Parse "name=value; name2=value2" → Playwright cookie objects
function parseCookies(str) {
  return str.split(';')
    .map(c => {
      const idx = c.indexOf('=');
      if (idx < 0) return null;
      const name  = c.slice(0, idx).trim();
      const value = c.slice(idx + 1).trim();
      if (!name || !value) return null;
      // Skip non-ASCII values (Playwright rejects ByteString > 255)
      for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) > 255) return null;
      }
      return { name, value, domain: '.shopee.com.my', path: '/', sameSite: 'Lax' };
    })
    .filter(Boolean);
}

async function main() {
  console.log(`🏪 Scraping: ${SHOP_NAME}`);

  const cookies = parseCookies(COOKIE_STRING);
  console.log(`🍪 Visitor cookies loaded: ${cookies.length}`);

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

  // Inject visitor cookies before navigation
  if (cookies.length > 0) await context.addCookies(cookies);

  const page = await context.newPage();

  // Warm up — navigate to Shopee homepage with cookies
  console.log('🏠 Warming up on shopee.com.my...');
  await page.goto('https://shopee.com.my', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const warmupUrl = page.url();
  console.log('   Landed on:', warmupUrl);
  if (warmupUrl.includes('verify/traffic') || warmupUrl.includes('/login')) {
    await browser.close();
    throw new Error('Bot detection triggered — visitor cookies may be expired.');
  }
  console.log('   ✅ Passed bot detection');

  // ── Scrape inside browser context ─────────────────────────────────────────
  const result = await page.evaluate(async ({ shopName, vercelUrl }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 1000)));

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
      if (json.error && json.error !== 0) throw new Error(`Shopee API error ${json.error}`);
      return json;
    };

    // Get shop detail
    const sr = await api(`/api/v4/shop/get_shop_detail?username=${shopName}`);
    if (!sr.data) throw new Error('shop not found');
    const shop = sr.data;
    console.log(`shopid=${shop.shopid} declared_items=${shop.item_count || '?'}`);

    // Fetch all products via 3 sort orders to bypass ~240 item cap
    const seen = new Set(), map = {};
    for (const by of ['sales', 'ctime', 'price']) {
      let off = 0;
      while (true) {
        let d;
        try {
          d = await api(
            `/api/v4/search/search_items?by=${by}&limit=60&match_id=${shop.shopid}` +
            `&newest=${off}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`
          );
        } catch (e) {
          console.log(`by=${by} off=${off} → ${e.message}`);
          break;
        }
        const batch = (d.items || []).map(i => i.item_basic).filter(Boolean);
        if (!batch.length) break;
        batch.forEach(p => { if (!seen.has(p.itemid)) { seen.add(p.itemid); map[p.itemid] = p; } });
        if (batch.length < 60) break;
        off += 60;
        await sleep(1200);
      }
      await sleep(1500);
    }

    const prods = Object.values(map);
    console.log(`fetched ${prods.length} unique products`);

    // Save via Vercel API → Supabase
    const rv = await (await fetch(`${vercelUrl}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop, products: prods, username: shopName }),
    })).json();

    return { shopid: shop.shopid, fetched: prods.length, saved: rv.saved || 0, shop: shop.name };
  }, { shopName: SHOP_NAME, vercelUrl: VERCEL_URL });

  await browser.close();

  console.log(`✅ ${SHOP_NAME} (${result.shop}): fetched=${result.fetched} saved=${result.saved}`);

  if (result.fetched === 0) {
    console.error('❌ 0 products — possible IP block or shop closed');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ Fatal:', e.message);
  process.exit(1);
});
