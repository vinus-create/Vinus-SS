// ShopeeScope — background-side CAPTCHA solver (runs in the service worker).
// Solves Shopee's GeeTest slider with TRUSTED input via chrome.debugger
// (Input.dispatchMouseEvent). In-page JS can't: its events are isTrusted:false and
// GeeTest rejects them. Loaded into background.js via importScripts('captcha-solver.js').
//
// Flow per solve: attach debugger -> screenshot the puzzle bg -> find the gap X ->
// drag the handle there with a human-like trajectory -> detach. The page-side
// (run-daily.js waitForCaptchaClear) detects the clear and resumes; on failure it
// falls back to manual solve (which also auto-continues).

const _ssSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _ssLum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// Edge-energy gap finder (ported from scraper/lib/captcha.js detectGapX).
// ImageData has the same {width,height,data:RGBA} shape as a jimp bitmap.
function ssDetectGapX(img, skipLeft = 0) {
  const { width, height, data } = img;
  const start = Math.max(skipLeft | 0, Math.floor(width * 0.06));
  let bestX = start, best = -1;
  for (let x = start; x < width - 3; x++) {
    let score = 0;
    for (let y = 2; y < height - 2; y++) {
      const i = (y * width + x) * 4;
      score += Math.abs(_ssLum(data, i) - _ssLum(data, ((y - 1) * width + x) * 4)); // vertical edge
      score += Math.abs(_ssLum(data, i) - _ssLum(data, (y * width + (x - 1)) * 4)); // horizontal edge
    }
    if (score > best) { best = score; bestX = x; }
  }
  return bestX;
}

async function _ssDispatch(tabId, params) {
  return chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params);
}

// Human-like trusted drag of the handle by dx CSS px (ease-in-out + jitter + overshoot).
async function _ssHumanDrag(tabId, fromX, fromY, dx) {
  const steps = 26 + Math.floor(Math.random() * 18);
  const overshoot = Math.min(16, Math.max(3, dx * 0.07));
  const peak = dx + overshoot;
  const total = 650 + Math.random() * 700;

  await _ssDispatch(tabId, { type: 'mouseMoved', x: fromX, y: fromY });
  await _ssSleep(60 + Math.random() * 120);
  await _ssDispatch(tabId, { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
  await _ssSleep(40 + Math.random() * 80);

  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const x = fromX + peak * ease;
    const y = fromY + (Math.random() * 4 - 2);
    await _ssDispatch(tabId, { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await _ssSleep((total / steps) * (0.6 + Math.random() * 0.8));
  }
  // settle back from the overshoot to the true target
  await _ssDispatch(tabId, { type: 'mouseMoved', x: fromX + dx + 1, y: fromY + (Math.random() * 2 - 1), button: 'left', buttons: 1 });
  await _ssSleep(60 + Math.random() * 90);
  await _ssDispatch(tabId, { type: 'mouseMoved', x: fromX + dx, y: fromY, button: 'left', buttons: 1 });
  await _ssSleep(120 + Math.random() * 180);
  await _ssDispatch(tabId, { type: 'mouseReleased', x: fromX + dx, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
}

async function _ssDecode(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = oc.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

// rects: { bg, handle, slice } each {x,y,width,height} in viewport CSS px.
// Returns { solved:boolean, reason, dx, gapX }.
async function ssSolveSlider(tabId, rects) {
  const { bg, handle, slice } = rects || {};
  if (!bg || !handle || !bg.width || !handle.width) return { solved: false, reason: 'no-rects' };

  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;

    const shot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: bg.x, y: bg.y, width: bg.width, height: bg.height, scale: 1 },
      captureBeyondViewport: false,
    });
    const img = await _ssDecode(shot.data);

    // Screenshot may be at devicePixelRatio (image px != CSS px) — scale everything by bg width.
    const imgPerCss = img.width / bg.width;
    const sliceOffsetCss = slice && slice.width ? (slice.x - bg.x) + slice.width : 0;
    const skipLeftImg = Math.max(0, Math.round(sliceOffsetCss * imgPerCss));

    const gapXimg = ssDetectGapX(img, skipLeftImg);
    const gapXcss = gapXimg / imgPerCss;
    const sliceStartCss = slice && slice.width ? (slice.x - bg.x) : 0;
    let dx = Math.round(gapXcss - sliceStartCss);
    if (dx < 8) dx = Math.round(gapXcss); // fallback if slice offset unknown/odd
    if (dx < 8 || dx > bg.width) return { solved: false, reason: 'bad-dx', dx, gapX: gapXimg };

    const hx = handle.x + handle.width / 2;
    const hy = handle.y + handle.height / 2;
    console.log(`[solver] gapXimg=${gapXimg} imgW=${img.width} bgW=${bg.width} -> dx=${dx}px; drag from (${hx|0},${hy|0})`);
    await _ssHumanDrag(tabId, hx, hy, dx);

    return { solved: true, reason: 'dragged', dx, gapX: gapXimg }; // page-side confirms actual clear
  } catch (e) {
    console.warn('[solver] error:', e && e.message);
    return { solved: false, reason: (e && e.message) || 'error' };
  } finally {
    if (attached) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} }
  }
}
