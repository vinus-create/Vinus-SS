const VERCEL = 'https://vinus-ss.vercel.app';
const SHOPS_ALL = [
  'buddysnack','winstartech','1stopbatteries','icare4allshop','energizerbatteryhub',
  'gadgetspecialist','gou.ori','tenbucksfood','dsconcept_store',
  'sxmixempire','r_in_g','nextgenhardware.os','ham_radios.my'
];

let currentRD    = null;
let shopeeTabId  = null;
let scrapingShop = null;

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Wire up static buttons
  document.getElementById('tabRun')       .addEventListener('click', () => switchTab('run'));
  document.getElementById('tabShops')     .addEventListener('click', () => switchTab('shops'));
  document.getElementById('btnRun')       .addEventListener('click', runDaily);
  document.getElementById('btnDashboard') .addEventListener('click', () => { chrome.tabs.create({ url: VERCEL }); window.close(); });
  document.getElementById('btnAdd')       .addEventListener('click', addAndScrape);
  document.getElementById('btnOpenShopee').addEventListener('click', () => { chrome.tabs.create({ url: 'https://shopee.com.my' }); window.close(); });
  document.getElementById('addShopInput') .addEventListener('keydown', e => { if (e.key === 'Enter') addAndScrape(); });

  // Event delegation for dynamically generated shop cards
  document.getElementById('shopCards').addEventListener('click', e => {
    const scrapeBtn = e.target.closest('[data-scrape]');
    const viewBtn   = e.target.closest('[data-view]');
    if (scrapeBtn) scrapeShopNow(scrapeBtn.dataset.scrape, parseInt(scrapeBtn.dataset.shopid));
    if (viewBtn)   chrome.tabs.create({ url: `https://shopee.com.my/${viewBtn.dataset.view}` });
  });

  // Detect active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onShopee = tab?.url?.includes('shopee.com.my');
  shopeeTabId = onShopee ? tab.id : null;

  document.getElementById('notShopee').style.display = onShopee ? 'none'  : 'block';
  document.getElementById('mainUI')   .style.display = onShopee ? 'block' : 'none';
  if (!onShopee) return;

  // Get live state
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, resp => {
    if (resp?.rd)      updateRunUI(resp.rd);
    if (resp?.captcha) showCaptcha(true);
  });

  loadRunLog();
  loadShopCards();
});

// ── Live messages from content script ────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'RD_UPDATE')        { currentRD = msg.data; updateRunUI(msg.data); }
  if (msg.type === 'CAPTCHA_DETECTED') { showCaptcha(true); }
  if (msg.type === 'SHOP_SCRAPE_DONE') { onShopScrapeDone(msg.username); }
});

// ── Tab switching ─────────────────────────────────────────────
function switchTab(name) {
  ['run', 'shops'].forEach(t => {
    const cap = t.charAt(0).toUpperCase() + t.slice(1);
    document.getElementById('tab'   + cap).classList.toggle('active', t === name);
    document.getElementById('panel' + cap).classList.toggle('active', t === name);
  });
  if (name === 'shops') loadShopCards();
}

// ── RUN TAB ───────────────────────────────────────────────────
function updateRunUI(rd) {
  if (!rd) return;
  showCaptcha(false);

  document.getElementById('statusDot').className =
    'status-dot ' + (rd.running ? 'running' : 'done');

  document.getElementById('shopName').textContent =
    rd.running ? (rd.shop || '初始化...') :
    (rd.shops?.length >= 13 ? '✅ 今日完成' :
    (rd.shops?.length > 0   ? `已完成 ${rd.shops.length}/13` : '待机'));

  document.getElementById('shopCounter').textContent = `${rd.shopIdx||0} / ${rd.shopTotal||13}`;

  const pct = rd.shopTotal > 0 ? Math.round((rd.shopIdx / rd.shopTotal) * 100) : 0;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('statProducts').textContent = rd.products || 0;
  document.getElementById('statVariants').textContent = rd.variants || 0;
  document.getElementById('statErrors')  .textContent = rd.errors   || 0;

  const phaseTag = document.getElementById('phaseTag');
  if (rd.running && rd.phase) {
    phaseTag.style.display = 'inline-block';
    phaseTag.textContent = rd.phase === 'search'
      ? `🔍 搜索产品 (第${rd.searchPage||1}页)`
      : `⚡ Enrich ${rd.itemI||0}/${rd.itemN||0}`;
  } else {
    phaseTag.style.display = 'none';
  }

  if (rd.shops?.length > 0) renderRunShops(rd.shops, rd.shop, rd.running);

  const btn = document.getElementById('btnRun');
  btn.disabled    = !!rd.running;
  btn.textContent = rd.running ? '运行中...' : '▶ 全量运行';
}

function renderRunShops(doneShops, currentShop, running) {
  const doneMap = {};
  doneShops.forEach(s => { doneMap[s.shop] = s; });

  document.getElementById('shopsList').innerHTML = SHOPS_ALL.map(u => {
    const d = doneMap[u];
    const isCurrent = running && u === currentShop;
    const icon  = d ? (d.errors > 0 && !d.variants ? '❌' : '✅') : (isCurrent ? '🔄' : '⏳');
    const stats = d ? `${d.products||0}p ${d.variants||0}v` : (isCurrent ? '处理中...' : '—');
    return `<div class="shop-row">
      <span class="shop-icon">${icon}</span>
      <span class="shop-uname">${u}</span>
      <span class="shop-stats-small ${d ? 'done' : ''}">${stats}</span>
    </div>`;
  }).join('');
}

async function loadRunLog() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const log = await fetch(`${VERCEL}/api/data?type=log`).then(r => r.json());
    if (!Array.isArray(log) || currentRD) return;
    const done   = log.filter(l => l.status === 'success' && l.scraped_at?.startsWith(today));
    const failed = log.filter(l => l.status === 'error'   && l.scraped_at?.startsWith(today));
    if (done.length > 0) {
      updateRunUI({
        running: false, shop: '', shopIdx: done.length, shopTotal: 13, phase: '',
        products: done.reduce((a, l) => a + (l.total_items||0), 0),
        variants: 0, errors: failed.length,
        shops: done.map(l => ({ shop: l.username, products: l.total_items||0, variants: 0, errors: 0 }))
      });
    }
  } catch(e) {}
}

// ── SHOPS TAB ─────────────────────────────────────────────────
async function loadShopCards() {
  const container = document.getElementById('shopCards');
  container.innerHTML = '<div class="idle-msg" style="grid-column:1/-1">加载中...</div>';
  try {
    const today = new Date().toISOString().split('T')[0];
    const [statsArr, logArr] = await Promise.all([
      fetch(`${VERCEL}/api/data?type=shops`).then(r => r.json()).catch(() => []),
      fetch(`${VERCEL}/api/data?type=log`)  .then(r => r.json()).catch(() => [])
    ]);

    const scrapedToday = new Set(
      (Array.isArray(logArr) ? logArr : [])
        .filter(l => l.status === 'success' && l.scraped_at?.startsWith(today))
        .map(l => l.username)
    );

    const shops = Array.isArray(statsArr) ? statsArr : [];
    if (!shops.length) {
      container.innerHTML = '<div class="idle-msg" style="grid-column:1/-1">暂无数据</div>';
      return;
    }

    container.innerHTML = shops.map(shop => {
      const u       = shop.username;
      const scraped = scrapedToday.has(u);
      const products = (shop.total_products || shop.item_count || 0).toLocaleString();
      const sold     = (shop.total_sold || 0).toLocaleString();
      const scrapeStyle = scraped ? 'background:#10b981' : '';
      const scrapeLabel = scraped ? '✓ 已采集' : '↻ Scrape Now';
      return `<div class="shop-card" id="card-${u}">
        <div class="shop-card-name">${u}</div>
        <div class="shop-card-stats">${products} products · <span>${sold}</span> sold</div>
        <div class="shop-card-btns">
          <button class="btn-scrape-now" data-scrape="${u}" data-shopid="${shop.shopid}" style="${scrapeStyle}">${scrapeLabel}</button>
          <button class="btn-view-shop"  data-view="${u}">↗</button>
        </div>
        <div class="scraping-badge" id="badge-${u}">🔄 采集中...</div>
      </div>`;
    }).join('');

  } catch(e) {
    container.innerHTML = `<div class="idle-msg" style="grid-column:1/-1;color:#ef4444">加载失败: ${e.message}</div>`;
  }
}

async function scrapeShopNow(username, shopid) {
  if (!shopeeTabId)      { alert('请先打开 shopee.com.my！'); return; }
  if (currentRD?.running){ alert('全量运行中，请等待完成后再单独采集'); return; }
  if (scrapingShop)      { alert(`正在采集 ${scrapingShop}，请稍候`); return; }

  scrapingShop = username;
  const btn   = document.querySelector(`[data-scrape="${username}"]`);
  const badge = document.getElementById(`badge-${username}`);
  if (btn)   { btn.disabled = true; btn.textContent = '采集中...'; }
  if (badge) { badge.classList.add('show'); }

  try {
    // Inject single-shop scraper inline (avoids CSP issues)
    await chrome.scripting.executeScript({
      target: { tabId: shopeeTabId },
      func: (u, sid, vercel) => {
        if (window._SS_single?.running) return;
        window._SS_single = { running: true, shop: u, products: 0, variants: 0 };

        const el = document.createElement('script');
        el.textContent = `(async()=>{
const V='${vercel}',u='${u}',sid=${sid},today=new Date().toISOString().split('T')[0];
const sleep=ms=>new Promise(r=>setTimeout(r,ms+~~(Math.random()*500)));
const hdr={credentials:'include',headers:{'x-api-source':'pc','x-shopee-language':'en','Accept':'application/json'}};
window._SS_single={running:true,shop:u,phase:'search',products:0,variants:0,errors:0};
console.log('[SS] scraping',u);

// Phase 1: search
const seen=new Set(),map={};
for(const by of['sales','ctime','price']){let off=0;while(true){try{const r=await fetch('https://shopee.com.my/api/v4/search/search_items?by='+by+'&limit=60&match_id='+sid+'&newest='+off+'&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2',hdr);if(!r.ok)break;const d=await r.json();const b=(d.items||[]).map(i=>i.item_basic).filter(Boolean);if(!b.length)break;b.forEach(p=>{if(!seen.has(p.itemid)){seen.add(p.itemid);map[p.itemid]=p;}});if(b.length<60)break;off+=60;}catch(e){break;}await sleep(800);}await sleep(1200);}
const prods=Object.values(map);
if(prods.length){const rows=prods.map(p=>({shopid:sid,itemid:p.itemid,username:u,name:p.name,price_min:p.price_min||0,price_max:p.price_max||p.price_min||0,price_min_before_discount:p.price_min_before_discount||p.price_min||0,raw_discount:p.raw_discount||0,historical_sold:p.historical_sold||0,sold:p.sold||0,liked_count:p.liked_count||0,stock:p.stock||0,rating_star:p.item_rating?.rating_star||0,rating_count:p.item_rating?.rating_count?.reduce((a,b)=>a+b,0)||0,brand:p.brand||'',catid:p.catid||0,image:p.image||'',ctime:p.ctime||0,scraped_date:today,scraped_at:new Date().toISOString()}));for(let i=0;i<rows.length;i+=50){await fetch(V+'/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'products?on_conflict=shopid,itemid,scraped_date',data:rows.slice(i,i+50)})});}}
window._SS_single.products=prods.length;

// Phase 2+3: enrich
window._SS_single.phase='enrich';
await sleep(2000);
const ar=await fetch(V+'/api/data?type=active-sellers&shopid='+sid).then(r=>r.json()).catch(()=>({active:[]}));
const active=ar.active||[];
const buf=[];let vars=0;
for(let i=0;i<active.length;i++){const p=active[i];await sleep(3500);try{const d=await fetch('https://shopee.com.my/api/v4/item/get?itemid='+p.itemid+'&shopid='+sid,hdr).then(r=>r.json());if(!d.data)continue;const item=d.data,vt=(item.tier_variations||[]).map(v=>v.name).join(' / ')||'single';if(item.models?.length>0){item.models.forEach(m=>buf.push({shopid:sid,itemid:p.itemid,model_id:m.modelid||0,username:u,product_name:p.name,variant_name:m.name||'Default',variant_sku:m.model_sku||'',variation_type:vt,price:(m.price||0)/100000,stock:m.stock||0,sold:m.sold||0,scraped_date:today,scraped_at:new Date().toISOString()}));}else{buf.push({shopid:sid,itemid:p.itemid,model_id:0,username:u,product_name:p.name,variant_name:'Default',variant_sku:'',variation_type:'single',price:(p.price_min||0)/100000,stock:item.stock_info?.summary_info?.total_available_stock??p.stock??0,sold:item.sold||0,scraped_date:today,scraped_at:new Date().toISOString()});}if(buf.length>=60){const sv=await fetch(V+'/api/save-variants',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({variants:buf.splice(0,60)})}).then(r=>r.json()).catch(()=>({saved:0}));vars+=sv.saved||0;window._SS_single.variants=vars;}}catch(e){}}
if(buf.length){const sv=await fetch(V+'/api/save-variants',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({variants:buf})}).then(r=>r.json()).catch(()=>({saved:0}));vars+=sv.saved||0;}
window._SS_single.variants=vars;window._SS_single.running=false;
console.log('[SS] done:',u,'products:',prods.length,'variants:',vars);
try{chrome.runtime.sendMessage({type:'SHOP_SCRAPE_DONE',username:u,products:prods.length,variants:vars});}catch(e){}
})();`;
        document.head.appendChild(el);
      },
      args: [username, shopid, VERCEL]
    });
  } catch(e) {
    scrapingShop = null;
    if (btn)   { btn.disabled = false; btn.textContent = '↻ Scrape Now'; }
    if (badge) { badge.classList.remove('show'); }
    console.error('Inject error:', e);
  }
}

function onShopScrapeDone(username) {
  scrapingShop = null;
  const btn   = document.querySelector(`[data-scrape="${username}"]`);
  const badge = document.getElementById(`badge-${username}`);
  if (btn)   { btn.disabled = false; btn.textContent = '✓ 已采集'; btn.style.background = '#10b981'; }
  if (badge) { badge.classList.remove('show'); }
}

async function addAndScrape() {
  const input  = document.getElementById('addShopInput');
  const status = document.getElementById('addStatus');
  let val = input.value.trim()
    .replace(/^https?:\/\/shopee\.com\.my\//, '')
    .replace(/^@/, '').split('/')[0].split('?')[0].trim();
  if (!val) { setStatus('❌ 无效输入', 'err'); return; }

  setStatus(`🔍 查找 ${val}...`, '');
  try {
    const d = await fetch(`${VERCEL}/api/data?type=shop-profile&username=${encodeURIComponent(val)}`).then(r => r.json());
    if (!d.ok || !d.shopid) throw new Error(d.error || 'Shop not found');
    setStatus(`✅ ${d.name} — ${d.item_count} products，开始采集...`, 'ok');
    input.value = '';
    await loadShopCards();
    await scrapeShopNow(val, d.shopid);
  } catch(e) {
    setStatus(`❌ ${e.message}`, 'err');
  }

  function setStatus(txt, cls) {
    status.textContent  = txt;
    status.className    = 'add-status' + (cls ? ' ' + cls : '');
  }
}

// ── Run daily (full) ──────────────────────────────────────────
async function runDaily() {
  if (!shopeeTabId) { chrome.tabs.create({ url: 'https://shopee.com.my' }); window.close(); return; }

  const btn = document.getElementById('btnRun');
  btn.disabled    = true;
  btn.textContent = '注入中...';

  try {
    await chrome.scripting.executeScript({
      target: { tabId: shopeeTabId },
      files:  ['run-daily.js']   // inject bundled file directly — bypasses CSP
    });
    setTimeout(() => { btn.textContent = '运行中...'; }, 1500);
  } catch(e) {
    btn.disabled    = false;
    btn.textContent = '▶ 全量运行';
    console.error('runDaily inject error:', e);
  }
}

// ── CAPTCHA banner ────────────────────────────────────────────
function showCaptcha(show) {
  document.getElementById('captchaAlert').classList.toggle('show', show);
  if (show) document.getElementById('statusDot').className = 'status-dot captcha';
}
