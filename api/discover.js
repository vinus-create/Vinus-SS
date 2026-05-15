// POST: receives browser-crawled products from category discovery
// Also supports GET for server-side category crawl (limited without cookies)
const S = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET || '';

const sb = async (table, rows, conflict, mode = 'merge-duplicates') => {
  if (!rows.length) return 0;
  const BATCH = 50;
  let saved = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const url = `${S}/rest/v1/${table}${conflict ? '?on_conflict=' + conflict : ''}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'apikey': K,
        'Authorization': 'Bearer ' + K,
        'Prefer': `resolution=${mode},return=minimal`
      },
      body: JSON.stringify(rows.slice(i, i + BATCH))
    });
    if (r.ok) saved += Math.min(BATCH, rows.length - i);
    else { const e = await r.text(); console.error(`sb ${table}:`, e.substring(0, 200)); }
    await new Promise(r => setTimeout(r, 80));
  }
  return saved;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: server-side crawl (may return empty without Shopee session cookies)
  if (req.method === 'GET') {
    const auth = req.headers.authorization || '';
    const secret = req.query.secret || '';
    if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}` && secret !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const { catids = '11042', pages = '3' } = req.query;
    const catList = catids.split(',').map(Number).filter(Boolean);
    const maxPages = Math.min(parseInt(pages) || 3, 10);
    const today = new Date().toISOString().split('T')[0];
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const H = {
      'x-api-source': 'pc', 'x-shopee-language': 'en',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://shopee.com.my/', 'Accept': 'application/json',
    };

    const products = [];
    for (const catid of catList) {
      let offset = 0;
      for (let p = 0; p < maxPages; p++) {
        try {
          const r = await fetch(`https://shopee.com.my/api/v4/search/search_items?by=sales&limit=60&match_id=${catid}&newest=${offset}&order=desc&page_type=search&scenario=PAGE_CATEGORY&version=2`, { headers: H, signal: AbortSignal.timeout(12000) });
          if (!r.ok) break;
          const d = await r.json();
          const items = (d.items || []).map(i => i.item_basic);
          if (!items.length) break;
          products.push(...items);
          if (items.length < 60) break;
          offset += 60;
          await sleep(600);
        } catch (e) { break; }
      }
      await sleep(800);
    }

    if (!products.length) return res.status(200).json({ ok: true, message: 'No results from server-side (use browser trigger)', products_saved: 0, shops_discovered: 0 });

    return await saveDiscoveredProducts(res, products, catList, today);
  }

  // POST: receive products from browser-side crawl
  if (req.method === 'POST') {
    const { products = [], catids = [] } = req.body;
    if (!products.length) return res.status(400).json({ error: 'No products provided' });
    const today = new Date().toISOString().split('T')[0];
    return await saveDiscoveredProducts(res, products, catids, today);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function saveDiscoveredProducts(res, products, catids, today) {
  try {
    // Map unique shops found
    const shopsMap = {};
    products.forEach(p => {
      if (!p.shopid) return;
      if (!shopsMap[p.shopid]) shopsMap[p.shopid] = { shopid: p.shopid, name: p.shop_name || '', catids: new Set(), count: 0 };
      shopsMap[p.shopid].count++;
      if (p.catid) shopsMap[p.shopid].catids.add(p.catid);
    });

    // Save products
    const productRows = products.filter(p => p.shopid && p.itemid).map(p => ({
      shopid: p.shopid, itemid: p.itemid,
      username: '',
      name: (p.name || '').substring(0, 500),
      price_min: p.price_min || 0, price_max: p.price_max || p.price_min || 0,
      price_min_before_discount: p.price_min_before_discount || p.price_min || 0,
      raw_discount: p.raw_discount || 0,
      historical_sold: p.historical_sold || 0, sold: p.sold || 0,
      liked_count: p.liked_count || 0, stock: p.stock || 0,
      rating_star: p.item_rating?.rating_star || 0,
      rating_count: p.item_rating?.rating_count?.reduce((a, b) => a + b, 0) || 0,
      brand: p.brand || '', catid: p.catid || 0,
      image: p.image || '', ctime: p.ctime || 0,
      scraped_date: today, scraped_at: new Date().toISOString()
    }));

    const productsSaved = await sb('products', productRows, 'shopid,itemid,scraped_date');

    // Save newly discovered shops with minimal info (ignore if shop already exists)
    const shopRows = Object.values(shopsMap).map(s => ({
      shopid: s.shopid,
      username: 'disc_' + s.shopid,
      name: s.name || ('Shop ' + s.shopid),
      source: 'discovered',
      first_seen: today,
      updated_at: new Date().toISOString()
    }));
    // ignore-duplicates: don't overwrite existing shops with placeholder data
    await sb('shops?on_conflict=shopid', shopRows, null, 'ignore-duplicates');

    return res.status(200).json({
      ok: true,
      products_saved: productsSaved,
      shops_discovered: Object.keys(shopsMap).length,
      new_shopids: Object.keys(shopsMap)
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
