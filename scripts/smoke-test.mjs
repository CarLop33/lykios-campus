const origin=String(process.argv[2]||process.env.LYKIOS_SMOKE_ORIGIN||process.env.LYKIOS_APP_ORIGIN||'').replace(/\/$/,'');
if(!origin) throw new Error('Indica el origen: node scripts/smoke-test.mjs https://... o LYKIOS_SMOKE_ORIGIN');

const checks=[
  ['/api/health/live',data=>data?.ok===true],
  ['/api/health/ready',data=>data?.ok===true&&data?.storage?.ok===true],
  ['/api/public/catalog',data=>Array.isArray(data?.courses)||Array.isArray(data)]
];

let failed=0;
for(const [pathname,validate] of checks){
  const started=Date.now();
  try{
    const response=await fetch(origin+pathname,{headers:{accept:'application/json'},redirect:'error'});
    const text=await response.text();
    let data=null;
    try{data=JSON.parse(text)}catch{}
    const ok=response.ok&&validate(data);
    if(!ok)failed++;
    console.log(JSON.stringify({pathname,status:response.status,ok,latencyMs:Date.now()-started},null,2));
  }catch(error){
    failed++;
    console.error(JSON.stringify({pathname,ok:false,error:error?.message||String(error)},null,2));
  }
}
if(failed)process.exit(1);
console.log('SMOKE GO');
