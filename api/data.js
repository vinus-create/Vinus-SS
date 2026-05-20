const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const H_SB = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };

const query = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H_SB });
  return res.json();
};

async function loadCookies() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/config?key=eq.shopee_cookies&select=value`, { headers: H_SB });
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length && rows[0].value) return rows[0].value;
  } catch(e) {}
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { type, shopid, catid, limit = 200 } = req.query;
  try {
    if (type === 'shops') {
      // Merge shops table (all registered shops) with shop_stats (aggregated product data)
      // This ensures new shops appear even before their first scrape
      const [allShops, stats] = await Promise.all([
        query('shops?select=shopid,username,name,item_count&order=shopid'),
        query('shop_stats?select=shopid,total_products,total_sold,avg_price_rm,max_discount,avg_product_rating,last_scraped&order=total_sold.desc')
      ]);
      const sm = {};
      (Array.isArray(stats) ? stats : []).forEach(s => { sm[s.shopid] = s; });
      const merged = (Array.isArray(allShops) ? allShops : []).map(s => ({
        shopid: s.shopid,
        username: s.username,
        shop_name: s.name,
        item_count: s.item_count || 0,
        total_products: sm[s.shopid]?.total_products || 0,
        total_sold: sm[s.shopid]?.total_sold || 0,
        avg_price_rm: sm[s.shopid]?.avg_price_rm || 0,
        max_discount: sm[s.shopid]?.max_discount || 0,
        avg_product_rating: sm[s.shopid]?.avg_product_rating || 0,
        last_scraped: sm[s.shopid]?.last_scraped || null
      })).sort((a, b) => (b.total_sold || 0) - (a.total_sold || 0));
      return res.status(200).json(merged);
    }

    // All shops including auto-discovered (from market_rankings view)
    if (type === 'market') {
      const data = await query('market_rankings?order=total_sold.desc&limit=500');
      return res.status(200).json(data);
    }

    if (type === 'products' && shopid) {
      const data = await query(`latest_products?shopid=eq.${shopid}&order=historical_sold.desc&limit=${limit}`);
      // If today's scrape returned historical_sold=0 (Shopee hides this for visitor sessions),
      // fall back to the best known value from previous scrape dates
      const hasZeroSold = data.some(p => !p.historical_sold);
      let maxSold = {};
      if (hasZeroSold) {
        const hist = await query(`products?shopid=eq.${shopid}&historical_sold=gt.0&order=historical_sold.desc&limit=2000`);
        hist.forEach(p => { if ((p.historical_sold||0) > (maxSold[p.itemid]||0)) maxSold[p.itemid] = p.historical_sold; });
      }
      const enhanced = data.map(p => ({
        ...p,
        historical_sold: maxSold[p.itemid] || p.historical_sold || 0,
        image_url: p.image ? `https://down-my.img.susercontent.com/file/${p.image}` : '',
        product_url: p.username && p.shopid && p.itemid
          ? `https://shopee.com.my/${p.username}-i.${p.shopid}.${p.itemid}` : ''
      }));
      // Re-sort by best historical_sold after merge
      enhanced.sort((a,b) => (b.historical_sold||0) - (a.historical_sold||0));
      return res.status(200).json(enhanced);
    }

    // Products by category across all shops
    if (type === 'category' && catid) {
      const data = await query(`latest_products?catid=eq.${catid}&order=historical_sold.desc&limit=${limit}`);
      const hasZeroSold = data.some(p => !p.historical_sold);
      let maxSold = {};
      if (hasZeroSold) {
        const hist = await query(`products?catid=eq.${catid}&historical_sold=gt.0&order=historical_sold.desc&limit=3000`);
        hist.forEach(p => { if ((p.historical_sold||0) > (maxSold[p.itemid]||0)) maxSold[p.itemid] = p.historical_sold; });
      }
      const enhanced = data.map(p => ({
        ...p,
        historical_sold: maxSold[p.itemid] || p.historical_sold || 0,
        image_url: p.image ? `https://down-my.img.susercontent.com/file/${p.image}` : '',
        product_url: p.username && p.shopid && p.itemid
          ? `https://shopee.com.my/${p.username}-i.${p.shopid}.${p.itemid}` : ''
      }));
      enhanced.sort((a,b) => (b.historical_sold||0) - (a.historical_sold||0));
      return res.status(200).json(enhanced);
    }

    // Top sellers across ALL shops (market-wide)
    if (type === 'top-products') {
      const data = await query(`latest_products?order=historical_sold.desc&limit=${limit}`);
      const hasZeroSold = data.some(p => !p.historical_sold);
      let maxSold = {};
      if (hasZeroSold) {
        const hist = await query(`products?historical_sold=gt.0&order=historical_sold.desc&limit=5000`);
        hist.forEach(p => { if ((p.historical_sold||0) > (maxSold[p.itemid]||0)) maxSold[p.itemid] = p.historical_sold; });
      }
      const enhanced = data.map(p => ({
        ...p,
        historical_sold: maxSold[p.itemid] || p.historical_sold || 0,
        image_url: p.image ? `https://down-my.img.susercontent.com/file/${p.image}` : '',
        product_url: p.username && p.shopid && p.itemid
          ? `https://shopee.com.my/${p.username}-i.${p.shopid}.${p.itemid}` : ''
      }));
      enhanced.sort((a,b) => (b.historical_sold||0) - (a.historical_sold||0));
      return res.status(200).json(enhanced);
    }

    if (type === 'log') {
      const data = await query('scrape_log?order=scraped_at.desc&limit=50');
      return res.status(200).json(data);
    }

    // Which shops have products saved for today — used by extension to skip completed shops on resume
    // Returns { shops: ['username',...], counts: { username: total_items } }
    if (type === 'scraped-today') {
      const today = new Date().toISOString().split('T')[0];
      const data = await query(`products?scraped_date=eq.${today}&select=username&limit=5000`);
      const rows = Array.isArray(data) ? data : [];
      const countMap = {};
      rows.forEach(p => { countMap[p.username] = (countMap[p.username] || 0) + 1; });
      const shops = Object.keys(countMap);
      return res.status(200).json({ shops, counts: countMap });
    }

    // Shop profile — live fetch from Shopee (replaces /api/shop-profile)
    if (type === 'shop-profile') {
      const { username } = req.query;
      if (!username) return res.status(400).json({ error: 'username required' });
      const cookies = await loadCookies();
      const csrf = cookies ? (cookies.match(/SPC_CTOKEN=([^;]+)/)||[])[1] : null;
      const headers = {
        'x-api-source':'pc','x-shopee-language':'en',
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer':'https://shopee.com.my/','Accept':'application/json',
        ...(cookies?{'Cookie':cookies}:{}),
        ...(csrf?{'x-csrftoken':decodeURIComponent(csrf)}:{})
      };
      try {
        const r = await fetch(`https://shopee.com.my/api/v4/shop/get_shop_detail?username=${encodeURIComponent(username)}`,{headers,signal:AbortSignal.timeout(10000)});
        if (!r.ok) return res.status(502).json({ error: `Shopee ${r.status}` });
        const d = await r.json();
        if (!d.data) return res.status(404).json({ error: 'Shop not found' });
        const sd = d.data;
        return res.status(200).json({
          ok:true, username, name:sd.name, shopid:sd.shopid, ctime:sd.ctime,
          avatar:sd.account?.portrait||sd.icon||'', follower_count:sd.follower_count||0,
          response_rate:sd.response_rate??null, response_time:sd.response_time_computed??sd.response_time??null,
          shop_location:sd.shop_location||'', rating_star:sd.overall_star||0,
          rating_good:sd.rating_good||0, rating_normal:sd.rating_normal||0, rating_bad:sd.rating_bad||0,
          is_shopee_verified:!!sd.is_shopee_verified, is_preferred_plus:!!sd.is_preferred_plus_seller,
          is_official_shop:!!sd.is_official_shop, item_count:sd.item_count||0,
          description:(sd.description||'').substring(0,200)
        });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // Active sellers — products needing item/get enrichment today
    // Rules:
    //   1. historical_sold delta > 0  → definitely selling (exact for <1000, rounded for >=1000)
    //   2. historical_sold >= 1000 AND last enriched > 2 days ago → force-include
    //      (Shopee rounds 1000+ so delta can be 0 even when sales occurred)
    if (type === 'active-sellers' && shopid) {
      const today     = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const twoDaysAgo= new Date(Date.now() - 2*86400000).toISOString().split('T')[0];
      const [todayRows, yestRows, recentEnriched] = await Promise.all([
        query(`products?shopid=eq.${shopid}&scraped_date=eq.${today}&select=itemid,name,historical_sold,price_min,stock,image&limit=2000`),
        query(`products?shopid=eq.${shopid}&scraped_date=eq.${yesterday}&select=itemid,historical_sold&limit=2000`),
        // Products enriched in the last 2 days (already have recent variant data)
        query(`product_variants?shopid=eq.${shopid}&scraped_date=gte.${twoDaysAgo}&select=itemid&limit=2000`)
      ]);
      const yMap = {};
      if (Array.isArray(yestRows)) yestRows.forEach(p => { yMap[p.itemid] = p.historical_sold || 0; });
      const enrichedRecently = new Set();
      if (Array.isArray(recentEnriched)) recentEnriched.forEach(p => enrichedRecently.add(p.itemid));

      const active = Array.isArray(todayRows) ? todayRows.filter(p => {
        const hs    = p.historical_sold || 0;
        const delta = hs - (yMap[p.itemid] || 0);
        // Rule 1: delta > 0 (new sales detected — always accurate for <1000)
        if (delta > 0) return true;
        // Rule 2: high-volume product (>=1000) not enriched in last 2 days
        // Shopee rounds these so delta=0 may hide real sales
        if (hs >= 1000 && !enrichedRecently.has(p.itemid)) return true;
        return false;
      }).map(p => ({
        ...p,
        sold_today_est: (p.historical_sold || 0) - (yMap[p.itemid] || 0),
        needs_enrich_reason: ((p.historical_sold||0) - (yMap[p.itemid]||0)) > 0 ? 'delta' : 'high_volume_force',
        image_url: p.image ? `https://down-my.img.susercontent.com/file/${p.image}` : ''
      })) : [];
      return res.status(200).json({ today, yesterday, total: Array.isArray(todayRows) ? todayRows.length : 0, active });
    }

    // Category intelligence — cross-shop category breakdown
    if (type === 'category-intel') {
      const data = await query('latest_products?select=catid,shopid,itemid,price_min,historical_sold,raw_discount&limit=5000');
      if (!Array.isArray(data)) return res.status(200).json([]);
      const cats = {};
      data.forEach(p => {
        const c = p.catid || 0;
        if (!cats[c]) cats[c] = { catid:c, shops:new Set(), products:0, total_sold:0, prices:[], max_discount:0 };
        cats[c].shops.add(p.shopid);
        cats[c].products++;
        cats[c].total_sold += p.historical_sold||0;
        if (p.price_min) cats[c].prices.push(p.price_min/100000);
        cats[c].max_discount = Math.max(cats[c].max_discount, p.raw_discount||0);
      });
      const result = Object.values(cats).map(c => ({
        catid: c.catid,
        shop_count: c.shops.size,
        product_count: c.products,
        total_sold: c.total_sold,
        avg_price_rm: c.prices.length ? +(c.prices.reduce((a,b)=>a+b,0)/c.prices.length).toFixed(2) : 0,
        max_discount: c.max_discount
      })).sort((a,b) => b.total_sold - a.total_sold).slice(0, 50);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Invalid type' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
