// Background service worker — relay messages + auto-solve CAPTCHA via chrome.debugger
importScripts('captcha-solver.js');

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
    sendResponse({ rd: latestRD, captcha: latestCaptcha });
  }
  return true;
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
