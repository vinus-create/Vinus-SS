// Vercel Cron — Daily 8am MYT (0:00 UTC)
const S=process.env.SUPABASE_URL;
const K=process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET=process.env.CRON_SECRET||'';
const PROXY_URL=process.env.PROXY_URL||''; // e.g. https://vinus-proxy.fly.dev
const PROXY_SECRET=process.env.PROXY_SECRET||'';

const FALLBACK_SHOPS=[
  {username:'buddysnack',        shopid:3693884},
  {username:'winstartech',       shopid:65231794},
  {username:'1stopbatteries',    shopid:436346628},
  {username:'icare4allshop',     shopid:101702703},
  {username:'energizerbatteryhub',shopid:1616613112},
  {username:'gadgetspecialist',  shopid:57639219},
  {username:'gou.ori',           shopid:3614138},
  {username:'tenbucksfood',      shopid:299773965},
  {username:'dsconcept_store',   shopid:1494888251},
  {username:'sxmixempire',       shopid:902193943},
  {username:'r_in_g',            shopid:1421385614},
  {username:'nextgenhardware.os',shopid:1088905843},
  {username:'ham_radios.my',     shopid:1231953709},
];

const H_SB={'apikey':K,'Authorization':'Bearer '+K,'Content-Type':'application/json'};

// Sleep with ±30% random jitter to avoid pattern detection
const sleep=ms=>new Promise(r=>setTimeout(r,ms+Math.floor(Math.random()*ms*0.3)));

// Load Shopee cookies from Supabase config table
async function loadCookies(){
  try{
    const r=await fetch(`${S}/rest/v1/config?key=eq.shopee_cookies&select=value`,{headers:H_SB});
    const rows=await r.json();
    if(Array.isArray(rows)&&rows.length&&rows[0].value) return rows[0].value;
  }catch(e){console.warn('Could not load cookies:',e.message);}
  return null;
}

function extractCsrf(cookies){
  if(!cookies)return null;
  const m=cookies.match(/SPC_CTOKEN=([^;]+)/);
  return m?decodeURIComponent(m[1]):null;
}

const makeShopeeHeaders=(cookies)=>{
  const csrf=extractCsrf(cookies);
  return {
    'x-api-source':'pc','x-shopee-language':'en',
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer':'https://shopee.com.my/','Accept':'application/json',
    'Accept-Language':'en-MY,en;q=0.9,ms;q=0.8',
    'sec-ch-ua':'"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile':'?0',
    'sec-ch-ua-platform':'"Windows"',
    'sec-fetch-site':'same-origin',
    'sec-fetch-mode':'cors',
    'sec-fetch-dest':'empty',
    ...(cookies?{'Cookie':cookies}:{}),
    ...(csrf?{'x-csrftoken':csrf}:{})
  };
};

const shopee=async(path,cookies)=>{
  if(PROXY_URL){
    // Route through Singapore proxy to avoid Vercel US IP geo-block
    const r=await fetch(`${PROXY_URL}/shopee`,{
      method:'POST',
      headers:{'Content-Type':'application/json',...(PROXY_SECRET?{'x-proxy-secret':PROXY_SECRET}:{})},
      body:JSON.stringify({path,cookies}),
      signal:AbortSignal.timeout(20000)
    });
    if(!r.ok)throw new Error(`Proxy ${r.status}: ${path}`);
    return r.json();
  }
  // Fallback: direct (may 403 from non-MY IP)
  const r=await fetch(`https://shopee.com.my${path}`,{headers:makeShopeeHeaders(cookies),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error(`${r.status}: ${path}`);
  return r.json();
};

const sb=async(table,rows)=>{
  if(!rows||!rows.length)return;
  const BATCH=25;
  for(let i=0;i<rows.length;i+=BATCH){
    const r=await fetch(`${S}/rest/v1/${table}`,{
      method:'POST',
      headers:{...H_SB,'Prefer':'resolution=merge-duplicates,return=minimal'},
      body:JSON.stringify(rows.slice(i,i+BATCH))
    });
    if(!r.ok){const e=await r.text();console.error(`sb ${table}:`,e.substring(0,150));}
    await sleep(80);
  }
};

const sbQuery=async(path)=>{
  const r=await fetch(`${S}/rest/v1/${path}`,{headers:H_SB});
  if(!r.ok)return[];
  return r.json();
};

async function scrapeShop({username,shopid},cookies){
  const today=new Date().toISOString().split('T')[0];
  const started=Date.now();
  let prodCount=0,snapCount=0,revCount=0;

  try{
    // Load last known historical_sold from DB to preserve if API returns 0
    const dbProds=await sbQuery(`latest_products?shopid=eq.${shopid}&select=itemid,historical_sold&limit=1000`);
    const hsMap={};
    if(Array.isArray(dbProds)) dbProds.forEach(p=>{hsMap[p.itemid]=p.historical_sold||0;});
    console.log(`  ${username}: loaded ${Object.keys(hsMap).length} existing products from DB`);

    // 1. All products — scrape 3 sort orders to bypass API ~240 item cap
    const seenItemIds=new Set();
    const prodsMap={};
    for(const sortBy of ['sales','ctime','price']){
      let offset=0,sortProds=0;
      while(true){
        const d=await shopee(`/api/v4/search/search_items?by=${sortBy}&limit=60&match_id=${shopid}&newest=${offset}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`,cookies);
        const batch=(d.items||[]).map(i=>i.item_basic).filter(Boolean);
        if(!batch.length)break;
        let newItems=0;
        batch.forEach(p=>{
          if(!seenItemIds.has(p.itemid)){
            seenItemIds.add(p.itemid);
            prodsMap[p.itemid]=p;
            newItems++;
          }
        });
        sortProds+=batch.length;
        if(batch.length<60)break;
        offset+=60;
        await sleep(700);
      }
      console.log(`  ${username} [${sortBy}]: ${sortProds} fetched, ${seenItemIds.size} unique total`);
      await sleep(1500); // pause between sort orders
    }
    const prods=Object.values(prodsMap);
    prodCount=prods.length;

    if(prodCount===0){
      throw new Error('No products returned — cookies may be expired');
    }
    console.log(`  ${username}: ${prodCount} unique products after dedup`);

    // 2. Save products — preserve historical_sold if API returns 0
    await sb('products?on_conflict=shopid,itemid,scraped_date',prods.map(p=>({
      shopid,itemid:p.itemid,username,name:p.name,
      price_min:p.price_min||0,price_max:p.price_max||p.price_min||0,
      price_min_before_discount:p.price_min_before_discount||p.price_min||0,
      raw_discount:p.raw_discount||0,
      historical_sold:p.historical_sold||hsMap[p.itemid]||0,
      sold:p.sold||0,
      liked_count:p.liked_count||0,stock:p.stock||0,
      rating_star:p.item_rating?.rating_star||0,
      rating_count:p.item_rating?.rating_count?.reduce((a,b)=>a+b,0)||0,
      brand:p.brand||'',catid:p.catid||0,
      image:p.image||'',ctime:p.ctime||0,
      scraped_date:today,scraped_at:new Date().toISOString()
    })));

    // 3. Top 30 products: variant snapshots + reviews
    const top30=[...prods].sort((a,b)=>
      (b.historical_sold||hsMap[b.itemid]||0)-(a.historical_sold||hsMap[a.itemid]||0)
    ).slice(0,30);

    const snaps=[],revs=[];
    for(let i=0;i<top30.length;i++){
      const p=top30[i];
      try{
        await sleep(700);
        const d=await shopee(`/api/v4/item/get?itemid=${p.itemid}&shopid=${shopid}`,cookies);
        if(d.data?.models?.length>0){
          const vt=(d.data.tier_variations||[]).map(v=>v.name).join(' / ')||'variant';
          d.data.models.forEach(m=>snaps.push({
            shopid,itemid:p.itemid,model_id:m.modelid||0,username,
            product_name:p.name,variant_name:m.name||'Default',variant_sku:m.model_sku||'',
            variation_type:vt,price:m.price/100000,stock:m.stock||0,sold:m.sold||0,
            scraped_date:today,scraped_at:new Date().toISOString()
          }));
        }else{
          snaps.push({
            shopid,itemid:p.itemid,model_id:0,username,
            product_name:p.name,variant_name:'Default',variant_sku:'',variation_type:'single',
            price:(p.price_min||0)/100000,stock:p.stock||0,sold:p.sold||0,
            scraped_date:today,scraped_at:new Date().toISOString()
          });
        }
        await sleep(700);
        const rr=await shopee(`/api/v2/item/get_ratings?itemid=${p.itemid}&shopid=${shopid}&limit=10&offset=0&filter=0&type=0&exclude_filter=1&flag=1&fold_filter=0&relevant_reviews=false&request_source=2`,cookies);
        (rr.data?.ratings||[]).forEach(rv=>{
          if(!rv.comment)return;
          revs.push({
            shopid,itemid:p.itemid,product_name:p.name,
            rating_star:rv.rating_star||0,comment:rv.comment.substring(0,500),
            author:rv.author_username||'',variant_bought:rv.product_items?.[0]?.variation_name||'',
            tags:(rv.tags||[]).join(','),has_seller_reply:!!(rv.reply?.comment),
            ctime:rv.ctime||0,scraped_at:new Date().toISOString()
          });
        });
      }catch(e){console.warn(`  item err ${p.itemid}:`,e.message);}
      await sleep(600);
    }

    await sb('snapshots?on_conflict=shopid,itemid,model_id,scraped_date',snaps);
    await sb('reviews?on_conflict=shopid,itemid,ctime',revs);
    await sb('product_variants?on_conflict=shopid,itemid,model_id,scraped_date',snaps.map(s=>({...s})));
    snapCount=snaps.length; revCount=revs.length;

    await sb('scrape_log',[{username,shopid,total_items:prodCount,status:'success',duration_ms:Date.now()-started}]);
    console.log(`✅ ${username}: ${prodCount} products, ${snapCount} snaps, ${revCount} reviews (${Math.round((Date.now()-started)/1000)}s)`);

  }catch(e){
    console.error(`❌ ${username}:`,e.message);
    await sb('scrape_log',[{username,shopid,total_items:0,status:'error',error_msg:e.message.substring(0,200),duration_ms:Date.now()-started}]);
  }
  return {username,shopid,products:prodCount,snapshots:snapCount,reviews:revCount};
}

export default async function handler(req,res){
  const auth=req.headers.authorization||'';
  if(CRON_SECRET&&auth!==`Bearer ${CRON_SECRET}`){
    return res.status(401).json({error:'Unauthorized'});
  }

  const today=new Date().toISOString().split('T')[0];

  // Load cookies from Supabase
  const cookies=await loadCookies();
  if(cookies){
    console.log('✅ Loaded Shopee cookies from Supabase config');
  }else{
    console.warn('⚠️ No cookies found in config — scrape may fail. Use the dashboard to save cookies.');
  }

  // Load shop list from DB
  let SHOPS=FALLBACK_SHOPS;
  try{
    const r=await fetch(`${S}/rest/v1/shops?select=username,shopid&order=updated_at.desc&limit=200`,{headers:H_SB});
    const dbShops=await r.json();
    if(Array.isArray(dbShops)&&dbShops.length){
      const real=dbShops.filter(s=>s.username&&!s.username.startsWith('disc_'));
      if(real.length) SHOPS=real;
    }
  }catch(e){console.warn('Could not load shops from DB, using fallback:',e.message);}

  // Skip shops already successfully scraped today
  let doneToday=new Set();
  try{
    const r=await fetch(`${S}/rest/v1/scrape_log?select=username&status=eq.success&scraped_at=gte.${today}T00:00:00Z&limit=100`,{headers:H_SB});
    const log=await r.json();
    if(Array.isArray(log)) log.forEach(l=>doneToday.add(l.username));
    if(doneToday.size) console.log(`⏭️ Already done today: ${[...doneToday].join(', ')}`);
  }catch(e){console.warn('Could not check scrape_log:',e.message);}

  const pending=SHOPS.filter(s=>!doneToday.has(s.username));

  const startAll=Date.now();
  console.log(`🕗 Cron started: ${new Date().toISOString()} — ${pending.length}/${SHOPS.length} shops to scrape`);

  const results=[];
  for(const shop of pending){
    const r=await scrapeShop(shop,cookies);
    results.push(r);
    await sleep(5000);
  }

  const duration=Math.round((Date.now()-startAll)/1000);
  console.log(`🏁 Cron done in ${duration}s. Scraped ${results.reduce((a,r)=>a+r.products,0)} products total.`);
  return res.status(200).json({
    ok:true,
    cookies_loaded:!!cookies,
    scraped_at:new Date().toISOString(),
    duration_seconds:duration,
    skipped:[...doneToday],
    shops:results
  });
}
