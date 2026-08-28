import fs from "node:fs";
import pg from "pg";
import { createFixedScopedPool, loadBackgroundScope } from "../platform/scoped-pg-pool.mjs";

const connectionString=process.env.DATABASE_URL||fs.readFileSync(
  process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8",
).trim();
const rawPool=new pg.Pool({connectionString,max:1,options:"-c default_transaction_read_only=on -c statement_timeout=120000"});
const pool=createFixedScopedPool(rawPool,await loadBackgroundScope(rawPool)).pool;
const MAX_BYTES=2_000_000,CONCURRENCY=6;

const normalizeHost=value=>String(value||"").trim().toLowerCase().replace(/^\.+|\.+$/g,"");
const allowedHost=(host,allowed)=>allowed.has(normalizeHost(host));
const statusFor=value=>value>=200&&value<300?"REACHABLE":value===401||value===403?"AUTH_REQUIRED":value===404?"ENTRY_NOT_FOUND":value===429?"RATE_LIMITED":value>=500?"EXTERNAL_PORTAL_UNAVAILABLE":"HTTP_RESPONSE_RECEIVED";
async function readBounded(response){if(!response.body)return 0;const reader=response.body.getReader();let bytes=0;try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES)throw Object.assign(new Error("response_too_large"),{code:"RESPONSE_TOO_LARGE"})}return bytes}finally{if(bytes>MAX_BYTES)await reader.cancel().catch(()=>{})}}

async function inspectEntry(entry,portal){
  const allowed=new Set([portal.canonical_domain,...portal.allowed_subdomains,...portal.authentication_domains,...portal.download_domains].map(normalizeHost).filter(Boolean));
  let current=new URL(entry.url),redirects=0;
  const redirectChain=[];
  while(true){
    if(current.protocol!=="https:"||!allowedHost(current.hostname,allowed))return {role:entry.role,url:entry.url,status:"REGISTRY_HOST_REPAIR_REQUIRED",httpStatus:null,redirectChain,finalHost:current.hostname,externalWrite:false};
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);
    try{
      const response=await fetch(current,{method:"GET",redirect:"manual",signal:controller.signal,headers:{accept:"text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.2","user-agent":"WB-Tender-Registry-ReadOnly-Canary/1.0"}});
      if(response.status>=300&&response.status<400){
        const location=response.headers.get("location");
        if(!location)return {role:entry.role,url:entry.url,status:"REDIRECT_LOCATION_MISSING",httpStatus:response.status,redirectChain,finalHost:current.hostname,externalWrite:false};
        if(redirects>=portal.max_redirects)return {role:entry.role,url:entry.url,status:"REDIRECT_LIMIT_EXCEEDED",httpStatus:response.status,redirectChain,finalHost:current.hostname,externalWrite:false};
        const next=new URL(location,current);
        redirectChain.push({status:response.status,fromHost:current.hostname,toHost:next.hostname});
        if(next.protocol!=="https:"||!allowedHost(next.hostname,allowed))return {role:entry.role,url:entry.url,status:"REGISTRY_REDIRECT_HOST_REPAIR_REQUIRED",httpStatus:response.status,redirectChain,finalHost:next.hostname,externalWrite:false};
        current=next;redirects+=1;continue;
      }
      const declared=Number(response.headers.get("content-length")||0);
      if(declared>MAX_BYTES)return {role:entry.role,url:entry.url,status:"RESPONSE_TOO_LARGE",httpStatus:response.status,redirectChain,finalHost:current.hostname,declaredBytes:declared,externalWrite:false};
      const bytes=await readBounded(response);
      return {role:entry.role,url:entry.url,status:statusFor(response.status),httpStatus:response.status,redirectChain,finalHost:current.hostname,contentType:String(response.headers.get("content-type")||"").slice(0,160),bytes,externalWrite:false};
    }catch(error){return {role:entry.role,url:entry.url,status:error?.code==="RESPONSE_TOO_LARGE"?"RESPONSE_TOO_LARGE":error?.name==="AbortError"?"TIMEOUT":"EXTERNAL_PORTAL_UNAVAILABLE",httpStatus:null,redirectChain,finalHost:current.hostname,errorCode:String(error?.cause?.code||error?.code||error?.name||"FETCH_FAILED").slice(0,80),externalWrite:false}}
    finally{clearTimeout(timer)}
  }
}

try{
  const portals=(await pool.query(`SELECT id,display_name,canonical_domain,
      coalesce(allowed_subdomains,'{}') allowed_subdomains,
      coalesce(authentication_domains,'{}') authentication_domains,
      coalesce(download_domains,'{}') download_domains,
      authentication_entry_url,registration_entry_url,bidder_area_url,
      greatest(0,least(coalesce(max_redirects,5),10)) max_redirects,
      portal_family_key,adapter_id,adapter_enabled,adapter_validation_status
    FROM tender.portal_registry ORDER BY canonical_domain`)).rows;
  const jobs=[];
  for(const portal of portals){
    const configured=[
      ["LOGIN",portal.authentication_entry_url],
      ["REGISTRATION",portal.registration_entry_url],
      ["BIDDER_AREA",portal.bidder_area_url],
    ].filter(([,url])=>url).map(([role,url])=>({role,url}));
    const entries=configured.length?configured:[{role:"CANONICAL_ROOT",url:`https://${portal.canonical_domain}/`}];
    for(const entry of entries)jobs.push({portal,entry});
  }
  const results=[];
  for(let offset=0;offset<jobs.length;offset+=CONCURRENCY){
    const chunk=jobs.slice(offset,offset+CONCURRENCY);
    results.push(...await Promise.all(chunk.map(async({portal,entry})=>({portalId:portal.id,displayName:portal.display_name,canonicalDomain:portal.canonical_domain,portalFamily:portal.portal_family_key,adapterId:portal.adapter_id,adapterEnabled:portal.adapter_enabled,adapterValidationStatus:portal.adapter_validation_status,...await inspectEntry(entry,portal)}))));
  }
  const byStatus=Object.fromEntries([...new Set(results.map(item=>item.status))].sort().map(status=>[status,results.filter(item=>item.status===status).length]));
  console.log(JSON.stringify({capturedAt:new Date().toISOString(),method:"GET_ONLY",readOnly:true,credentialUse:false,cookieUse:false,externalWrite:false,transmitted:false,portalCount:portals.length,entryCount:results.length,byStatus,results},null,2));
}finally{await rawPool.end()}
