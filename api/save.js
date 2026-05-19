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

  // Generic enriched upsert (replaces /api/save-enriched)
  // Body: { type: 'table_name', data: [...rows] }
  if (req.body.type && !req.body.shop) {
    const { type, data } = req.body;
    if (!type || !data?.length) return res.status(400).json({ error: 'Missing type or data' });
    const BATCH = 25;
    try {
      for (let i = 0; i < data.length; i += BATCH) {
        await supabase(type, 'POST', data.slice(i, i + BATCH));
      }
      return res.status(200).json({ ok: true, saved: data.length, type });
    } catch(err) { return res.status(500).json({ error: err.message }); }
  }

  const start = Date.now();
  try {
    const { shop, products, username } = req.body;
    if (!shop || !products || !username) return res.status(400).json({ error: 'Missing fields' });

    await supabase('shops?on_conflict=username', 'POST', {
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
      await supabase('products?on_conflict=shopid,itemid,scraped_date', 'POST', rows.slice(i, i + BATCH));
    }

    // Auto-save product-level snapshots for velocity tracking
    const snapshots = rows.map(p => ({
      shopid: p.shopid, itemid: p.itemid, model_id: 0, username: p.username,
      product_name: p.name, variant_name: 'Default', variant_sku: '',
      variation_type: 'product',
      price: (p.price_min || 0) / 100000,
      stock: p.stock || 0,
      sold: p.historical_sold || 0,
      scraped_date: today, scraped_at: new Date().toISOString()
    }));
    for (let i = 0; i < snapshots.length; i += BATCH) {
      await supabase('snapshots?on_conflict=shopid,itemid,model_id,scraped_date', 'POST', snapshots.slice(i, i + BATCH));
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
