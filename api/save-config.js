// POST: save key-value config to Supabase (used for storing Shopee cookies)
const S = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET || '';
const H = { 'apikey': K, 'Authorization': 'Bearer ' + K, 'Content-Type': 'application/json' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: read a config value
  if (req.method === 'GET') {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key required' });
    const r = await fetch(`${S}/rest/v1/config?key=eq.${encodeURIComponent(key)}&select=key,updated_at`, { headers: H });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'not found' });
    return res.status(200).json({ key: rows[0].key, updated_at: rows[0].updated_at });
  }

  // POST: save config value
  if (req.method === 'POST') {
    const { key, value, secret } = req.body || {};
    // Allow either cron secret or no auth (bookmarklet use)
    if (CRON_SECRET && secret !== CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!key || !value) return res.status(400).json({ error: 'key and value required' });

    const r = await fetch(`${S}/rest/v1/config?on_conflict=key`, {
      method: 'POST',
      headers: { ...H, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
    });
    if (!r.ok) { const e = await r.text(); return res.status(500).json({ error: e }); }
    return res.status(200).json({ ok: true, key, updated_at: new Date().toISOString() });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
