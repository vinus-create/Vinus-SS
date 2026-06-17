# ShopeeScope — Unattended Daily Scraper

Runs the daily Shopee scrape **fully automatically** on your Windows PC (your
residential Malaysian IP — the thing Shopee doesn't block). No manual launching,
no CAPTCHA babysitting.

## How it works

- **`daily.js`** — the scraper. In the default **`cdp` mode** it **attaches to a real
  Chrome** you start with `start-chrome-debug.ps1` (a normal Chrome on a debug port,
  using a dedicated profile so it runs alongside your everyday Chrome). Because that
  Chrome is started *normally* — not by Playwright — Shopee sees genuine browsing and
  doesn't throw the `crawler_item` block a fresh automated browser gets. Each run scrapes
  up to `MAX_SHOPS_PER_RUN` shops that aren't done yet today and exits.
  *(`launch` mode — spawning a fresh Playwright Chrome — exists as a fallback but gets
  flagged by Shopee; use `cdp`.)*
- **Resume** — it asks the dashboard which shops are already done today
  (`/api/data?type=scraped-today`) and skips them. So hourly slots add up to a full
  day's coverage without re-doing work.
- **CAPTCHA = no human needed** — low request rate (sales-sort, long delays, few
  shops/slot) makes CAPTCHA rare. When one *does* appear, the built-in **local slider
  solver** (`lib/captcha.js`) tries to solve it (image gap-detection + human-like
  drag). If it can't (the hard moving-piece variant, or a headless block with no
  widget), it **stops cleanly**, starts a cooldown, pings you, and the next hourly slot
  resumes the leftover shops.
- **Velocity** uses stock drawdown, so each run just needs fresh **stock** for the
  top products per shop — that's the variant-enrichment phase.
- **Alerts** — only pings you on failure or when the Shopee login expires (set a
  webhook in `.env`); otherwise it's silent. Check the dashboard Scrape Log anytime.

## One-time setup

Easiest: **double-click `SETUP-FIRST-TIME.bat`** and follow the prompts. Or manually:

```powershell
# 1. start the scraper Chrome (normal Chrome, debug port, dedicated profile)
powershell -ExecutionPolicy Bypass -File start-chrome-debug.ps1
#    -> log into Shopee ONCE in the window that opens

# 2. test a small run (2 shops) — it attaches to that Chrome
node daily.js --once --max-shops=2

# 3. install the schedule (hourly scrape + auto-start the scraper Chrome at logon)
powershell -ExecutionPolicy Bypass -File install-task.ps1
```

Keep the scraper Chrome window open (minimize it). After step 3 it also relaunches
automatically each time you log into Windows. Force a full sweep now:
`powershell -File run-all.ps1`.

## Configure (`scraper/.env`)

| Key | Default | Meaning |
|---|---|---|
| `SCRAPER_PROFILE_DIR` | `D:\ShopeeScope\chrome-scraper-profile` | dedicated Chrome profile |
| `MAX_SHOPS_PER_RUN` | `4` | shops per hourly slot |
| `ENRICH_TOP_N` | `40` | top products/shop to fetch variant stock for |
| `PRODUCT_SORTS` | `sales` | `sales` is lowest CAPTCHA risk; add `,ctime,price` for more coverage |
| `SCRAPE_REVIEWS_EVERY_N_DAYS` | `0` (off) | reviews every Nth day — see note below before enabling |
| `CAPTCHA_COOLDOWN_MIN` | `30` | pause after a CAPTCHA |
| `ALERT_WEBHOOK_URL` / `TELEGRAM_*` | empty | failure/login alerts (optional) |

**Alerts:** easiest is a Discord channel → *Edit channel → Integrations → Webhooks →
New Webhook → Copy URL* → paste into `ALERT_WEBHOOK_URL`. (Telegram: set
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` instead.)

**Enabling reviews (optional):** the `reviews` table needs a unique index first, or
upserts are skipped. Run once in the Supabase SQL editor, then set
`SCRAPE_REVIEWS_EVERY_N_DAYS` > 0:

```sql
-- remove any exact-duplicate review rows, then enforce uniqueness
DELETE FROM reviews a USING reviews b
  WHERE a.id > b.id AND a.shopid=b.shopid AND a.itemid=b.itemid AND a.ctime=b.ctime;
CREATE UNIQUE INDEX IF NOT EXISTS reviews_shopid_itemid_ctime_key
  ON reviews (shopid, itemid, ctime);
```

## CAPTCHA solver (`lib/captcha.js`)

Free, local, no paid service. Targets Shopee's GeeTest-style **slider**: it screenshots
the puzzle, finds the gap (template-match the slice piece, else edge-energy), and drags
the handle with a human-like eased trajectory + jitter + overshoot (the *behaviour* is
what passes GeeTest, not just the position).

**Honest limits:** the **static slide** is solved reliably; the **moving/"crawling"
piece** variant is best-effort and will sometimes miss → it falls back to wait-and-retry.
A headless Akamai block (a 403/JSON with no visible widget) can't be "solved" — that's
handled by the low request rate + real logged-in Chrome profile, not the solver.

**Tuning / testing**
- Offline (no live CAPTCHA): drop a slider screenshot in `scraper/fixtures/` and run
  `node lib/captcha.js fixtures/bg.png [fixtures/piece.png]` → prints the detected gap X
  and writes a `*.overlay.png` with a line there, so you can eyeball detection accuracy.
- Live test: `node daily.js --solve-now` opens a visible window, surfaces a widget, and
  attempts one solve.
- Set `CAPTCHA_DEBUG=1` to dump the widget HTML + before/after gap-overlay PNGs to
  `scraper/captcha-debug/` for tuning.
- If Shopee's DOM doesn't match the default selectors, the debug HTML dump shows the real
  element classes — set `CAPTCHA_SELECTORS` (JSON) in `.env` to point at them.
- Turn it off entirely with `CAPTCHA_SOLVER=off` (pure back-off + retry).

> Note: automated CAPTCHA solving is against Shopee's ToS; low volume on your own
> logged-in session + residential IP keeps account risk low — you accept that risk.

## Option B: Scrapling stealth scraper (`daily_scrapling.py`)

An alternative engine using **Scrapling's `StealthySession`** (patchright — a
CDP-undetectable stealth Chromium), with a **persistent profile** you log into once.
Stronger anti-fingerprinting than the vanilla CDP attach; same lean scope, resume, and
90309999 back-off. Runs from a separate **Python 3.12 venv** at `D:\ShopeeScope\scraper-venv`.

```powershell
$vpy = "D:\ShopeeScope\scraper-venv\Scripts\python.exe"
& $vpy daily_scrapling.py --login            # log into Shopee once (visible window)
& $vpy daily_scrapling.py --list             # dry: show pending shops (no browser)
& $vpy daily_scrapling.py --once --max-shops=1   # test scrape through the stealth browser
```

Or double-click **`SCRAPLING-SETUP.bat`** (login + 1-shop test). Config in `.env`:
`SCRAPLING_PROFILE_DIR`, `SCRAPLING_HEADLESS` (false = visible, more reliable).

> Reality check: Scrapling is a stealthier *engine*, but it does **not** beat Shopee's
> **IP-level** rate-limit (`90309999`) — that needs a rested IP + a logged-in session,
> same as every approach. Use it if the Chrome/CDP path keeps getting fingerprint-flagged.
> Install notes (Python 3.12 venv, VC++ redist) are in the project memory.

## Troubleshooting: stuck on a "verify / Loading Issue" page

`...scene=crawler_item` + **"Loading Issue → Try Again"** means Shopee flagged the browser
as a bot *before* serving a solvable puzzle. This is exactly why we use **`cdp` mode**
(attach to your real, normally-started Chrome) instead of a Playwright-launched one. If
you still hit it:

1. **Make sure you're in `cdp` mode** (`.env`: `SCRAPER_MODE=cdp`) and that the scraper
   Chrome was started by `start-chrome-debug.ps1` (a normal Chrome) — *not* a Playwright
   window. Confirm with `node daily.js --once --max-shops=2` while that Chrome is open.
2. **Be logged in** in that scraper Chrome and **browse a little** first (open a few
   product pages) so the profile looks lived-in.
3. **Go slower** — lower `MAX_SHOPS_PER_RUN` (e.g. 2) and raise `DELAY_ITEM_MS`.
4. If it's *still* hard-blocked even via your real Chrome, the remaining option is a paid
   Shopee-specialised solver (SadCaptcha). Ask and we can wire it in.

## When it needs you (rare)

Only when the Shopee session in the scraper Chrome expires (you'll get a "not logged in"
or "can't reach Chrome" ping). Fix: make sure the scraper Chrome is running
(`start-chrome-debug.ps1`) and log into Shopee in it again.

## Manage the task

```powershell
Start-ScheduledTask  -TaskName 'ShopeeScope Daily Scraper'      # run now
Get-ScheduledTask    -TaskName 'ShopeeScope Daily Scraper' | Get-ScheduledTaskInfo
Unregister-ScheduledTask -TaskName 'ShopeeScope Daily Scraper' -Confirm:$false
```

Logs: `scrape.log` (this folder). Notes:
- The PC must be **awake** at run time — Task Scheduler can wake it from *sleep*,
  but not from full shutdown/hibernate.
- The task runs in your logged-in Windows session (the Chrome window is minimized).
- `scrape.js` (old per-shop script) is superseded by `daily.js`.
