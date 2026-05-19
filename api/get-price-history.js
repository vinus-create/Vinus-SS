// GET /api/get-price-history?shopid=X            — daily avg/min/max price trend
// GET /api/get-price-history?shopid=X&type=changes — products with price drops/rises
const S=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_KEY;
const H={'apikey':K,'Authorization':'Bearer '+K};

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(200).end();
  const{shopid,type='history',threshold=0.05,itemid}=req.query;
  if(!shopid)return res.status(400).json({error:'shopid required'});
  try{
    // Fetch all daily price snapshots for this shop
    let url=`${S}/rest/v1/products?shopid=eq.${shopid}&select=itemid,name,price_min,scraped_date&order=scraped_date.asc&limit=10000`;
    if(itemid)url+=`&itemid=eq.${itemid}`;
    const r=await fetch(url,{headers:H});
    const rows=await r.json();
    if(!Array.isArray(rows)||!rows.length)return res.status(200).json([]);

    if(type==='history'){
      // Group by date → avg/min/max/count
      const byDate={};
      rows.forEach(row=>{
        const d=row.scraped_date;
        if(!byDate[d])byDate[d]={prices:[],date:d};
        if(row.price_min>0)byDate[d].prices.push(row.price_min/100000);
      });
      const history=Object.values(byDate)
        .filter(d=>d.prices.length>0)
        .map(d=>({
          date:d.date,
          avg:+(d.prices.reduce((a,b)=>a+b,0)/d.prices.length).toFixed(2),
          min:+Math.min(...d.prices).toFixed(2),
          max:+Math.max(...d.prices).toFixed(2),
          count:d.prices.length
        }))
        .sort((a,b)=>a.date.localeCompare(b.date));
      return res.status(200).json(history);
    }

    if(type==='changes'){
      // Find products whose price changed between first and latest scraped date
      // Group rows by itemid
      const byItem={};
      rows.forEach(row=>{
        if(!byItem[row.itemid])byItem[row.itemid]={name:row.name,snapshots:[]};
        byItem[row.itemid].snapshots.push({date:row.scraped_date,price:row.price_min/100000});
      });
      const changes=[];
      Object.entries(byItem).forEach(([itemid,item])=>{
        const snaps=item.snapshots.filter(s=>s.price>0).sort((a,b)=>a.date.localeCompare(b.date));
        if(snaps.length<2)return;
        const first=snaps[0],last=snaps[snaps.length-1];
        if(first.price===0)return;
        const pct=(last.price-first.price)/first.price;
        if(Math.abs(pct)<parseFloat(threshold))return;
        changes.push({
          itemid:parseInt(itemid),name:item.name,
          old_price:+first.price.toFixed(2),new_price:+last.price.toFixed(2),
          change_pct:+(pct*100).toFixed(1),
          changed_from:first.date,changed_to:last.date,
          direction:pct>0?'up':'down'
        });
      });
      changes.sort((a,b)=>Math.abs(b.change_pct)-Math.abs(a.change_pct));
      return res.status(200).json(changes.slice(0,100));
    }

    return res.status(400).json({error:'Invalid type. Use history or changes'});
  }catch(e){return res.status(500).json({error:e.message});}
}
