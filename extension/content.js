// Content script (isolated world) — relays postMessage from main-world scraper to popup/background

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg?.type) return;
  const relayTypes = ['RD_UPDATE', 'CAPTCHA_DETECTED', 'SHOP_SCRAPE_DONE', 'SS_SINGLE_UPDATE'];
  if (!relayTypes.includes(msg.type)) return;
  try { chrome.runtime.sendMessage(msg); } catch(e) {}
});
