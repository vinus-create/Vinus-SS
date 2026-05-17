// ShopeeScope — Self-hosted scraper
// Uses real Chrome profile (has valid Akamai cookies from normal browsing)
// Confirmed working strategy: sales sort only, 3s/call, 90s between shops

const { chromium } = require('playwright');

const VERCEL_URL  = process.env.VERCEL_URL  || 'https://vinus-ss.vercel.app';
const SHOP_NAME   = process.env.SHOP_NAME;
const CHROME_PROFILE = 'C:\\Users\\cws98\\AppData\\Local\\Google\\Chrome\\User Data';

if (!SHOP_NAME) {
  console.error('❌ SHOP_NAME env var is required');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 800)));

async function main() {
  console.log(`🏪 Scraping: ${SHOP_NAME}`);

  const context = await chromium.launchPersistentContext(CHROME_PROFILE, {
    channel: 'chrome',
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--start-minimized',
    ],
    userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:   { width: 1280, height: 720 },
    locale:     'en-MY',
    timezoneId: 'Asia/Kuala_Lumpur',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('   Navigating to Shopee...');
  await page.goto('https://shopee.com.my', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  const url = page.url();
  if (url.includes('verify/traffic') || url.includes('/login') || url.includes('verify/captcha')) {
    await context.close();
    throw new Error('Blocked — open Chrome manually and visit shopee.com.my once to refresh cookies.');
  }
  console.log('   ✅ Passed bot detection');

  const result = await page.evaluate(async ({ shopName, vercelUrl }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 800)));
    const shopUrl = `https://shopee.com.my/${shopName}`;

    const api = async path => {
      const r = await fetch('https://shopee.com.my' + path, {
        credentials: 'include',
        headers: {
          'x-api-source':      'pc',
          'x-shopee-language': 'en',
          'Accept':            'application/json',
          'Referer':           shopUrl,
          'Sec-Fetch-Dest':    'empty',
          'Sec-Fetch-Mode':    'cors',
          'Sec-Fetch-Site':    'same-origin',
        }
      });
      const json = await r.json();
      if (json.error && json.error !== 0) throw new Error(`Shopee API error ${json.error}`);
      return json;
    };

    // Shop detail
    const sr = await api(`/api/v4/shop/get_shop_detail?username=${shopName}`);
    if (!sr.data) throw new Error('shop not found');
    const shop = sr.data;

    // Products — sales sort ONLY (confirmed: avoids CAPTCHA, covers all products)
    const seen = new Set(), map = {};
    let off = 0;
    while (true) {
      let d;
      try {
        d = await api(
          `/api/v4/search/search_items?by=sales&limit=60&match_id=${shop.shopid}` +
          `&newest=${off}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`
        );
      } catch(e) { console.log(`  err off=${off}: ${e.message}`); break; }

      const batch = (d.items || []).map(i => i.item_basic).filter(Boolean);
      if (!batch.length) break;
      batch.forEach(p => { if (!seen.has(p.itemid)) { seen.add(p.itemid); map[p.itemid] = p; } });
      console.log(`  page off=${off}: ${batch.length} items`);
      if (batch.length < 60) break;
      off += 60;
      await sleep(3000); // 3s between pages — confirmed safe
    }

    const prods = Object.values(map);
    const rv = await fetch(`${vercelUrl}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop, products: prods, username: shopName }),
    });
    const res = await rv.json();
    return { fetched: prods.length, saved: res.saved || 0 };
  }, { shopName: SHOP_NAME, vercelUrl: VERCEL_URL });

  await context.close();
  console.log(`✅ ${SHOP_NAME}: fetched=${result.fetched} saved=${result.saved}`);

  if (result.fetched === 0) {
    console.error('❌ 0 products — shop may be inactive');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ Fatal:', e.message);
  process.exit(1);
});
