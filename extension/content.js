// Content script (isolated world) — relays postMessage from main-world scraper to popup/background
// Version tag lets popup detect stale content scripts on old tabs
window._SS_content_ready = true;

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg?.type) return;
  const relayTypes = ['RD_UPDATE', 'CAPTCHA_DETECTED', 'SHOP_SCRAPE_DONE', 'SS_SINGLE_UPDATE', 'SS_SOLVE_CAPTCHA'];
  if (!relayTypes.includes(msg.type)) return;
  try { chrome.runtime.sendMessage(msg); } catch(e) {}
});
