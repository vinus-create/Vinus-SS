// Single-shop scraper — runs in ISOLATED world to avoid Shopee's fetch interceptor
// Reads params from DOM attributes set by popup.js (shared across worlds)

(async () => {
  const el  = document.documentElement;
  const u   = el.getAttribute('data-ss-u');
  const sid = parseInt(el.getAttribute('data-ss-sid'));
  const V   = el.getAttribute('data-ss-v');
  el.removeAttribute('data-ss-u'); el.removeAttribute('data-ss-sid'); el.removeAttribute('data-ss-v');
  if (!u || !sid || !V) return;
  if (window._SS_single?.running) return;

  const today = new Date().toLocaleDateString('en-CA');
  const sleep = ms => new Promise(r => setTimeout(r, ms + ~~(Math.random() * 500)));
  const hdr = {
    credentials: 'include',
    headers: { 'x-api-source': 'pc', 'x-shopee-language': 'en', 'Accept': 'application/json' }
  };

  window._SS_single = { running: true, shop: u, phase: 'search', products: 0, variants: 0, errors: 0 };

  function rdSend() {
    window.postMessage({ type: 'SS_SINGLE_UPDATE', data: { ...window._SS_single } }, '*');
  }

  console.log('[SS] scraping', u);

  // Phase 1: search products
  const seen = new Set(), map = {};
  for (const by of ['sales', 'ctime', 'price']) {
    let off = 0;
    while (true) {
      try {
        const r = await fetch(
          `https://shopee.com.my/api/v4/search/search_items?by=${by}&limit=60&match_id=${sid}&newest=${off}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`,
          hdr
        );
        if (!r.ok) break;
        const d = await r.json();
        const b = (d.items || []).map(i => i.item_basic).filter(Boolean);
        if (!b.length) break;
        b.forEach(p => { if (!seen.has(p.itemid)) { seen.add(p.itemid); map[p.itemid] = p; } });
        if (b.length < 60) break;
        off += 60;
      } catch(e) { break; }
      await sleep(800);
    }
    await sleep(1200);
  }

  const prods = Object.values(map);
  window._SS_single.products = prods.length;
  rdSend();

  if (prods.length) {
    // Upsert minimal shop record so it appears in shop_stats (which JOINs the shops table)
    await fetch(`${V}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'shops?on_conflict=username', data: [{ username: u, shopid: sid }] })
    });

    const rows = prods.map(p => ({
      shopid: sid, itemid: p.itemid, username: u, name: p.name,
      price_min: p.price_min || 0, price_max: p.price_max || p.price_min || 0,
      price_min_before_discount: p.price_min_before_discount || p.price_min || 0,
      raw_discount: p.raw_discount || 0, historical_sold: p.historical_sold || 0,
      sold: p.sold || 0, liked_count: p.liked_count || 0, stock: p.stock || 0,
      rating_star: p.item_rating?.rating_star || 0,
      rating_count: p.item_rating?.rating_count?.reduce((a,b)=>a+b,0) || 0,
      brand: p.brand || '', catid: p.catid || 0, image: p.image || '', ctime: p.ctime || 0,
      scraped_date: today, scraped_at: new Date().toISOString()
    }));
    for (let i = 0; i < rows.length; i += 50) {
      await fetch(`${V}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'products?on_conflict=shopid,itemid,scraped_date', data: rows.slice(i, i + 50) })
      });
    }
  }

  // Phase 2: enrich active sellers
  window._SS_single.phase = 'enrich';
  rdSend();
  await sleep(2000);

  let active = [];
  try {
    const ar = await fetch(`${V}/api/data?type=active-sellers&shopid=${sid}`).then(r => r.json());
    active = ar.active || [];
  } catch(e) {}

  const buf = [];
  let vars = 0;
  for (let i = 0; i < active.length; i++) {
    const p = active[i];
    await sleep(3500);
    try {
      const d = await fetch(
        `https://shopee.com.my/api/v4/item/get?itemid=${p.itemid}&shopid=${sid}`,
        { credentials: 'include', headers: { 'x-api-source': 'pc', 'x-shopee-language': 'en', 'Accept': 'application/json' } }
      ).then(r => r.json());
      if (!d.data) continue;
      const item = d.data;
      const vt = (item.tier_variations || []).map(v => v.name).join(' / ') || 'single';
      if (item.models?.length > 0) {
        item.models.forEach(m => buf.push({
          shopid: sid, itemid: p.itemid, model_id: m.modelid || 0,
          username: u, product_name: p.name, variant_name: m.name || 'Default',
          variant_sku: m.model_sku || '', variation_type: vt,
          price: (m.price || 0) / 100000, stock: m.stock || 0, sold: m.sold || 0,
          scraped_date: today, scraped_at: new Date().toISOString()
        }));
      } else {
        buf.push({
          shopid: sid, itemid: p.itemid, model_id: 0,
          username: u, product_name: p.name, variant_name: 'Default',
          variant_sku: '', variation_type: 'single',
          price: (p.price_min || 0) / 100000,
          stock: item.stock_info?.summary_info?.total_available_stock ?? p.stock ?? 0,
          sold: item.sold || 0,
          scraped_date: today, scraped_at: new Date().toISOString()
        });
      }
      if (buf.length >= 60) {
        const sv = await fetch(`${V}/api/save-variants`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variants: buf.splice(0, 60) })
        }).then(r => r.json()).catch(() => ({ saved: 0 }));
        vars += sv.saved || 0;
        window._SS_single.variants = vars;
        rdSend();
      }
    } catch(e) { window._SS_single.errors++; }
  }

  if (buf.length) {
    const sv = await fetch(`${V}/api/save-variants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variants: buf })
    }).then(r => r.json()).catch(() => ({ saved: 0 }));
    vars += sv.saved || 0;
  }

  window._SS_single.variants = vars;
  window._SS_single.running = false;
  console.log('[SS] done:', u, 'products:', prods.length, 'variants:', vars);

  window.postMessage({ type: 'SHOP_SCRAPE_DONE', username: u, products: prods.length, variants: vars }, '*');
})();
