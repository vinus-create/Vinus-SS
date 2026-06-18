const VERCEL = 'https://vinus-ss.vercel.app';
const SHOPS_ALL = [
  'buddysnack','winstartech','1stopbatteries','icare4allshop','energizerbatteryhub',
  'gadgetspecialist','gou.ori','tenbucksfood','dsconcept_store',
  'sxmixempire','r_in_g','nextgenhardware.os','ham_radios.my'
];

let currentRD    = null;
let shopeeTabId  = null;
let scrapingShop = null;

function showErr(msg) {
  const el = document.getElementById('inlineErr');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(showErr._t);
  showErr._t = setTimeout(() => { el.style.display = 'none'; }, 6000);
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Wire up static buttons
  document.getElementById('tabRun')       .addEventListener('click', () => switchTab('run'));
  document.getElementById('tabShops')     .addEventListener('click', () => switchTab('shops'));
  document.getElementById('btnRun')       .addEventListener('click', runDaily);
  document.getElementById('btnStop')      .addEventListener('click', stopDaily);
  document.getElementById('btnDashboard') .addEventListener('click', () => { chrome.tabs.create({ url: VERCEL }); window.close(); });
  document.getElementById('btnAdd')       .addEventListener('click', addAndScrape);
  document.getElementById('btnOpenShopee').addEventListener('click', () => { chrome.tabs.create({ url: 'https://shopee.com.my' }); window.close(); });
  document.getElementById('addShopInput') .addEventListener('keydown', e => { if (e.key === 'Enter') addAndScrape(); });

  // Auto-solve CAPTCHA toggle (persisted; default ON)
  const _chk = document.getElementById('autoSolveChk');
  if (_chk) {
    chrome.storage.local.get('autoSolve').then(({ autoSolve }) => { _chk.checked = autoSolve !== false; }).catch(() => {});
    _chk.addEventListener('change', () => chrome.storage.local.set({ autoSolve: _chk.checked }));
  }

  // Event delegation for dynamically generated shop cards
  document.getElementById('shopCards').addEventListener('click', e => {
    const scrapeBtn = e.target.closest('[data-scrape]');
    const viewBtn   = e.target.closest('[data-view]');
    if (scrapeBtn) scrapeShopNow(scrapeBtn.dataset.scrape, parseInt(scrapeBtn.dataset.shopid));
    if (viewBtn)   chrome.tabs.create({ url: `https://shopee.com.my/${viewBtn.dataset.view}` });
  });

  // Find any open Shopee tab (not just the currently active one)
  const shopeeTabs = await chrome.tabs.query({ url: 'https://shopee.com.my/*' });
  shopeeTabId = shopeeTabs[0]?.id || null;

  document.getElementById('notShopee').style.display = shopeeTabId ? 'none'  : 'block';
  document.getElementById('mainUI')   .style.display = shopeeTabId ? 'block' : 'none';
  if (!shopeeTabId) return;

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
  if (msg.type === 'SS_SINGLE_UPDATE') { onSingleUpdate(msg.data); }
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

  const _tot = rd.shopTotal || rd.shopList?.length || 13;
  document.getElementById('shopName').textContent =
    rd.running ? (rd.shop || '初始化...') :
    (rd.shops?.length >= _tot ? '✅ 今日完成' :
    (rd.shops?.length > 0    ? `已完成 ${rd.shops.length}/${_tot}` : '待机'));

  const total = rd.shopTotal || rd.shopList?.length || 13;
  document.getElementById('shopCounter').textContent = `${rd.shopIdx||0} / ${total}`;

  const pct = _tot > 0 ? Math.round((rd.shopIdx / _tot) * 100) : 0;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('statProducts').textContent = rd.products || 0;
  document.getElementById('statVariants').textContent = rd.variants || 0;
  document.getElementById('statErrors')  .textContent = rd.errors   || 0;

  const phaseTag = document.getElementById('phaseTag');
  if (rd.running && rd.phase) {
    phaseTag.style.display = 'inline-block';
    if (rd.phase === 'search') {
      phaseTag.textContent = `🔍 搜索产品 (第${rd.searchPage||1}页)`;
      phaseTag.style.background = '#fff7ed'; phaseTag.style.color = '#c2410c';
    } else if (rd.phase?.startsWith('rest:')) {
      const secs = parseInt(rd.phase.split(':')[1]) || 0;
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      phaseTag.textContent = `⏸ 休息 ${mm}:${ss}`;
      phaseTag.style.background = '#f0fdf4'; phaseTag.style.color = '#166534';
    } else {
      phaseTag.textContent = `⚡ Enrich ${rd.itemI||0}/${rd.itemN||0}`;
      phaseTag.style.background = '#fff7ed'; phaseTag.style.color = '#c2410c';
    }
  } else {
    phaseTag.style.display = 'none';
  }

  if (rd.shops?.length > 0) renderRunShops(rd.shops, rd.shop, rd.running);

  const btn  = document.getElementById('btnRun');
  const stop = document.getElementById('btnStop');
  btn.disabled    = !!rd.running;
  btn.textContent = rd.running ? '运行中...' : '▶ 全量运行';
  stop.style.display = rd.running ? 'block' : 'none';
}

function renderRunShops(doneShops, currentShop, running) {
  const doneMap = {};
  doneShops.forEach(s => { doneMap[s.shop] = s; });

  const shopList = rd.shopList?.length ? rd.shopList : SHOPS_ALL;
  document.getElementById('shopsList').innerHTML = shopList.map(u => {
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
    const today = new Date().toLocaleDateString('en-CA');
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
    const today = new Date().toLocaleDateString('en-CA');
    const [statsArr, logArr] = await Promise.all([
      fetch(`${VERCEL}/api/data?type=shops`).then(r => r.json()).catch(() => []),
      fetch(`${VERCEL}/api/data?type=log`)  .then(r => r.json()).catch(() => [])
    ]);

    const scrapedToday = new Set(
      (Array.isArray(logArr) ? logArr : [])
        .filter(l => l.status === 'success' && l.scraped_at?.startsWith(today))
        .map(l => l.username)
    );

    const shops = (Array.isArray(statsArr) ? statsArr : []).filter(s => s.username && s.shopid);
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
        <div class="scraping-progress" id="prog-${u}" style="display:none">
          <div class="scraping-prog-bar"><div class="scraping-prog-fill" id="progfill-${u}"></div></div>
          <div class="scraping-prog-label" id="proglabel-${u}">🔄 搜索中...</div>
        </div>
      </div>`;
    }).join('');

  } catch(e) {
    container.innerHTML = `<div class="idle-msg" style="grid-column:1/-1;color:#ef4444">加载失败: ${e.message}</div>`;
  }
}

async function scrapeShopNow(username, shopid) {
  if (!shopeeTabId)      { showErr('请先打开 shopee.com.my！'); return; }
  if (currentRD?.running){ showErr('全量运行中，请等待完成后再单独采集'); return; }
  if (scrapingShop)      { return; } // silently ignore — card already shows progress
  const tabInfo2 = await chrome.tabs.get(shopeeTabId).catch(() => null);
  const tabUrl2  = tabInfo2?.url || '';
  if (tabUrl2.includes('tracking_id') || tabUrl2.includes('is_logged_in=') || !tabUrl2.startsWith('https://shopee.com.my')) {
    showErr('⚠️ Shopee 页面异常（账号被封或重定向）请换账号重新打开 shopee.com.my 后再采集');
    return;
  }

  scrapingShop = username;
  const btn  = document.querySelector(`[data-scrape="${username}"]`);
  const prog = document.getElementById(`prog-${username}`);
  if (btn)  { btn.disabled = true; btn.textContent = '采集中...'; }
  if (prog) { prog.style.display = 'block'; }

  try {
    // scrape-single runs in ISOLATED world — avoids Shopee's fetch interceptor causing page redirects
    // Pass params via DOM attribute (shared between worlds)
    await chrome.scripting.executeScript({
      target: { tabId: shopeeTabId },
      world:  'MAIN',
      func: (u, sid, vercel) => {
        document.documentElement.setAttribute('data-ss-u', u);
        document.documentElement.setAttribute('data-ss-sid', sid);
        document.documentElement.setAttribute('data-ss-v', vercel);
      },
      args: [username, shopid, VERCEL]
    });
    await chrome.scripting.executeScript({
      target: { tabId: shopeeTabId },
      files: ['scrape-single.js']  // default: ISOLATED world
    });
  } catch(e) {
    scrapingShop = null;
    if (btn)  { btn.disabled = false; btn.textContent = '↻ Scrape Now'; }
    if (prog) { prog.style.display = 'none'; }
    console.error('Inject error:', e);
  }
}

function onShopScrapeDone(username) {
  scrapingShop = null;
  const btn  = document.querySelector(`[data-scrape="${username}"]`);
  const prog = document.getElementById(`prog-${username}`);
  if (btn)  { btn.disabled = false; btn.textContent = '✓ 已采集'; btn.style.background = '#10b981'; }
  if (prog) { prog.style.display = 'none'; }
  // 重新加载卡片列表，让新店也显示真实 stats（scrape 完成后数据库已有数据）
  setTimeout(() => loadShopCards(), 1500);
}

function onSingleUpdate(d) {
  if (!d?.shop) return;
  const prog  = document.getElementById(`prog-${d.shop}`);
  const fill  = document.getElementById(`progfill-${d.shop}`);
  const label = document.getElementById(`proglabel-${d.shop}`);
  if (!prog) return;
  prog.style.display = 'block';
  const pct = d.phase === 'enrich'
    ? Math.min(100, 50 + Math.round((d.variants / Math.max(d.products, 1)) * 50))
    : Math.min(50, (d.products > 0 ? 40 : 10));
  if (fill)  fill.style.width = pct + '%';
  if (label) label.textContent = d.phase === 'enrich'
    ? `⚡ Enrich | ${d.products}p ${d.variants}v`
    : `🔍 搜索中 | ${d.products}p`;
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
    setStatus(`✅ ${d.name} — ${d.item_count} products，注册中...`, 'ok');
    input.value = '';

    // 立即写入 shops 表，这样 loadShopCards 就能显示它（即使还没有产品）
    await fetch(`${VERCEL}/api/save`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ type: 'shops?on_conflict=username', data: [{ username: val, shopid: d.shopid, name: d.name, item_count: d.item_count || 0 }] })
    }).catch(() => {});

    // 重新加载卡片列表（shops 表已有记录，新店会出现）
    await loadShopCards();

    setStatus(`✅ ${d.name} — ${d.item_count} products，开始采集...`, 'ok');

    // 如果有其他 scrape 在跑，给出提示而不是静默忽略
    if (scrapingShop) {
      setStatus(`⚠️ 正在采集 ${scrapingShop}，请等待完成后再单独采集 ${val}`, 'err');
      return;
    }

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

  // Check tab URL is a normal Shopee page (not error/redirect/banned)
  const tabInfo = await chrome.tabs.get(shopeeTabId).catch(() => null);
  const tabUrl = tabInfo?.url || '';
  if (tabUrl.includes('tracking_id') || tabUrl.includes('is_logged_in=') || !tabUrl.startsWith('https://shopee.com.my')) {
    showErr('⚠️ Shopee 页面异常（账号被封或重定向）请关闭 tab，换账号重新打开 shopee.com.my 后再运行');
    return;
  }

  // Check if content script is new version (has _SS_content_ready flag)
  const check = await chrome.scripting.executeScript({
    target: { tabId: shopeeTabId },
    func: () => window._SS_content_ready === true
  }).catch(() => [{ result: false }]);
  if (!check?.[0]?.result) {
    showErr('请先按 F5 刷新 Shopee 标签页，再点运行！（扩展更新后需刷新一次）');
    return;
  }

  const btn = document.getElementById('btnRun');
  btn.disabled    = true;
  btn.textContent = '注入中...';

  try {
    // Clear any stuck previous run first (must run in MAIN world to reach main-world intervals)
    await chrome.scripting.executeScript({
      target: { tabId: shopeeTabId },
      world:  'MAIN',
      func: () => {
        if (window._rdRelay)   { clearInterval(window._rdRelay);   window._rdRelay = null; }
        if (window._rdWatcher) { clearInterval(window._rdWatcher); window._rdWatcher = null; }
        window._RD = null;
      }
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: shopeeTabId },
      world:  'MAIN',
      files:  ['run-daily.js']
    });
    // Check if script threw on injection
    if (results?.[0]?.error) throw new Error(results[0].error.message || 'Injection failed');
    btn.textContent = '运行中...';
  } catch(e) {
    btn.disabled    = false;
    btn.textContent = '▶ 全量运行';
    console.error('runDaily inject error:', e);
    showErr(`注入失败: ${e.message}`);
  }
}

// ── Stop daily run ────────────────────────────────────────────
async function stopDaily() {
  if (!shopeeTabId) return;
  await chrome.scripting.executeScript({
    target: { tabId: shopeeTabId },
    world:  'MAIN',
    func: () => {
      if (window._rdRelay)   { clearInterval(window._rdRelay);   window._rdRelay = null; }
      if (window._rdWatcher) { clearInterval(window._rdWatcher); window._rdWatcher = null; }
      if (window._RD) window._RD.running = false;
      document.title = '⏹ RD stopped';
    }
  }).catch(() => {});
  document.getElementById('btnRun').disabled    = false;
  document.getElementById('btnRun').textContent = '▶ 全量运行';
  document.getElementById('btnStop').style.display = 'none';
}

// ── CAPTCHA banner ────────────────────────────────────────────
function showCaptcha(show) {
  document.getElementById('captchaAlert').classList.toggle('show', show);
  if (show) document.getElementById('statusDot').className = 'status-dot captcha';
}
