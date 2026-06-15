# ShopeeScope — Unattended Daily Scraper

Runs the daily Shopee scrape **fully automatically** on your Windows PC (your
residential Malaysian IP — the thing Shopee doesn't block). No manual launching,
no CAPTCHA babysitting.

## How it works

- **`daily.js`** — Playwright scraper. Launches a **dedicated Chrome profile**
  (`SCRAPER_PROFILE_DIR`, *not* your normal Chrome, so nothing collides and your
  browsing is untouched), logs into Shopee once, then on each run scrapes up to
  `MAX_SHOPS_PER_RUN` shops that aren't done yet today and exits.
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

```powershell
# 1. (first time only) make sure Playwright can drive your installed Chrome
npx playwright install chrome

# 2. log into Shopee once in the dedicated profile (opens a real window)
node daily.js --login        # log in, then press ENTER in the terminal

# 3. test a small run (2 shops), confirm it works
node daily.js --once --max-shops=2

# 4. install the hourly scheduled task
powershell -ExecutionPolicy Bypass -File install-task.ps1
```

Then it just runs. To force a full sweep right now: `powershell -File run-all.ps1`.

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

## When it needs you (rare)

Only when the Shopee session expires (you'll get a "not logged in" ping). Fix:

```powershell
node daily.js --login
```

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
