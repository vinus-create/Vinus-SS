// Supabase Edge Function — ShopeeScope daily scraper
// Runs on Deno in Singapore region, bypassing Shopee's geo-block
// Deploy: supabase functions deploy scrape --region ap-southeast-1
// Trigger: Vercel cron calls https://<project>.supabase.co/functions/v1/scrape

const S = Deno.env.get('SUPABASE_URL') ?? '';
const K = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

const FALLBACK_SHOPS = [
  {username:'buddysnack',         shopid:3693884},
  {username:'winstartech',        shopid:65231794},
  {username:'1stopbatteries',     shopid:436346628},
  {username:'icare4allshop',      shopid:101702703},
  {username:'energizerbatteryhub',shopid:1616613112},
  {username:'gadgetspecialist',   shopid:57639219},
  {username:'gou.ori',            shopid:3614138},
  {username:'tenbucksfood',       shopid:299773965},
  {username:'dsconcept_store',    shopid:1494888251},
  {username:'sxmixempire',        shopid:902193943},
  {username:'r_in_g',             shopid:1421385614},
  {username:'nextgenhardware.os', shopid:1088905843},
  {username:'ham_radios.my',      shopid:1231953709},
];

const H_SB: Record<string,string> = {
  'apikey': K,
  'Authorization': 'Bearer ' + K,
  'Content-Type': 'application/json',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * ms * 0.3)));

async function loadCookies(): Promise<string|null> {
  try {
    const r = await fetch(`${S}/rest/v1/config?key=eq.shopee_cookies&select=value`, {headers: H_SB});
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length && rows[0].value) return rows[0].value;
  } catch(e) { console.warn('Could not load cookies:', e); }
  return null;
}

function extractCsrf(cookies: string|null): string|null {
  if (!cookies) return null;
  const m = cookies.match(/SPC_CTOKEN=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

const makeShopeeHeaders = (cookies: string|null): Record<string,string> => {
  const csrf = extractCsrf(cookies);
  return {
    'x-api-source': 'pc',
    'x-shopee-language': 'en',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://shopee.com.my/',
    'Accept': 'application/json',
    'Accept-Language': 'en-MY,en;q=0.9,ms;q=0.8',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...(cookies ? {'Cookie': cookies} : {}),
    ...(csrf ? {'x-csrftoken': csrf} : {}),
  };
};

const shopee = async (path: string, cookies: string|null): Promise<unknown> => {
  const r = await fetch(`https://shopee.com.my${path}`, {
    headers: makeShopeeHeaders(cookies),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`${r.status}: ${path}`);
  return r.json();
};

const sb = async (table: string, rows: unknown[]): Promise<void> => {
  if (!rows.length) return;
  const BATCH = 25;
  for (let i = 0; i < rows.length; i += BATCH) {
    const r = await fetch(`${S}/rest/v1/${table}`, {
      method: 'POST',
      headers: {...H_SB, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
      body: JSON.stringify(rows.slice(i, i + BATCH)),
    });
    if (!r.ok) { const e = await r.text(); console.error(`sb ${table}:`, e.substring(0, 150)); }
    await sleep(80);
  }
};

const sbQuery = async (path: string): Promise<unknown[]> => {
  const r = await fetch(`${S}/rest/v1/${path}`, {headers: H_SB});
  if (!r.ok) return [];
  return r.json();
};

interface Shop { username: string; shopid: number; }
interface ScrapeResult { username: string; shopid: number; products: number; snapshots: number; reviews: number; }

async function scrapeShop(shop: Shop, cookies: string|null): Promise<ScrapeResult> {
  const {username, shopid} = shop;
  const today = new Date().toISOString().split('T')[0];
  const started = Date.now();
  let prodCount = 0, snapCount = 0, revCount = 0;

  try {
    // Load last known historical_sold from DB
    const dbProds = await sbQuery(`latest_products?shopid=eq.${shopid}&select=itemid,historical_sold&limit=1000`) as Array<{itemid:number;historical_sold:number}>;
    const hsMap: Record<number,number> = {};
    dbProds.forEach(p => { hsMap[p.itemid] = p.historical_sold || 0; });

    // Scrape 3 sort orders to bypass ~240 item cap
    const seenItemIds = new Set<number>();
    const prodsMap: Record<number,unknown> = {};
    for (const sortBy of ['sales','ctime','price']) {
      let offset = 0;
      while (true) {
        const d = await shopee(
          `/api/v4/search/search_items?by=${sortBy}&limit=60&match_id=${shopid}&newest=${offset}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`,
          cookies
        ) as {items?: Array<{item_basic?: unknown}>};
        const batch = (d.items || []).map((i: {item_basic?: unknown}) => i.item_basic).filter(Boolean) as Array<Record<string,unknown>>;
        if (!batch.length) break;
        batch.forEach(p => {
          const itemid = p.itemid as number;
          if (!seenItemIds.has(itemid)) {
            seenItemIds.add(itemid);
            prodsMap[itemid] = p;
          }
        });
        if (batch.length < 60) break;
        offset += 60;
        await sleep(700);
      }
      await sleep(1500);
    }
    const prods = Object.values(prodsMap) as Array<Record<string,unknown>>;
    prodCount = prods.length;

    if (prodCount === 0) throw new Error('No products returned — cookies may be expired');
    console.log(`  ${username}: ${prodCount} unique products`);

    // Save products
    await sb('products?on_conflict=shopid,itemid,scraped_date', prods.map(p => ({
      shopid, itemid: p.itemid, username, name: p.name,
      price_min: p.price_min || 0, price_max: p.price_max || p.price_min || 0,
      price_min_before_discount: p.price_min_before_discount || p.price_min || 0,
      raw_discount: p.raw_discount || 0,
      historical_sold: p.historical_sold || hsMap[p.itemid as number] || 0,
      sold: p.sold || 0, liked_count: p.liked_count || 0, stock: p.stock || 0,
      rating_star: (p.item_rating as Record<string,unknown>)?.rating_star || 0,
      rating_count: ((p.item_rating as Record<string,unknown>)?.rating_count as number[])?.reduce((a:number,b:number)=>a+b,0) || 0,
      brand: p.brand || '', catid: p.catid || 0,
      image: p.image || '', ctime: p.ctime || 0,
      scraped_date: today, scraped_at: new Date().toISOString(),
    })));

    // Top 30: variant snapshots + reviews
    const top30 = [...prods].sort((a,b) =>
      ((b.historical_sold as number) || hsMap[b.itemid as number] || 0) -
      ((a.historical_sold as number) || hsMap[a.itemid as number] || 0)
    ).slice(0, 30);

    const snaps: unknown[] = [], revs: unknown[] = [];
    for (const p of top30) {
      try {
        await sleep(700);
        const d = await shopee(`/api/v4/item/get?itemid=${p.itemid}&shopid=${shopid}`, cookies) as {data?: Record<string,unknown>};
        if (d.data?.models && (d.data.models as unknown[]).length > 0) {
          const vt = ((d.data.tier_variations as Array<{name:string}>) || []).map(v => v.name).join(' / ') || 'variant';
          (d.data.models as Array<Record<string,unknown>>).forEach(m => snaps.push({
            shopid, itemid: p.itemid, model_id: m.modelid || 0, username,
            product_name: p.name, variant_name: m.name || 'Default', variant_sku: m.model_sku || '',
            variation_type: vt, price: (m.price as number) / 100000, stock: m.stock || 0, sold: m.sold || 0,
            scraped_date: today, scraped_at: new Date().toISOString(),
          }));
        } else {
          snaps.push({
            shopid, itemid: p.itemid, model_id: 0, username,
            product_name: p.name, variant_name: 'Default', variant_sku: '', variation_type: 'single',
            price: (p.price_min as number || 0) / 100000, stock: p.stock || 0, sold: p.sold || 0,
            scraped_date: today, scraped_at: new Date().toISOString(),
          });
        }
        await sleep(700);
        const rr = await shopee(
          `/api/v2/item/get_ratings?itemid=${p.itemid}&shopid=${shopid}&limit=10&offset=0&filter=0&type=0&exclude_filter=1&flag=1&fold_filter=0&relevant_reviews=false&request_source=2`,
          cookies
        ) as {data?: {ratings?: Array<Record<string,unknown>>}};
        (rr.data?.ratings || []).forEach(rv => {
          if (!rv.comment) return;
          revs.push({
            shopid, itemid: p.itemid, product_name: p.name,
            rating_star: rv.rating_star || 0,
            comment: (rv.comment as string).substring(0, 500),
            author: rv.author_username || '',
            variant_bought: (rv.product_items as Array<{variation_name:string}>)?.[0]?.variation_name || '',
            tags: ((rv.tags as string[]) || []).join(','),
            has_seller_reply: !!(rv.reply && (rv.reply as Record<string,unknown>).comment),
            ctime: rv.ctime || 0, scraped_at: new Date().toISOString(),
          });
        });
      } catch(e) { console.warn(`  item err ${p.itemid}:`, e); }
      await sleep(600);
    }

    await sb('snapshots?on_conflict=shopid,itemid,model_id,scraped_date', snaps);
    await sb('reviews?on_conflict=shopid,itemid,ctime', revs);
    await sb('product_variants?on_conflict=shopid,itemid,model_id,scraped_date', snaps.map(s => ({...s as object})));
    snapCount = snaps.length; revCount = revs.length;

    await sb('scrape_log', [{username, shopid, total_items: prodCount, status: 'success', duration_ms: Date.now() - started}]);
    console.log(`✅ ${username}: ${prodCount} products, ${snapCount} snaps, ${revCount} reviews`);

  } catch(e) {
    const msg = (e as Error).message;
    console.error(`❌ ${username}:`, msg);
    await sb('scrape_log', [{username, shopid, total_items: 0, status: 'error', error_msg: msg.substring(0, 200), duration_ms: Date.now() - started}]);
  }
  return {username, shopid, products: prodCount, snapshots: snapCount, reviews: revCount};
}

Deno.serve(async (req: Request) => {
  // Allow OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {headers: {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization'}});
  }

  // Auth check
  const auth = req.headers.get('authorization') ?? '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({error: 'Unauthorized'}), {status: 401, headers: {'Content-Type': 'application/json'}});
  }

  const today = new Date().toISOString().split('T')[0];
  const cookies = await loadCookies();
  if (cookies) {
    console.log('✅ Loaded Shopee cookies from Supabase config');
  } else {
    console.warn('⚠️ No cookies found — scrape may fail');
  }

  // Load shop list from DB
  let SHOPS: Shop[] = FALLBACK_SHOPS;
  try {
    const r = await fetch(`${S}/rest/v1/shops?select=username,shopid&order=updated_at.desc&limit=200`, {headers: H_SB});
    const dbShops = await r.json() as Shop[];
    if (Array.isArray(dbShops) && dbShops.length) {
      const real = dbShops.filter(s => s.username && !s.username.startsWith('disc_'));
      if (real.length) SHOPS = real;
    }
  } catch(e) { console.warn('Could not load shops from DB:', e); }

  // Skip already-scraped today
  const doneToday = new Set<string>();
  try {
    const r = await fetch(`${S}/rest/v1/scrape_log?select=username&status=eq.success&scraped_at=gte.${today}T00:00:00Z&limit=100`, {headers: H_SB});
    const log = await r.json() as Array<{username:string}>;
    if (Array.isArray(log)) log.forEach(l => doneToday.add(l.username));
    if (doneToday.size) console.log(`⏭️ Already done today: ${[...doneToday].join(', ')}`);
  } catch(e) { console.warn('Could not check scrape_log:', e); }

  const pending = SHOPS.filter(s => !doneToday.has(s.username));
  const startAll = Date.now();
  console.log(`🕗 Started: ${new Date().toISOString()} — ${pending.length}/${SHOPS.length} shops to scrape`);

  const results: ScrapeResult[] = [];
  for (const shop of pending) {
    const r = await scrapeShop(shop, cookies);
    results.push(r);
    await sleep(5000);
  }

  const duration = Math.round((Date.now() - startAll) / 1000);
  console.log(`🏁 Done in ${duration}s`);
  return new Response(JSON.stringify({
    ok: true,
    region: 'ap-southeast-1',
    cookies_loaded: !!cookies,
    scraped_at: new Date().toISOString(),
    duration_seconds: duration,
    skipped: [...doneToday],
    shops: results,
  }), {headers: {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}});
});
