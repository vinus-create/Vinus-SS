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
    // Set params, then inject scrape-single.js (no inline scripts — avoids CSP violations)
    await chrome.scripting.executeScript({
      target: { tabId: shopeeTabId },
      func: (u, sid, vercel) => { window._SS_params = { username: u, shopid: sid, vercel }; },
      args: [username, shopid, VERCEL]
    });
    await chrome.scripting.executeScript({
      target: { tabId: shopeeTabId },
      files: ['scrape-single.js']
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
