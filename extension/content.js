// Content script — runs in shopee.com.my, monitors _RD progress

let _lastI = 0, _lastProg = Date.now(), _lastShop = '';

// Poll window._RD every 2 seconds and relay to background/popup
setInterval(() => {
  const rd = window._RD;
  if (!rd) return;

  // Detect CAPTCHA: stuck for 70s or URL contains captcha/verify
  if (rd.running) {
    if (rd.itemI !== _lastI || rd.shop !== _lastShop) {
      _lastI = rd.itemI;
      _lastShop = rd.shop;
      _lastProg = Date.now();
    }
    const stuck = rd.phase === 'enrich' && (Date.now() - _lastProg > 70000);
    const onCaptcha = location.href.includes('captcha') || location.href.includes('verify');
    if (stuck || onCaptcha) {
      chrome.runtime.sendMessage({ type: 'CAPTCHA_DETECTED', shop: rd.shop });
    }
  }

  chrome.runtime.sendMessage({
    type: 'RD_UPDATE',
    data: {
      running:   rd.running,
      shop:      rd.shop,
      shopIdx:   rd.shopIdx   || 0,
      shopTotal: rd.shopTotal || 13,
      phase:     rd.phase     || '',
      itemI:     rd.itemI     || 0,
      itemN:     rd.itemN     || 0,
      products:  rd.products  || 0,
      variants:  rd.variants  || 0,
      errors:    rd.errors    || 0,
      shops:     rd.shops     || []
    }
  });
}, 2000);
