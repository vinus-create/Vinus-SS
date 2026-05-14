const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { shopid, itemid, sort = 'sold' } = req.query;

  try {
    const cols = { sold:'sold', price:'price', stock:'stock', name:'variant_name' };
    const order = cols[sort] || 'sold';
    let url = `${SUPABASE_URL}/rest/v1/product_variants?order=${order}.desc&limit=1000`;
    if (shopid) url += `&shopid=eq.${shopid}`;
    if (itemid) url += `&itemid=eq.${itemid}`;
    const r = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } });
    if (!r.ok) { const e = await r.text(); return res.status(500).json({ error: e }); }
    return res.status(200).json(await r.json());
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
