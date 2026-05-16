// GET /api/test-shopee — diagnostic: shows exact Shopee response
const S = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_KEY;
const H_SB = { 'apikey': K, 'Authorization': 'Bearer ' + K };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Load cookies
  let cookies = null, cookieCount = 0;
  try {
    const r = await fetch(`${S}/rest/v1/config?key=eq.shopee_cookies&select=value`, { headers: H_SB });
    const rows = await r.json();
    cookies = rows?.[0]?.value || null;
    if (cookies) cookieCount = cookies.split(';').length;
  } catch(e) {}

  const csrfMatch = (cookies || '').match(/SPC_CTOKEN=([^;]+)/);
  const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : null;

  // Check which key cookies exist
  const hasSPCU = /SPC_U=/.test(cookies || '');
  const hasSPCF = /SPC_F=/.test(cookies || '');
  const hasCsrf = !!csrf;

  const headers = {
    'x-api-source': 'pc', 'x-shopee-language': 'en',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://shopee.com.my/', 'Accept': 'application/json',
    'Accept-Language': 'en-MY,en;q=0.9,ms;q=0.8',
    ...(cookies ? { 'Cookie': cookies } : {}),
    ...(csrf ? { 'x-csrftoken': csrf } : {})
  };

  // Test 1: shop detail (lighter endpoint)
  let shopStatus, shopBody;
  try {
    const r = await fetch('https://shopee.com.my/api/v4/shop/get_shop_detail?username=buddysnack', { headers, signal: AbortSignal.timeout(10000) });
    shopStatus = r.status;
    shopBody = (await r.text()).substring(0, 300);
  } catch(e) { shopStatus = 'ERR'; shopBody = e.message; }

  // Test 2: search items (the one that's failing)
  let searchStatus, searchBody;
  try {
    const r = await fetch('https://shopee.com.my/api/v4/search/search_items?by=sales&limit=10&match_id=3693884&newest=0&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2', { headers, signal: AbortSignal.timeout(10000) });
    searchStatus = r.status;
    searchBody = (await r.text()).substring(0, 300);
  } catch(e) { searchStatus = 'ERR'; searchBody = e.message; }

  return res.status(200).json({
    cookies_loaded: !!cookies,
    cookie_count: cookieCount,
    has_SPC_U: hasSPCU,
    has_SPC_F: hasSPCF,
    has_csrf_token: hasCsrf,
    csrf_value: csrf ? csrf.substring(0, 20) + '...' : null,
    shop_detail: { status: shopStatus, body: shopBody },
    search_items: { status: searchStatus, body: searchBody }
  });
}
