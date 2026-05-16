// ShopeeScope Singapore Proxy
// Deployed on Fly.io `sin` region — gives Shopee a MY/SG IP
// Vercel cron calls this instead of Shopee directly
import express from 'express';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const SECRET = process.env.PROXY_SECRET || '';

function extractCsrf(cookies) {
  if (!cookies) return null;
  const m = cookies.match(/SPC_CTOKEN=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function makeHeaders(cookies) {
  const csrf = extractCsrf(cookies);
  return {
    'x-api-source': 'pc',
    'x-shopee-language': 'en',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://shopee.com.my/',
    'Accept': 'application/json',
    'Accept-Language': 'en-MY,en;q=0.9,ms;q=0.8',
    ...(cookies ? { 'Cookie': cookies } : {}),
    ...(csrf ? { 'x-csrftoken': csrf } : {})
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, region: 'sin', ts: new Date().toISOString() });
});

app.post('/shopee', async (req, res) => {
  if (SECRET && req.headers['x-proxy-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { path, cookies } = req.body;
  if (!path) return res.status(400).json({ error: 'path required' });

  try {
    const r = await fetch(`https://shopee.com.my${path}`, {
      headers: makeHeaders(cookies),
      signal: AbortSignal.timeout(15000)
    });
    let data;
    try { data = await r.json(); } catch { data = { _proxy_error: 'non-JSON', status: r.status }; }
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`[proxy] Listening on :${PORT}`));
