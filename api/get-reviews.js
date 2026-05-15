const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { shopid, itemid, limit = '200' } = req.query;
  if (!shopid) return res.status(400).json({ error: 'shopid required' });

  try {
    let url = `${SUPABASE_URL}/rest/v1/reviews?shopid=eq.${shopid}&order=ctime.desc&limit=${limit}`;
    if (itemid) url += `&itemid=eq.${itemid}`;

    const r = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    if (!r.ok) { const e = await r.text(); return res.status(500).json({ error: e }); }
    const reviews = await r.json();

    // Compute summary
    const total = reviews.length;
    const avg = total ? (reviews.reduce((s, r) => s + (r.rating_star || 0), 0) / total) : 0;
    const stars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    reviews.forEach(r => { if (r.rating_star >= 1 && r.rating_star <= 5) stars[r.rating_star]++; });

    // Top tags
    const tagMap = {};
    reviews.forEach(r => {
      (r.tags || '').split(',').filter(t => t.trim()).forEach(t => {
        tagMap[t.trim()] = (tagMap[t.trim()] || 0) + 1;
      });
    });
    const topTags = Object.entries(tagMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));

    return res.status(200).json({
      reviews,
      summary: { total, avg: +avg.toFixed(2), stars, topTags }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
