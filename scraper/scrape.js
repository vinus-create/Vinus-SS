// ShopeeScope — Playwright scraper for GitHub Actions
// Runs a real Chromium browser with stealth mode on GitHub's servers
// Cookies are loaded from Supabase, injected into browser context

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VERCEL_URL   = process.env.VERCEL_URL || 'https://vinus-ss.vercel.app';

const SHOPS = [
  'buddysnack','winstartech','1stopbatteries','icare4allshop',
  'energizerbatteryhub','gadgetspecialist','gou.ori','tenbucksfood',
  'dsconcept_store','sxmixempire','r_in_g','nextgenhardware.os','ham_radios.my'
];

// ── Load cookies from Supabase ────────────────────────────────────────────────
async function loadCookies() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/config?key=eq.shopee_cookies&select=value`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  const rows = await r.json();
  const val = rows?.[0]?.value;
  if (!val) throw new Error('No cookies in Supabase. Save fresh cookies first.');
  return val;
}

// ── Parse cookie string → Playwright cookie objects ───────────────────────────
function parseCookies(str) {
  return str.split(';')
    .map(c => {
      const idx = c.indexOf('=');
      if (idx < 0) return null;
      return {
        name:   c.slice(0, idx).trim(),
        value:  c.slice(idx + 1).trim(),
        domain: '.shopee.com.my',
        path:   '/',
        sameSite: 'Lax',
      };
    })
    .filter(c => c && c.name && c.value);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔑 Loading cookies from Supabase...');
  const cookieStr = await loadCookies();
  const cookies   = parseCookies(cookieStr);
  console.log(`   ${cookies.length} cookies loaded`);

  console.log('🌐 Launching Chromium (stealth)...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 720 },
    locale:    'en-MY',
    timezoneId: 'Asia/Kuala_Lumpur',
    extraHTTPHeaders: {
      'Accept-Language': 'en-MY,en;q=0.9,ms;q=0.8',
    },
  });

  await context.addCookies(cookies);
  const page = await context.newPage();

  // ── Navigate to Shopee, check session ──────────────────────────────────────
  console.log('🏠 Navigating to shopee.com.my...');
  await page.goto('https://shopee.com.my', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const finalUrl = page.url();
  console.log('   Final URL:', finalUrl);

  if (finalUrl.includes('verify/traffic') || finalUrl.includes('login')) {
    await browser.close();
    throw new Error('Bot detection triggered or session expired. Update cookies in Supabase.');
  }

  // Check login status
  const loginCheck = await page.evaluate(async () => {
    const r = await fetch('https://shopee.com.my/api/v4/account/basic', {
      credentials: 'include',
      headers: { 'x-api-source': 'pc', 'Accept': 'application/json' }
    });
    return r.json();
  });
  console.log('   Login status:', loginCheck?.data?.account?.username || 'not logged in');

  // ── Run scraper inside browser context ────────────────────────────────────
  console.log(`🕷️  Scraping ${SHOPS.length} shops...`);

  const results = await page.evaluate(async ({ shops, vercelUrl }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 400)));

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
      if (!r.ok) throw new Error(`${r.status}: ${path}`);
      return r.json();
    };

    async function allProds(shopid) {
      const seen = new Set(), map = {};
      for (const by of ['sales', 'ctime', 'price']) {
        let off = 0;
        while (true) {
          const d = await api(
            `/api/v4/search/search_items?by=${by}&limit=60&match_id=${shopid}` +
            `&newest=${off}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`
          );
          const b = (d.items || []).map(i => i.item_basic).filter(Boolean);
          if (!b.length) break;
          b.forEach(p => { if (!seen.has(p.itemid)) { seen.add(p.itemid); map[p.itemid] = p; } });
          if (b.length < 60) break;
          off += 60;
          await sleep(800);
        }
        await sleep(1500);
      }
      return Object.values(map);
    }

    const results = [];
    for (const username of shops) {
      try {
        const sr = await api(`/api/v4/shop/get_shop_detail?username=${username}`);
        if (!sr.data) throw new Error('shop not found');
        const shop  = sr.data;
        const prods = await allProds(shop.shopid);
        const rv = await (await fetch(`${vercelUrl}/api/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shop, products: prods, username }),
        })).json();
        results.push({ username, ok: true, saved: rv.saved || 0 });
        await sleep(8000);
      } catch(e) {
        results.push({ username, ok: false, error: e.message });
        await sleep(2000);
      }
    }
    return results;
  }, { shops: SHOPS, vercelUrl: VERCEL_URL });

  await browser.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  const ok = results.filter(r => r.ok).length;
  console.log(`\n📊 Done: ${ok}/${SHOPS.length} shops scraped`);
  console.table(results);

  if (ok === 0) process.exit(1);
}

main().catch(e => {
  console.error('❌ Fatal:', e.message);
  process.exit(1);
});
