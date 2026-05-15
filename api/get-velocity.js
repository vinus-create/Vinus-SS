const S=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_KEY;
const H={'apikey':K,'Authorization':'Bearer '+K,'Content-Type':'application/json'};
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(200).end();
  const{shopid,limit=500,from,to}=req.query;
  try{
    // Custom date range — call RPC
    if(from&&to){
      const body={from_date:from,to_date:to,p_limit:parseInt(limit)};
      if(shopid)body.p_shopid=parseInt(shopid);
      const r=await fetch(`${S}/rest/v1/rpc/get_velocity_range`,{method:'POST',headers:H,body:JSON.stringify(body)});
      return res.status(200).json(await r.json());
    }
    // Default: use pre-computed view
    let url=`${S}/rest/v1/variant_velocity?order=sold_7d.desc&limit=${limit}`;
    if(shopid)url+=`&shopid=eq.${shopid}`;
    const r=await fetch(url,{headers:H});
    return res.status(200).json(await r.json());
  }catch(e){return res.status(500).json({error:e.message});}
}
