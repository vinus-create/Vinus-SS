// GET /api/shop-profile?username=buddysnack
// Fetches live shop detail from Shopee using stored cookies
const S = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_KEY;
const H_SB = { 'apikey': K, 'Authorization': 'Bearer ' + K, 'Content-Type': 'application/json' };

async function loadCookies() {
  try {
    const r = await fetch(`${S}/rest/v1/config?key=eq.shopee_cookies&select=value`, { headers: H_SB });
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length && rows[0].value) return rows[0].value;
  } catch(e) {}
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username required' });

  const cookies = await loadCookies();
  const headers = {
    'x-api-source': 'pc',
    'x-shopee-language': 'en',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://shopee.com.my/',
    'Accept': 'application/json',
    ...(cookies ? { 'Cookie': cookies } : {})
  };

  try {
    const r = await fetch(`https://shopee.com.my/api/v4/shop/get_shop_detail?username=${encodeURIComponent(username)}`, {
      headers,
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return res.status(502).json({ error: `Shopee returned ${r.status}` });
    const d = await r.json();
    if (!d.data) return res.status(404).json({ error: 'Shop not found' });

    const sd = d.data;
    return res.status(200).json({
      ok: true,
      username,
      name: sd.name,
      shopid: sd.shopid,
      ctime: sd.ctime,
      avatar: sd.account?.portrait || sd.icon || '',
      follower_count: sd.follower_count || 0,
      response_rate: sd.response_rate ?? null,
      response_time: sd.response_time_computed ?? sd.response_time ?? null,
      shop_location: sd.shop_location || '',
      rating_star: sd.overall_star || 0,
      rating_good: sd.rating_good || 0,
      rating_normal: sd.rating_normal || 0,
      rating_bad: sd.rating_bad || 0,
      is_shopee_verified: !!sd.is_shopee_verified,
      is_preferred_plus: !!sd.is_preferred_plus_seller,
      is_official_shop: !!sd.is_official_shop,
      item_count: sd.item_count || 0,
      description: (sd.description || '').substring(0, 200),
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
