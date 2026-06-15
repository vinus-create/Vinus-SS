// ShopeeScope — local slider-CAPTCHA solver (free, no paid service)
// =============================================================================
// Targets Shopee's GeeTest-style slider. Two jobs:
//   1) figure out HOW FAR to drag (gap detection via image processing)
//   2) drag the handle like a human (eased trajectory + jitter + overshoot) —
//      this behavioural realism is what actually passes GeeTest, not just the X.
//
// Honest scope: the static puzzle-slide is reliably solvable; the "crawling"/
// moving-piece variant is best-effort. If no visible widget is found (a headless
// Akamai 403/JSON block), there's nothing to solve — caller backs off.
//
// Selectors below are best-guess for a GeeTest widget; Shopee's exact DOM may
// differ. Run with CAPTCHA_DEBUG=1 to dump the widget HTML + screenshots and
// tune SELECTORS (or set CAPTCHA_SELECTORS as JSON in .env) after the first hit.
//
// Offline test (no live CAPTCHA needed):
//   node lib/captcha.js path/to/background.png [path/to/piece.png]
//   → prints detected gap X and writes *.overlay.png with a line at that X.
// =============================================================================

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DEBUG = process.env.CAPTCHA_DEBUG === '1';
const DEBUG_DIR = path.join(__dirname, '..', 'captcha-debug');
const DRAG_MIN_MS = parseInt(process.env.CAPTCHA_DRAG_MIN_MS || '650', 10);
const DRAG_MAX_MS = parseInt(process.env.CAPTCHA_DRAG_MAX_MS || '1400', 10);

// Candidate selectors (GeeTest defaults + generic). Override via CAPTCHA_SELECTORS (JSON).
let SELECTORS = {
  handle: ['.geetest_slider_button', '.geetest_btn', '.secsdk-captcha-drag-icon',
           '[class*="slider"] [class*="btn"]', '[class*="drag"][class*="btn"]', '[aria-label*="slider" i]'],
  bg:     ['.geetest_canvas_bg', '.geetest_bg', 'canvas.geetest_canvas_bg',
           '[class*="captcha"] canvas', '[class*="puzzle"] canvas', '.captcha-bg', 'canvas'],
  piece:  ['.geetest_canvas_slice', '.geetest_slice', 'canvas.geetest_canvas_slice',
           '[class*="slice"] canvas', '[class*="piece"] canvas', '[class*="puzzle"] img'],
};
try { if (process.env.CAPTCHA_SELECTORS) SELECTORS = { ...SELECTORS, ...JSON.parse(process.env.CAPTCHA_SELECTORS) }; } catch (e) {}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[captcha]', ...a);

// ── image analysis ────────────────────────────────────────────────────────────
const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// Edge-energy gap finder: the gap's vertical border is the column with the most
// contrast. Skip the left strip where the piece sits at rest.
function detectGapX(img, skipLeft = 0) {
  const { width, height, data } = img.bitmap;
  const start = Math.max(skipLeft, Math.floor(width * 0.10));
  let bestX = start, best = -1;
  for (let x = start; x < width - 3; x++) {
    let score = 0;
    for (let y = 2; y < height - 2; y++) {
      const i = (y * width + x) * 4;
      score += Math.abs(lum(data, i) - lum(data, ((y - 1) * width + x) * 4));   // vertical edge
      score += Math.abs(lum(data, i) - lum(data, (y * width + (x - 1)) * 4));   // horizontal edge
    }
    if (score > best) { best = score; bestX = x; }
  }
  return bestX;
}

// Template match: slide the piece's opaque silhouette across the bg and find the X
// with the lowest luminance difference. The slice canvas is often full-width with
// only a small opaque region, so the slide range is bounded by the opaque extent
// (maxPx), NOT the image width. Returns the absolute target column in bg-image px.
function matchPieceX(bg, piece, skipLeft = 0) {
  const B = bg.bitmap, P = piece.bitmap;
  const pts = [];
  let minPx = Infinity, maxPx = 0;
  for (let y = 0; y < P.height; y += 2)
    for (let x = 0; x < P.width; x += 2) {
      const pi = (y * P.width + x) * 4;
      if (P.data[pi + 3] > 60) { pts.push([x, y, lum(P.data, pi)]); if (x < minPx) minPx = x; if (x > maxPx) maxPx = x; }
    }
  if (!pts.length) return detectGapX(bg, skipLeft);
  const maxOff = B.width - maxPx - 1;
  let bestOff = 0, best = Infinity;
  for (let off = Math.max(0, skipLeft - minPx); off < maxOff; off++) {
    let diff = 0;
    for (const [px, py, pl] of pts) {
      diff += Math.abs(lum(B.data, (py * B.width + (px + off)) * 4) - pl);
    }
    if (diff < best) { best = diff; bestOff = off; }
  }
  return minPx + bestOff; // absolute left edge of the matched region
}

async function bufToJimp(buf) { return Jimp.read(buf); }

function ensureDebugDir() { try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch (e) {} }
async function saveOverlay(img, x, file) {
  const o = img.clone();
  const red = Jimp.rgbaToInt(255, 0, 0, 255);
  for (let y = 0; y < o.bitmap.height; y++) { o.setPixelColor(red, x, y); if (x + 1 < o.bitmap.width) o.setPixelColor(red, x + 1, y); }
  await o.writeAsync(file);
}

// ── widget detection (searches the main frame + any iframes) ───────────────────
async function findIn(frame) {
  const pick = async (list) => {
    for (const sel of list) {
      const el = await frame.$(sel).catch(() => null);
      if (el) { const box = await el.boundingBox().catch(() => null); if (box && box.width > 10) return { el, box, sel }; }
    }
    return null;
  };
  const handle = await pick(SELECTORS.handle);
  const bg = await pick(SELECTORS.bg);
  if (!bg) return null;
  const piece = await pick(SELECTORS.piece);
  return { frame, handle, bg, piece };
}

async function detectWidget(page) {
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    const w = await findIn(frame).catch(() => null);
    if (w) return w;
  }
  return null;
}

// Shopee's verify page often shows "Loading Issue — Try Again" with no puzzle.
// Clicking the retry button frequently makes the real slider load. Returns true
// if it clicked something.
async function clickRetry(page) {
  const texts = ['Try Again', 'Try again', 'Refresh', 'Reload', 'Muat semula', '重试', '重新'];
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    for (const t of texts) {
      const loc = frame.getByText(t, { exact: false }).first();
      if (await loc.count().catch(() => 0)) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        log(`clicked "${t}"`);
        return true;
      }
    }
  }
  return false;
}

// ── human-like drag ────────────────────────────────────────────────────────────
async function humanDrag(page, fromX, fromY, dx) {
  const total = DRAG_MIN_MS + Math.random() * (DRAG_MAX_MS - DRAG_MIN_MS);
  const steps = 28 + Math.floor(Math.random() * 22);
  const overshoot = Math.min(18, Math.max(3, dx * 0.07));
  const peak = dx + overshoot;

  await page.mouse.move(fromX, fromY, { steps: 2 });
  await sleep(80 + Math.random() * 140);
  await page.mouse.down();
  await sleep(40 + Math.random() * 80);

  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease-in-out cubic
    const x = fromX + peak * ease;
    const y = fromY + (Math.random() * 4 - 2); // vertical jitter
    await page.mouse.move(x, y, { steps: 1 });
    await sleep((total / steps) * (0.6 + Math.random() * 0.8));
  }
  // settle back from the overshoot to the true target, with a tiny wobble
  await page.mouse.move(fromX + dx + 1, fromY + (Math.random() * 2 - 1), { steps: 3 });
  await sleep(60 + Math.random() * 90);
  await page.mouse.move(fromX + dx, fromY, { steps: 2 });
  await sleep(120 + Math.random() * 200);
  await page.mouse.up();
}

// ── orchestrator ───────────────────────────────────────────────────────────────
async function verifySolved(page) {
  await sleep(1500);
  if (!/\/verify\/|captcha/i.test(page.url())) {
    const still = await detectWidget(page).catch(() => null);
    if (!still) return true;
  }
  const still = await detectWidget(page).catch(() => null);
  return !still;
}

// Returns { solved:boolean, reason?:string, attempts:number }
async function solveCaptcha(page, opts = {}) {
  const attempts = opts.attempts || parseInt(process.env.CAPTCHA_MAX_ATTEMPTS || '3', 10);
  if (DEBUG) ensureDebugDir();

  for (let a = 0; a < attempts; a++) {
    let w = await detectWidget(page).catch(() => null);
    if (!w) {
      // widget may have failed to load ("Loading Issue / Try Again") — nudge it
      if (await clickRetry(page)) { await sleep(2800); w = await detectWidget(page).catch(() => null); }
    }
    if (!w) return a === 0 ? { solved: false, reason: 'no-widget', attempts: a } : { solved: true, attempts: a };

    let bgImg, pieceImg = null;
    try {
      bgImg = await bufToJimp(await w.bg.el.screenshot());
      if (w.piece) pieceImg = await bufToJimp(await w.piece.el.screenshot()).catch(() => null);
    } catch (e) { log('capture failed:', e.message); return { solved: false, reason: 'capture-failed', attempts: a }; }

    const skipLeft = w.piece ? Math.round((w.piece.box.x - w.bg.box.x) + w.piece.box.width) : 0;
    const scale = w.bg.box.width / bgImg.bitmap.width; // CSS px per image px
    const gapImgX = pieceImg ? matchPieceX(bgImg, pieceImg, skipLeft) : detectGapX(bgImg, skipLeft);
    const pieceStartImgX = w.piece ? Math.round((w.piece.box.x - w.bg.box.x) / scale) : 0;
    let dx = Math.round((gapImgX - pieceStartImgX) * scale);
    if (dx < 5) dx = Math.round(gapImgX * scale); // fallback if piece offset unknown

    if (DEBUG) {
      const f = path.join(DEBUG_DIR, `${Date.now()}_a${a}`);
      await saveOverlay(bgImg, gapImgX, `${f}.bg.overlay.png`).catch(() => {});
      if (pieceImg) await pieceImg.writeAsync(`${f}.piece.png`).catch(() => {});
      try { fs.writeFileSync(`${f}.html`, await w.frame.content()); } catch (e) {}
      log(`debug dumped → ${f}.* | gapImgX=${gapImgX} scale=${scale.toFixed(3)} dx=${dx}`);
    }

    if (!w.handle) { log('no drag handle found — cannot drag (tune SELECTORS.handle)'); return { solved: false, reason: 'no-handle', attempts: a }; }
    const hx = w.handle.box.x + w.handle.box.width / 2;
    const hy = w.handle.box.y + w.handle.box.height / 2;
    log(`attempt ${a + 1}/${attempts}: dragging ${dx}px`);
    await humanDrag(page, hx, hy, dx);

    if (await verifySolved(page)) { log('solved ✓'); return { solved: true, attempts: a + 1 }; }
    log('attempt failed, retrying'); await sleep(800 + Math.random() * 1200);
  }
  return { solved: false, reason: 'exhausted', attempts };
}

module.exports = { solveCaptcha, detectWidget, detectGapX, matchPieceX, humanDrag };

// ── CLI: offline detection test on a saved image ───────────────────────────────
if (require.main === module) {
  (async () => {
    const [bgPath, piecePath] = process.argv.slice(2);
    if (!bgPath) { console.error('usage: node lib/captcha.js <background.png> [piece.png]'); process.exit(1); }
    const bg = await Jimp.read(bgPath);
    let x;
    if (piecePath) { const piece = await Jimp.read(piecePath); x = matchPieceX(bg, piece); console.log('template-match gap X =', x); }
    else { x = detectGapX(bg); console.log('edge-energy gap X =', x); }
    const out = bgPath.replace(/\.(png|jpg|jpeg)$/i, '') + '.overlay.png';
    await saveOverlay(bg, x, out);
    console.log('overlay written →', out);
  })();
}
