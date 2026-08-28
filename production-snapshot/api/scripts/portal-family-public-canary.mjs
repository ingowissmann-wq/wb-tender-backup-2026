const profiles=[
  {host:"vergabe.landbw.de",url:"https://vergabe.landbw.de/NetServer/index.jsp",family:"ai-vergabe-manager",signature:/TenderingProcedureDetails|Administration Intelligence|NetServer/i},
  {host:"vergabe.stadt-frankfurt.de",url:"https://www.vergabe.stadt-frankfurt.de/NetServer/index.jsp",family:"ai-vergabe-manager",signature:/BieterCockpit/i},
  {host:"www.ausschreibungen.ls.brandenburg.de",url:"https://www.ausschreibungen.ls.brandenburg.de/NetServer/index.jsp",family:"ai-vergabe-manager",signature:/TenderingProcedureDetails|Administration Intelligence|NetServer/i},
  {host:"www.deutsches-ausschreibungsblatt.de",url:"https://www.deutsches-ausschreibungsblatt.de/auftrag-finden/evergabe-fuer-bieter",family:"ai-vergabe-manager",signature:/AI.?Bietercockpit|Bietercockpit/i},
  {host:"www.evergabe.nrw.de",url:"https://www.evergabe.nrw.de/VMPCenter/company/welcome.do",family:"cosinex-vmp",signature:/cosinex|Vergabemarktplatz NRW/i},
  {host:"www.vergabe.metropoleruhr.de",url:"https://www.vergabe.metropoleruhr.de/VMPSatellite/company/welcome.do",family:"cosinex-vmp",signature:/cosinex|Metropole Ruhr/i},
  {host:"plattform.aumass.de",url:"https://plattform.aumass.de/",family:"aumass",signature:/aumass/i},
];

async function boundedGet(profile){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30_000);
  try{
    const response=await fetch(profile.url,{method:"GET",redirect:"follow",signal:controller.signal,
      headers:{accept:"text/html,application/xhtml+xml", "user-agent":"WB-Tender-ReadOnly-Portal-Canary/1.0"}});
    const final=new URL(response.url),allowed=final.hostname.toLowerCase()===profile.host||
      (profile.host==="vergabe.stadt-frankfurt.de"&&final.hostname.toLowerCase()==="www.vergabe.stadt-frankfurt.de");
    if(!allowed)throw new Error(`redirect_host_forbidden:${final.hostname}`);
    const declared=Number(response.headers.get("content-length")||0);
    if(declared>2_000_000)throw new Error("response_too_large");
    const body=(await response.text()).slice(0,2_000_000);
    return {host:profile.host,family:profile.family,status:response.status,finalHost:final.hostname,
      signatureMatched:profile.signature.test(body),bytes:Buffer.byteLength(body),externalWrite:false};
  }catch(error){return {host:profile.host,family:profile.family,status:null,signatureMatched:false,
    error:String(error?.name==="AbortError"?"timeout":error?.message||error).slice(0,160),externalWrite:false}}
  finally{clearTimeout(timer)}
}

const results=await Promise.all(profiles.map(boundedGet));
const failed=results.filter(item=>item.status!==200||!item.signatureMatched);
console.log(JSON.stringify({capturedAt:new Date().toISOString(),method:"GET_ONLY",profiles:results.length,
  passed:results.length-failed.length,failed:failed.length,externalWrite:false,results},null,2));
if(failed.length)process.exitCode=1;
