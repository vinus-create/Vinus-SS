// ShopeeScope — Self-hosted runner scraper
// Runs on YOUR PC with YOUR Malaysian IP — no bot detection possible
// Each shop is one job, 13 parallel (but self-hosted runner runs them sequentially by default)

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const VERCEL_URL = process.env.VERCEL_URL || 'https://vinus-ss.vercel.app';
const SHOP_NAME  = process.env.SHOP_NAME;

if (!SHOP_NAME) {
  console.error('❌ SHOP_NAME env var is required');
  process.exit(1);
}

async function main() {
  console.log(`🏪 Scraping: ${SHOP_NAME} (from home IP)`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 720 },
    locale:    'en-MY',
    timezoneId: 'Asia/Kuala_Lumpur',
    extraHTTPHeaders: { 'Accept-Language': 'en-MY,en;q=0.9,ms;q=0.8' },
  });

  const page = await context.newPage();

  console.log('🏠 Navigating to shopee.com.my...');
  await page.goto('https://shopee.com.my', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const url = page.url();
  console.log('   URL:', url);
  if (url.includes('verify/traffic') || url.includes('/login')) {
    await browser.close();
    throw new Error('Blocked — check your internet connection.');
  }
  console.log('   ✅ Home IP passed bot detection');

  const result = await page.evaluate(async ({ shopName, vercelUrl }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 800)));

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

    const sr = await api(`/api/v4/shop/get_shop_detail?username=${shopName}`);
    if (!sr.data) throw new Error('shop not found');
    const shop = sr.data;
    console.log(`shopid=${shop.shopid} items=${shop.item_count || '?'}`);

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
        } catch(e) {
          console.log(`by=${by}: ${e.message}`);
          break;
        }
        const batch = (d.items || []).map(i => i.item_basic).filter(Boolean);
        if (!batch.length) break;
        batch.forEach(p => { if (!seen.has(p.itemid)) { seen.add(p.itemid); map[p.itemid] = p; } });
        if (batch.length < 60) break;
        off += 60;
        await sleep(1000);
      }
      await sleep(1500);
    }

    const prods = Object.values(map);
    console.log(`fetched ${prods.length} products`);

    const rv = await (await fetch(`${vercelUrl}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop, products: prods, username: shopName }),
    })).json();

    return { shopid: shop.shopid, fetched: prods.length, saved: rv.saved || 0, shop: shop.name };
  }, { shopName: SHOP_NAME, vercelUrl: VERCEL_URL });

  await browser.close();
  console.log(`✅ ${SHOP_NAME}: fetched=${result.fetched} saved=${result.saved}`);

  if (result.fetched === 0) {
    console.error('❌ 0 products — check if shop is still active');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ Fatal:', e.message);
  process.exit(1);
});
