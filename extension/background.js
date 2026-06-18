// Background service worker — relay messages between content script and popup

let latestRD = null;
let latestCaptcha = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RD_UPDATE') {
    latestRD = msg.data;
    latestCaptcha = false;
    // Update badge
    const tab = sender.tab;
    if (tab) updateBadge(tab.id, msg.data);
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
