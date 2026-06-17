#!/usr/bin/env python
# ShopeeScope - Scrapling (patchright stealth Chromium) scraper, option (b).
# =============================================================================
# Mirror of daily.js but driven by Scrapling's StealthySession (patchright), which
# is CDP-undetectable and uses a PERSISTENT profile you log into once. Same lean
# scope (products + top-N variant stock), resume, and 90309999 back-off.
#
# Run with the dedicated venv's python:
#   D:\ShopeeScope\scraper-venv\Scripts\python.exe daily_scrapling.py --login
#   D:\ShopeeScope\scraper-venv\Scripts\python.exe daily_scrapling.py --list
#   D:\ShopeeScope\scraper-venv\Scripts\python.exe daily_scrapling.py --once --max-shops=2
# =============================================================================
import json
import os
import re
import sys
import time
import datetime
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env():
    p = os.path.join(HERE, ".env")
    if not os.path.exists(p):
        return
    for line in open(p, encoding="utf-8"):
        m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not m:
            continue
        val = re.sub(r"(^|\s)#.*$", "", m.group(2)).strip().strip("\"'")
        os.environ.setdefault(m.group(1), val)


load_env()

ARGS = sys.argv[1:]
def flag(n): return f"--{n}" in ARGS
def opt(n, d):
    for a in ARGS:
        if a.startswith(f"--{n}="):
            return a.split("=", 1)[1]
    return d

VERCEL = os.environ.get("VERCEL_URL", "https://vinus-ss.vercel.app")
PROFILE = os.environ.get("SCRAPLING_PROFILE_DIR", r"D:\ShopeeScope\scrapling-profile")
MAX_SHOPS = int(opt("max-shops", os.environ.get("MAX_SHOPS_PER_RUN", "4")))
ENRICH_TOP = int(os.environ.get("ENRICH_TOP_N", "40"))
SORTS = [s.strip() for s in os.environ.get("PRODUCT_SORTS", "sales").split(",") if s.strip()]
DELAY_PAGE = int(os.environ.get("DELAY_PAGE_MS", "2500"))
DELAY_ITEM = int(os.environ.get("DELAY_ITEM_MS", "4000"))
HEADLESS = os.environ.get("SCRAPLING_HEADLESS", "false").lower() == "true"
TODAY = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ── backend (Vercel API) via stdlib urllib ────────────────────────────────────
def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


def post_json(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(VERCEL + path, data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def save_products(shop, products):
    rows = [{
        "shopid": shop["shopid"], "itemid": p["itemid"], "username": shop["username"],
        "name": p.get("name", ""), "price_min": p.get("price_min", 0) or 0,
        "price_max": p.get("price_max") or p.get("price_min", 0) or 0,
        "price_min_before_discount": p.get("price_min_before_discount") or p.get("price_min", 0) or 0,
        "raw_discount": p.get("raw_discount", 0) or 0,
        "historical_sold": p.get("historical_sold", 0) or 0, "sold": p.get("sold", 0) or 0,
        "liked_count": p.get("liked_count", 0) or 0, "stock": p.get("stock", 0) or 0,
        "rating_star": (p.get("item_rating") or {}).get("rating_star", 0) or 0,
        "rating_count": sum((p.get("item_rating") or {}).get("rating_count", []) or []),
        "brand": p.get("brand", "") or "", "catid": p.get("catid", 0) or 0,
        "image": p.get("image", "") or "", "ctime": p.get("ctime", 0) or 0,
        "scraped_date": TODAY, "scraped_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    } for p in products]
    post_json("/api/save", {"type": "shops?on_conflict=username",
                            "data": [{"username": shop["username"], "shopid": shop["shopid"]}]})
    post_json("/api/save", {"type": "products?on_conflict=shopid,itemid,scraped_date", "data": rows})
    snaps = [{
        "shopid": p["shopid"], "itemid": p["itemid"], "model_id": 0, "username": p["username"],
        "product_name": p["name"], "variant_name": "Default", "variant_sku": "", "variation_type": "product",
        "price": (p["price_min"] or 0) / 100000, "stock": p["stock"] or 0, "sold": p["historical_sold"] or 0,
        "scraped_date": TODAY, "scraped_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    } for p in rows]
    post_json("/api/save", {"type": "snapshots?on_conflict=shopid,itemid,model_id,scraped_date", "data": snaps})
    return len(rows)


def log_shop(shop, total, status, ms, err=None):
    row = {"username": shop["username"], "shopid": shop["shopid"], "total_items": total,
           "status": status, "duration_ms": ms}
    if err:
        row["error_msg"] = str(err)[:200]
    try:
        post_json("/api/save", {"type": "scrape_log", "data": [row]})
    except Exception:
        pass


# ── in-page Shopee fetchers (same logic as daily.js, run via page.evaluate) ────
SEARCH_JS = r"""
async ({shopid, sorts, delayMs}) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random()*700)));
  const blocked = () => location.href.includes('captcha') || location.href.includes('/verify');
  const seen = new Set(), map = {}; let status = 'ok';
  for (const by of sorts) {
    let off = 0, rl = 0;
    while (true) {
      if (blocked()) { status = 'captcha'; break; }
      let r;
      try { r = await fetch(`/api/v4/search/search_items?by=${by}&limit=60&match_id=${shopid}&newest=${off}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`,
        { credentials:'include', headers:{'x-api-source':'pc','x-shopee-language':'en','Accept':'application/json','Referer':`https://shopee.com.my/shop/${shopid}/search`} }); }
      catch(e){ status='neterr'; break; }
      if (r.status===403||r.status===429){ if(++rl>=2){status='ratelimit';break;} await sleep(90000); continue; }
      let j; try{ j=await r.json(); }catch(e){ status='captcha'; break; }
      if (j.error && j.error!==0){ if(j.error===90309999){ if(++rl>=3){status='ratelimit';break;} await sleep(60000); continue; } status='apierr'; break; }
      const batch=(j.items||[]).map(i=>i.item_basic).filter(Boolean);
      if(!batch.length) break;
      let added=0; batch.forEach(p=>{ if(!seen.has(p.itemid)){seen.add(p.itemid);map[p.itemid]=p;added++;} });
      if(batch.length<60||added===0) break;
      off+=60; await sleep(delayMs);
    }
    if(status!=='ok') break; await sleep(1500);
  }
  return {status, products:Object.values(map)};
}
"""

ITEM_JS = r"""
async ({shopid, username, items, delayMs, today}) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random()*900)));
  const blocked = () => location.href.includes('captcha') || location.href.includes('/verify');
  const out = []; let status = 'ok';
  for (const p of items) {
    if (blocked()) { status='captcha'; break; }
    await sleep(delayMs);
    let r;
    try { r = await fetch(`/api/v4/item/get?itemid=${p.itemid}&shopid=${shopid}`,
      { credentials:'include', headers:{'x-api-source':'pc','x-shopee-language':'en','Accept':'application/json','Referer':`https://shopee.com.my/product/${shopid}/${p.itemid}`} }); }
    catch(e){ status='neterr'; break; }
    if (r.status===403||r.status===429){ status='ratelimit'; break; }
    let j; try{ j=await r.json(); }catch(e){ status='captcha'; break; }
    if (j.error===90309999){ status='ratelimit'; break; }
    if (j.error && j.error!==0) continue;
    const it=j.data; if(!it) continue;
    const vt=(it.tier_variations||[]).map(v=>v.name).join(' / ')||'single';
    if (it.models && it.models.length){
      it.models.forEach(m=>out.push({shopid, itemid:p.itemid, model_id:m.modelid||0, username, product_name:p.name,
        variant_name:m.name||'Default', variant_sku:m.model_sku||'', variation_type:vt,
        price:(m.price||0)/100000, stock:m.stock||0, sold:m.sold||0, scraped_date:today, scraped_at:new Date().toISOString()}));
    } else {
      out.push({shopid, itemid:p.itemid, model_id:0, username, product_name:p.name, variant_name:'Default',
        variant_sku:'', variation_type:'single', price:(p.price_min||0)/100000,
        stock:(it.stock_info&&it.stock_info.summary_info&&it.stock_info.summary_info.total_available_stock)||p.stock||0,
        sold:it.sold||0, scraped_date:today, scraped_at:new Date().toISOString()});
    }
  }
  return {status, variants:out};
}
"""


def is_blocked(url):
    url = url or ""
    return "/verify/" in url or "captcha" in url or "/login" in url


# ── modes ─────────────────────────────────────────────────────────────────────
def run_login():
    from scrapling.fetchers import StealthySession
    log(f"Login mode - opening Shopee in a stealth window (profile: {PROFILE})")

    def login_action(page):
        print("\n  -> Log into Shopee in the window, then press ENTER here to save the session.\n", flush=True)
        input()
    with StealthySession(headless=False, user_data_dir=PROFILE, disable_resources=False, timeout=180000) as s:
        s.fetch("https://shopee.com.my/buyer/login", page_action=login_action, timeout=180000)
    log("Session saved to the profile. You can run scrapes now.")


def run_list():
    shops = get_json(f"{VERCEL}/api/data?type=shops")
    shops = [s for s in shops if s.get("username") and s.get("shopid")]
    done = set(get_json(f"{VERCEL}/api/data?type=scraped-today").get("shops", []))
    pending = [s["username"] for s in shops if s["username"] not in done]
    log(f"{len(shops)} shops, {len(done)} done today, {len(pending)} pending")
    log("pending:", ", ".join(pending[:MAX_SHOPS]), "...")


def run_scrape():
    from scrapling.fetchers import StealthySession
    shops = get_json(f"{VERCEL}/api/data?type=shops")
    shops = [{"username": s["username"], "shopid": s["shopid"]} for s in shops if s.get("username") and s.get("shopid")]
    forced = opt("shop", None)
    if forced:
        batch = [s for s in shops if s["username"] == forced][:1]
    else:
        done = set(get_json(f"{VERCEL}/api/data?type=scraped-today").get("shops", []))
        batch = [s for s in shops if s["username"] not in done][:MAX_SHOPS]
    if not batch:
        log("nothing pending today"); return 0
    log(f"{TODAY} - scraping {len(batch)} shop(s) via Scrapling (headless={HEADLESS}, sorts={'+'.join(SORTS)})")

    captcha_hit = False
    with StealthySession(headless=HEADLESS, user_data_dir=PROFILE, disable_resources=True,
                         network_idle=False, timeout=90000, google_search=False) as s:
        # startup check
        home = {}
        s.fetch("https://shopee.com.my/", page_action=lambda p: home.update(url=p.url), timeout=60000)
        if is_blocked(home.get("url", "")):
            log("blocked at startup:", home.get("url"))
            if "/login" in home.get("url", ""):
                log("NOT LOGGED IN - run: daily_scrapling.py --login")
            return 2

        for shop in batch:
            started = int(time.time() * 1000)
            log(f"\n[shop] {shop['username']} ({shop['shopid']})")
            box = {}

            def prod_action(page, box=box, shop=shop):
                box["url"] = page.url
                if is_blocked(page.url):
                    box["pr"] = {"status": "captcha", "products": []}
                    return
                box["pr"] = page.evaluate(SEARCH_JS, {"shopid": shop["shopid"], "sorts": SORTS, "delayMs": DELAY_PAGE})
            s.fetch(f"https://shopee.com.my/shop/{shop['shopid']}", page_action=prod_action, timeout=120000)
            pr = box.get("pr", {"status": "noaction", "products": []})
            if pr["status"] != "ok" or not pr["products"]:
                log(f"  products: {pr['status']} ({len(pr['products'])}) - stopping, resume next slot")
                log_shop(shop, 0, "error", int(time.time() * 1000) - started, f"products:{pr['status']}")
                if pr["status"] in ("captcha", "ratelimit"):
                    captcha_hit = True
                break
            save_products(shop, pr["products"])
            log(f"  products: {len(pr['products'])} saved")
            log_shop(shop, len(pr["products"]), "success", int(time.time() * 1000) - started)

            top = sorted(pr["products"], key=lambda p: p.get("historical_sold", 0) or 0, reverse=True)[:ENRICH_TOP]
            items = [{"itemid": p["itemid"], "name": p.get("name", ""), "price_min": p.get("price_min", 0) or 0} for p in top]
            vbox = {}

            def var_action(page, vbox=vbox, shop=shop, items=items):
                if is_blocked(page.url):
                    vbox["vr"] = {"status": "captcha", "variants": []}
                    return
                vbox["vr"] = page.evaluate(ITEM_JS, {"shopid": shop["shopid"], "username": shop["username"],
                                                      "items": items, "delayMs": DELAY_ITEM, "today": TODAY})
            s.fetch(f"https://shopee.com.my/shop/{shop['shopid']}", page_action=var_action, timeout=400000)
            vr = vbox.get("vr", {"status": "noaction", "variants": []})
            if vr["variants"]:
                post_json("/api/save-variants", {"variants": vr["variants"]})
            log(f"  variants: {len(vr['variants'])} saved ({vr['status']})")
            if vr["status"] in ("captcha", "ratelimit"):
                captcha_hit = True
                break

    log("\nrun done" + (" (hit captcha/limit - will resume next slot)" if captcha_hit else ""))
    return 0


if __name__ == "__main__":
    try:
        if flag("login"):
            run_login()
        elif flag("list"):
            run_list()
        else:
            sys.exit(run_scrape())
    except KeyboardInterrupt:
        pass
