// Background service worker — relay messages + auto-solve CAPTCHA via chrome.debugger
//   + CDP Network-interception scraper (interceptor.js)
importScripts('captcha-solver.js');
importScripts('interceptor.js');

let latestRD = null;
let latestCaptcha = false;

// Per-tab auto-solve state: cap attempts per captcha, one solve at a time
const _solveState = {};
const MAX_SOLVES = 3;

async function handleSolveRequest(tabId, rects) {
  if (!tabId) return;
  const st = _solveState[tabId] || (_solveState[tabId] = { busy: false, attempts: 0 });
  if (st.busy || st.attempts >= MAX_SOLVES) return;
  let autoSolve = true;
  try { autoSolve = (await chrome.storage.local.get('autoSolve')).autoSolve !== false; } catch (e) {}
  if (!autoSolve) return; // user turned it off → leave it for manual solve
  st.busy = true; st.attempts++;
  try {
    console.log(`[solver] attempt ${st.attempts}/${MAX_SOLVES} on tab ${tabId}`);
    const r = await ssSolveSlider(tabId, rects);
    console.log('[solver] result:', JSON.stringify(r));
  } catch (e) { console.warn('[solver] handler error:', e && e.message); }
  finally { st.busy = false; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RD_UPDATE') {
    latestRD = msg.data;
    latestCaptcha = false;
    const tab = sender.tab;
    if (tab) {
      updateBadge(tab.id, msg.data);
      // run resumed (no longer on captcha) → reset the per-captcha solve counter
      if (msg.data && !msg.data.paused && _solveState[tab.id]) _solveState[tab.id].attempts = 0;
    }
  }
  if (msg.type === 'SS_SOLVE_CAPTCHA') {
    if (sender.tab) handleSolveRequest(sender.tab.id, msg.rects);
  }
  if (msg.type === 'SS_RUN_INTERCEPT') {
    // From the popup (no sender.tab) → runIntercept finds the Shopee tab itself.
    // _icReport() posts IC_UPDATE straight to the popup; no relay needed here.
    runIntercept({ maxShops: msg.maxShops || 1, maxEnrich: msg.maxEnrich, all: msg.all, tabId: sender.tab && sender.tab.id })
      .catch((e) => console.warn('[intercept] launch error:', e && e.message));
  }
  if (msg.type === 'SS_STOP_INTERCEPT') { try { icStop(); } catch (e) {} }
  if (msg.type === 'SS_PAUSE_INTERCEPT') { try { icPause(!!msg.paused); } catch (e) {} }
  if (msg.type === 'CAPTCHA_DETECTED') {
    latestCaptcha = true;
    chrome.notifications.create('captcha', {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '⚠️ ShopeeScope — CAPTCHA!',
      message: `${msg.shop || ''} 遇到 CAPTCHA — 解开滑块即可，会自动继续（不用停止/重跑）`
    });
    if (sender.tab) {
      chrome.action.setBadgeText({ text: '⚠', tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: sender.tab.id });
    }
  }
  if (msg.type === 'SHOP_SCRAPE_DONE') {
    // Relay to popup if open
    chrome.runtime.sendMessage(msg).catch(() => {});
    if (sender.tab) {
      chrome.action.setBadgeText({ text: '✓', tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({ color: '#10b981', tabId: sender.tab.id });
    }
  }
  if (msg.type === 'GET_STATE') {
    sendResponse({ rd: latestRD, captcha: latestCaptcha, ic: (typeof _icState !== 'undefined') ? _icState : null });
    return true; // only GET_STATE expects a response — keep the channel open just for it
  }
  // all other messages are fire-and-forget; returning false avoids the
  // "message channel closed before a response was received" spam.
  return false;
});

// ── Weekly scheduled scrape — Wednesday 22:00 local, via chrome.alarms ──────────
// Runs the same full-store pass as the 全店采集 button. Needs Chrome open + a logged-in
// Shopee session at fire time; captchas auto-solve if SadCaptcha is on, else it waits/stops.
const WEEKLY_ALARM = 'ss-weekly-scrape';

function _nextWeekdayAt(weekday, hour) { // weekday: 0=Sun..6=Sat (3=Wed)
  const now = new Date(), d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  let add = (weekday - d.getDay() + 7) % 7;
  if (add === 0 && d <= now) add = 7; // already past today's time → next week
  d.setDate(d.getDate() + add);
  return d.getTime();
}

async function ensureWeeklyAlarm() {
  let on = true;
  try { on = (await chrome.storage.local.get('weeklyScrape')).weeklyScrape !== false; } catch (e) {}
  const existing = await chrome.alarms.get(WEEKLY_ALARM);
  if (!on) { if (existing) await chrome.alarms.clear(WEEKLY_ALARM); return; }
  if (!existing) chrome.alarms.create(WEEKLY_ALARM, { when: _nextWeekdayAt(3, 22), periodInMinutes: 7 * 24 * 60 });
}
chrome.runtime.onInstalled.addListener(ensureWeeklyAlarm);
chrome.runtime.onStartup.addListener(ensureWeeklyAlarm);
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.weeklyScrape) ensureWeeklyAlarm(); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WEEKLY_ALARM) return;
  let on = true;
  try { on = (await chrome.storage.local.get('weeklyScrape')).weeklyScrape !== false; } catch (e) {}
  if (!on) return;
  let tabs = await chrome.tabs.query({ url: 'https://shopee.com.my/*' });
  let tabId = tabs[0] && tabs[0].id;
  if (!tabId) { const t = await chrome.tabs.create({ url: 'https://shopee.com.my', active: false }); tabId = t.id; await new Promise((r) => setTimeout(r, 9000)); }
  let perShop = 120;
  try { perShop = +(await chrome.storage.local.get('ss_perShop')).ss_perShop || 120; } catch (e) {}
  chrome.notifications.create('weekly', { type: 'basic', iconUrl: 'icons/icon48.png',
    title: '🗓 ShopeeScope 每周采集', message: '已开始每周全店采集（约 1–2 小时）— 遇验证码会自动/手动解' });
  runIntercept({ maxShops: 99, maxEnrich: perShop, all: true, tabId }).catch((e) => console.warn('[weekly] error:', e && e.message));
});

function updateBadge(tabId, rd) {
  if (!rd) return;
  if (!rd.running) {
    chrome.action.setBadgeText({ text: '✓', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981', tabId });
  } else {
    const pct = rd.shopTotal > 0 ? Math.round((rd.shopIdx / rd.shopTotal) * 100) : 0;
    chrome.action.setBadgeText({ text: pct + '%', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#f97316', tabId });
  }
}
