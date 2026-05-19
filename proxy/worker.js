// ShopeeScope — Cloudflare Worker Proxy
// Paste this into the Cloudflare Worker editor
// Routes Shopee API requests through CF's Singapore edge

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'vinus-proxy', ts: new Date().toISOString() });
    }

    // Only allow POST /shopee
    if (url.pathname !== '/shopee' || request.method !== 'POST') {
      return Response.json({ error: 'POST /shopee only' }, { status: 405 });
    }

    // Auth check
    const secret = env.PROXY_SECRET || '';
    if (secret && request.headers.get('x-proxy-secret') !== secret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { path, cookies } = await request.json();
    if (!path) return Response.json({ error: 'path required' }, { status: 400 });

    // Extract CSRF token from cookie string
    const csrfMatch = (cookies || '').match(/SPC_CTOKEN=([^;]+)/);
    const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : null;

    const headers = {
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
    };
    if (cookies) headers['Cookie'] = cookies;
    if (csrf) headers['x-csrftoken'] = csrf;

    try {
      const resp = await fetch(`https://shopee.com.my${path}`, { headers });
      const data = await resp.text();
      return new Response(data, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }
};
