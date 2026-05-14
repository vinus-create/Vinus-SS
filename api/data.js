const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const query = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  return res.json();
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { type, shopid, limit = 200 } = req.query;
  try {
    if (type === 'shops') {
      const data = await query('shop_stats?order=total_sold.desc');
      return res.status(200).json(data);
    }
    if (type === 'products' && shopid) {
      const data = await query(`latest_products?shopid=eq.${shopid}&order=historical_sold.desc&limit=${limit}`);
      return res.status(200).json(data);
    }
    if (type === 'log') {
      const data = await query('scrape_log?order=scraped_at.desc&limit=20');
      return res.status(200).json(data);
    }
    return res.status(400).json({ error: 'Invalid type' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
