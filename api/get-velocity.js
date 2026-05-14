const S=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_KEY;
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(200).end();
  const{shopid,limit=200}=req.query;
  try{
    let url=`${S}/rest/v1/variant_velocity?order=sold_7d.desc&limit=${limit}`;
    if(shopid)url+=`&shopid=eq.${shopid}`;
    const r=await fetch(url,{headers:{'apikey':K,'Authorization':'Bearer '+K}});
    return res.status(200).json(await r.json());
  }catch(e){return res.status(500).json({error:e.message});}
}
