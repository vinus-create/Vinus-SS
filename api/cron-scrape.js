// Vercel Cron — Daily 8am MYT (0:00 UTC)
// Scrapes all competitor shops: products, snapshots, reviews
const S=process.env.SUPABASE_URL;
const K=process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET=process.env.CRON_SECRET||'';

const SHOPS=[
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

const H={
  'x-api-source':'pc','x-shopee-language':'en',
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer':'https://shopee.com.my/','Accept':'application/json',
};

const shopee=async(path)=>{
  const r=await fetch(`https://shopee.com.my${path}`,{headers:H,signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error(`${r.status}: ${path}`);
  return r.json();
};

const sb=async(table,rows)=>{
  if(!rows.length)return;
  const BATCH=25;
  for(let i=0;i<rows.length;i+=BATCH){
    const r=await fetch(`${S}/rest/v1/${table}`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':K,'Authorization':'Bearer '+K,'Prefer':'resolution=merge-duplicates,return=minimal'},
      body:JSON.stringify(rows.slice(i,i+BATCH))
    });
    if(!r.ok){const e=await r.text();console.error(`sb ${table}:`,e.substring(0,150));}
    await sleep(100);
  }
};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function scrapeShop({username,shopid}){
  const today=new Date().toISOString().split('T')[0];
  const started=Date.now();
  let prodCount=0,snapCount=0,revCount=0;

  try{
    // 1. All products (paginated)
    let prods=[],offset=0;
    while(true){
      const d=await shopee(`/api/v4/search/search_items?by=sales&limit=60&match_id=${shopid}&newest=${offset}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`);
      const batch=(d.items||[]).map(i=>i.item_basic);
      if(!batch.length)break;
      prods.push(...batch);
      if(batch.length<60)break;
      offset+=60;
      await sleep(400);
    }
    prodCount=prods.length;

    // 2. Save products with image + link
    await sb('products',prods.map(p=>({
      shopid,itemid:p.itemid,username,name:p.name,
      price_min:p.price_min,price_max:p.price_max||p.price_min,
      price_min_before_discount:p.price_min_before_discount||p.price_min,
      raw_discount:p.raw_discount||0,historical_sold:p.historical_sold||0,
      sold:p.sold||0,liked_count:p.liked_count||0,stock:p.stock||0,
      rating_star:p.item_rating?.rating_star||0,
      rating_count:p.item_rating?.rating_count?.reduce((a,b)=>a+b,0)||0,
      brand:p.brand||'',catid:p.catid||0,
      image:p.image||'',
      scraped_date:today,scraped_at:new Date().toISOString()
    })));

    // 3. Top 30 products: variant snapshots + reviews
    const top30=[...prods].sort((a,b)=>b.historical_sold-a.historical_sold).slice(0,30);
    const snaps=[],revs=[];

    for(let i=0;i<top30.length;i++){
      const p=top30[i];
      try{
        const d=await shopee(`/api/v4/item/get?itemid=${p.itemid}&shopid=${shopid}`);
        if(d.data?.models?.length>0){
          const vt=(d.data.tier_variations||[]).map(v=>v.name).join(' / ')||'variant';
          d.data.models.forEach(m=>snaps.push({shopid,itemid:p.itemid,model_id:m.modelid||0,username,product_name:p.name,variant_name:m.name||'Default',variant_sku:m.model_sku||'',variation_type:vt,price:m.price/100000,stock:m.stock||0,sold:m.sold||0,scraped_date:today,scraped_at:new Date().toISOString()}));
        } else {
          snaps.push({shopid,itemid:p.itemid,model_id:0,username,product_name:p.name,variant_name:'Default',variant_sku:'',variation_type:'single',price:p.price_min/100000,stock:p.stock||0,sold:p.sold||0,scraped_date:today,scraped_at:new Date().toISOString()});
        }
        await sleep(500);
        const rr=await shopee(`/api/v2/item/get_ratings?itemid=${p.itemid}&shopid=${shopid}&limit=10&offset=0&filter=0&type=0&exclude_filter=1&flag=1&fold_filter=0&relevant_reviews=false&request_source=2`);
        (rr.data?.ratings||[]).forEach(rv=>{
          if(!rv.comment)return;
          revs.push({shopid,itemid:p.itemid,product_name:p.name,rating_star:rv.rating_star||0,comment:rv.comment.substring(0,500),author:rv.author_username||'',variant_bought:rv.product_items?.[0]?.variation_name||'',tags:(rv.tags||[]).join(','),has_seller_reply:!!(rv.reply?.comment),ctime:rv.ctime||0,scraped_at:new Date().toISOString()});
        });
      }catch(e){console.warn(`  item err ${p.itemid}:`,e.message);}
      await sleep(500);
    }

    await sb('snapshots',snaps);
    await sb('reviews',revs);
    await sb('product_variants',snaps.map(s=>({...s,scraped_date:today})));
    snapCount=snaps.length; revCount=revs.length;

    // 4. Log
    await sb('scrape_log',[{username,shopid,total_items:prodCount,status:'success',duration_ms:Date.now()-started}]);
    console.log(`✅ ${username}: ${prodCount} products, ${snapCount} snaps, ${revCount} reviews (${Math.round((Date.now()-started)/1000)}s)`);

  }catch(e){api/cron-scrape.js
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
  const startAll=Date.now();
  console.log('🕗 Cron started:',new Date().toISOString(),`(${SHOPS.length} shops)`);
  const results=[];
  for(const shop of SHOPS){
    const r=await scrapeShop(shop);
    results.push(r);
    await sleep(3000); // 3s between shops to be polite
  }
  const duration=Math.round((Date.now()-startAll)/1000);
  console.log(`🏁 Cron done in ${duration}s. Scraped ${results.reduce((a,r)=>a+r.products,0)} products total.`);
  return res.status(200).json({ok:true,scraped_at:new Date().toISOString(),duration_seconds:duration,shops:results});
}
