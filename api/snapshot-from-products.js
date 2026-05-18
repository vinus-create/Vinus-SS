// Creates product-level snapshots from existing products rows already in DB.
// Call once per day after scrape to backfill velocity data.
// GET /api/snapshot-from-products?date=2026-05-18&shopid=3693884 (shopid optional)
const S=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_KEY;
const H={'apikey':K,'Authorization':'Bearer '+K,'Content-Type':'application/json'};

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(200).end();
  const{date,shopid}=req.query;
  const today=date||new Date().toISOString().split('T')[0];
  try{
    let url=`${S}/rest/v1/products?scraped_date=eq.${today}&select=shopid,itemid,username,name,price_min,stock,historical_sold&limit=2000`;
    if(shopid)url+=`&shopid=eq.${shopid}`;
    const r=await fetch(url,{headers:H});
    const prods=await r.json();
    if(!Array.isArray(prods)||!prods.length)return res.status(200).json({ok:true,saved:0,date:today,msg:'No products found for this date'});

    const snaps=prods.map(p=>({
      shopid:p.shopid,itemid:p.itemid,model_id:0,username:p.username,
      product_name:p.name,variant_name:'Default',variant_sku:'',variation_type:'product',
      price:(p.price_min||0)/100000,stock:p.stock||0,
      sold:p.historical_sold||0,
      scraped_date:today,scraped_at:new Date().toISOString()
    }));

    const BATCH=50;let saved=0,errors=[];
    for(let i=0;i<snaps.length;i+=BATCH){
      const sr=await fetch(`${S}/rest/v1/snapshots?on_conflict=shopid,itemid,model_id,scraped_date`,{
        method:'POST',
        headers:{...H,'Prefer':'resolution=merge-duplicates,return=minimal'},
        body:JSON.stringify(snaps.slice(i,i+BATCH))
      });
      if(!sr.ok){const e=await sr.text();errors.push(e.substring(0,100));}
      else saved+=snaps.slice(i,i+BATCH).length;
    }
    return res.status(200).json({ok:!errors.length,saved,total:snaps.length,date:today,shopid:shopid||'all',errors:errors.length?errors:undefined});
  }catch(e){return res.status(500).json({error:e.message});}
}
