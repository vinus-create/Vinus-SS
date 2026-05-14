const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = async (table, method, body) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) { const err = await res.text(); throw new Error(err); }
  return res;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const start = Date.now();
  try {
    const { shop, products, username } = req.body;
    if (!shop || !products || !username) return res.status(400).json({ error: 'Missing fields' });

    await supabase('shops', 'POST', {
      username, shopid: shop.shopid, name: shop.name,
      follower_count: shop.follower_count || 0,
      following_count: shop.following_count || 0,
      rating_star: shop.rating_star || 0,
      rating_normal: shop.rating_normal || 0,
      rating_good: shop.rating_good || 0,
      rating_bad: shop.rating_bad || 0,
      item_count: shop.item_count || 0,
      response_rate: shop.response_rate || 0,
      response_time: shop.response_time || 0,
      is_official_shop: shop.is_official_shop || false,
      is_shopee_verified: shop.is_shopee_verified || false,
      vacation: shop.vacation || false,
      cancellation_rate: shop.cancellation_rate || 0,
      description: shop.description || '',
      updated_at: new Date().toISOString()
    });

    const today = new Date().toISOString().split('T')[0];
    const rows = products.map(p => ({
      shopid: shop.shopid, itemid: p.itemid, username,
      name: p.name,
      price_min: p.price_min || 0,
      price_max: p.price_max || p.price_min || 0,
      price_min_before_discount: p.price_min_before_discount || p.price_min || 0,
      raw_discount: p.raw_discount || 0,
      historical_sold: p.historical_sold || 0,
      sold: p.sold || 0,
      liked_count: p.liked_count || 0,
      view_count: p.view_count || 0,
      stock: p.stock || 0,
      rating_star: p.item_rating?.rating_star || 0,
      rating_count: p.item_rating?.rating_count?.reduce((a,b)=>a+b,0) || 0,
      brand: p.brand || '',
      catid: p.catid || 0,
      cb_option: p.cb_option || 0,
      image: p.image || '',
      ctime: p.ctime || 0,
      scraped_date: today,
      scraped_at: new Date().toISOString()
    }));

    const BATCH = 25;
    for (let i = 0; i < rows.length; i += BATCH) {
      await supabase('products', 'POST', rows.slice(i, i + BATCH));
    }

    await supabase('scrape_log', 'POST', {
      username, shopid: shop.shopid,
      total_items: products.length,
      status: 'success',
      duration_ms: Date.now() - start
    });

    return res.status(200).json({ ok: true, saved: products.length, shop: shop.name });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
