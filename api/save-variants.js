const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { variants } = req.body;
    if (!variants?.length) return res.status(400).json({ error: 'No variants' });

    const res2 = await fetch(`${SUPABASE_URL}/rest/v1/product_variants?on_conflict=shopid,itemid,variant_name,scraped_date`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(variants)
    });
    if (!res2.ok) { const e = await res2.text(); throw new Error(e); }
    return res.status(200).json({ ok: true, saved: variants.length });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
