// On-demand single-shop scrape: GET /api/trigger-scrape?username=X&secret=shopeescope2026
// Scrapes products only (fast, ~2 min). No variants/reviews to avoid CAPTCHA.
const S=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_KEY,CRON_SECRET=process.env.CRON_SECRET||'';
const PROXY_URL=process.env.PROXY_URL||'',PROXY_SECRET=process.env.PROXY_SECRET||'';
const H_SB={'apikey':K,'Authorization':'Bearer '+K,'Content-Type':'application/json'};

const UAS=[
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
const randUA=()=>UAS[Math.floor(Math.random()*UAS.length)];
const sleep=ms=>new Promise(r=>setTimeout(r,Math.round(ms*(0.7+Math.random()*0.6))));

async function loadCookies(){
  try{const r=await fetch(`${S}/rest/v1/config?key=eq.shopee_cookies&select=value`,{headers:H_SB});const rows=await r.json();if(Array.isArray(rows)&&rows.length&&rows[0].value)return rows[0].value;}catch(e){}return null;
}
function extractCsrf(cookies){if(!cookies)return null;const m=cookies.match(/SPC_CTOKEN=([^;]+)/);return m?decodeURIComponent(m[1]):null;}

const makeHeaders=(cookies)=>{const csrf=extractCsrf(cookies);return{
  'x-api-source':'pc','x-shopee-language':'en','User-Agent':randUA(),
  'Referer':'https://shopee.com.my/','Accept':'application/json',
  'Accept-Language':'en-MY,en;q=0.9','sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty',
  ...(cookies?{'Cookie':cookies}:{}),
  ...(csrf?{'x-csrftoken':csrf}:{})
};};

const shopee=async(path,cookies)=>{
  if(PROXY_URL){const r=await fetch(`${PROXY_URL}/shopee`,{method:'POST',headers:{'Content-Type':'application/json',...(PROXY_SECRET?{'x-proxy-secret':PROXY_SECRET}:{})},body:JSON.stringify({path,cookies}),signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Proxy ${r.status}`);return r.json();}
  const r=await fetch(`https://shopee.com.my${path}`,{headers:makeHeaders(cookies),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error(`${r.status}: ${path}`);return r.json();
};

const sb=async(table,rows)=>{if(!rows?.length)return;const BATCH=25;for(let i=0;i<rows.length;i+=BATCH){const r=await fetch(`${S}/rest/v1/${table}`,{method:'POST',headers:{...H_SB,'Prefer':'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows.slice(i,i+BATCH))});if(!r.ok)console.error('sb err:',await r.text());}};

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(200).end();
  const{username,secret}=req.query;
  if(!username)return res.status(400).json({error:'username required'});
  if(CRON_SECRET&&secret!==CRON_SECRET)return res.status(401).json({error:'Unauthorized'});
  const started=Date.now();
  const today=new Date().toISOString().split('T')[0];
  try{
    const cookies=await loadCookies();
    // 1. Get shop detail to confirm shopid
    const sd=await shopee(`/api/v4/shop/get_shop_detail?username=${encodeURIComponent(username)}`,cookies);
    if(!sd.data)return res.status(404).json({error:'Shop not found on Shopee'});
    const shopid=sd.data.shopid;
    const sdata=sd.data;

    // 2. Save/update shop record
    await sb('shops?on_conflict=username',[{
      username,shopid,name:sdata.name||username,
      follower_count:sdata.follower_count||0,following_count:sdata.following_count||0,
      rating_star:sdata.overall_star||0,rating_normal:sdata.rating_normal||0,
      rating_good:sdata.rating_good||0,rating_bad:sdata.rating_bad||0,
      item_count:sdata.item_count||0,response_rate:sdata.response_rate||0,
      response_time:sdata.response_time_computed||sdata.response_time||0,
      is_official_shop:!!sdata.is_official_shop,is_shopee_verified:!!sdata.is_shopee_verified,
      vacation:!!sdata.vacation,cancellation_rate:sdata.cancellation_rate||0,
      description:(sdata.description||'').substring(0,500),updated_at:new Date().toISOString()
    }]);

    // 3. Load existing historical_sold to preserve if API returns 0
    const dbProds=await (async()=>{try{const r=await fetch(`${S}/rest/v1/latest_products?shopid=eq.${shopid}&select=itemid,historical_sold&limit=2000`,{headers:H_SB});return await r.json();}catch(e){return[];}})();
    const hsMap={};if(Array.isArray(dbProds))dbProds.forEach(p=>{hsMap[p.itemid]=p.historical_sold||0;});

    // 4. Scrape products — 3 sort orders to bypass ~240 item cap
    const seen=new Set(),prodsMap={};
    for(const sortBy of['sales','ctime','price']){
      let offset=0;
      while(true){
        const d=await shopee(`/api/v4/search/search_items?by=${sortBy}&limit=60&match_id=${shopid}&newest=${offset}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`,cookies);
        const batch=(d.items||[]).map(i=>i.item_basic).filter(Boolean);
        if(!batch.length)break;
        batch.forEach(p=>{if(!seen.has(p.itemid)){seen.add(p.itemid);prodsMap[p.itemid]=p;}});
        if(batch.length<60)break;
        offset+=60;
        await sleep(600);
      }
      await sleep(1200);
    }
    const prods=Object.values(prodsMap);
    if(!prods.length)throw new Error('No products returned — cookies may be expired');

    // 5. Save products
    const rows=prods.map(p=>({
      shopid,itemid:p.itemid,username,name:p.name,
      price_min:p.price_min||0,price_max:p.price_max||p.price_min||0,
      price_min_before_discount:p.price_min_before_discount||p.price_min||0,
      raw_discount:p.raw_discount||0,
      historical_sold:p.historical_sold||hsMap[p.itemid]||0,
      sold:p.sold||0,liked_count:p.liked_count||0,stock:p.stock||0,
      rating_star:p.item_rating?.rating_star||0,
      rating_count:p.item_rating?.rating_count?.reduce((a,b)=>a+b,0)||0,
      brand:p.brand||'',catid:p.catid||0,image:p.image||'',ctime:p.ctime||0,
      scraped_date:today,scraped_at:new Date().toISOString()
    }));
    await sb('products?on_conflict=shopid,itemid,scraped_date',rows);

    // 6. Auto-generate product-level snapshots
    const snaps=rows.map(p=>({
      shopid,itemid:p.itemid,model_id:0,username,product_name:p.name,
      variant_name:'Default',variant_sku:'',variation_type:'product',
      price:(p.price_min||0)/100000,stock:p.stock||0,sold:p.historical_sold||0,
      scraped_date:today,scraped_at:new Date().toISOString()
    }));
    await sb('snapshots?on_conflict=shopid,itemid,model_id,scraped_date',snaps);

    // 7. Log
    await sb('scrape_log',[{username,shopid,total_items:prods.length,status:'success',duration_ms:Date.now()-started}]);
    const duration=Math.round((Date.now()-started)/1000);
    return res.status(200).json({ok:true,username,shopid,products:prods.length,snapshots:snaps.length,duration_seconds:duration});
  }catch(e){
    await sb('scrape_log',[{username,shopid:0,total_items:0,status:'error',error_msg:e.message.substring(0,200),duration_ms:Date.now()-started}]).catch(()=>{});
    return res.status(500).json({error:e.message});
  }
}
