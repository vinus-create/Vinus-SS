const S=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_KEY;
const sb=async(t,b)=>{const r=await fetch(`${S}/rest/v1/${t}`,{method:'POST',headers:{'Content-Type':'application/json','apikey':K,'Authorization':'Bearer '+K,'Prefer':'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(b)});if(!r.ok){const e=await r.text();throw new Error(e);}return r;};
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(200).end();
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  try{
    const{type,data}=req.body;
    if(!type||!data?.length)return res.status(400).json({error:'Missing type or data'});
    const BATCH=25;
    for(let i=0;i<data.length;i+=BATCH){await sb(type,data.slice(i,i+BATCH));}
    return res.status(200).json({ok:true,saved:data.length,type});
  }catch(e){return res.status(500).json({error:e.message});}
}
