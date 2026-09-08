import {domainToASCII} from 'node:url';
const host=value=>domainToASCII(String(value||'').toLowerCase().replace(/\.$/,''));
export function portalAuthenticationHosts(portal){return new Set([portal.canonical_domain,...(portal.allowed_subdomains||[]),...(portal.authentication_domains||[])].map(host).filter(Boolean));}
export function portalAuthenticationRequestAllowed({url,method='GET',allowedHosts,credential}){
 let target;try{target=new URL(url)}catch{return false}
 if(target.protocol!=='https:'||target.port&&target.port!=='443'||target.username||target.password||!allowedHosts.has(host(target.hostname)))return false;
 if(!['GET','HEAD','POST'].includes(method))return false;
 // A browser must never put credentials into a URL, including redirects.
 let decoded=target.href;for(let n=0;n<3;n++){try{const next=decodeURIComponent(decoded.replaceAll('+',' '));if(next===decoded)break;decoded=next}catch{break}}
 for(const secret of [credential?.username,credential?.password])if(secret&&decoded.includes(secret))return false;
 return true;
}
export async function installPortalAuthenticationBoundary(context,portal,credential,onBlocked=()=>{},allowedPostUrls=new Set()){
 const allowedHosts=portalAuthenticationHosts(portal);
 await context.route('**/*',async route=>{
  const request=route.request();
  if(!portalAuthenticationRequestAllowed({url:request.url(),method:request.method(),allowedHosts,credential})||(request.method()==='POST'&&!allowedPostUrls.has(new URL(request.url()).href))){
   if(request.isNavigationRequest()||request.method()==='POST')onBlocked();
   return route.abort('blockedbyclient');
  }
  return route.fallback();
 });
 return allowedHosts;
}
export async function validatePortalCredentialField(field,allowedHosts,allowedPostUrls=new Set()){
 if(!field)return false;
 const info=await field.evaluate(element=>({url:element.ownerDocument.location.href,form:element.form?{action:element.form.action,method:element.form.method}:null}));
 if(!portalAuthenticationRequestAllowed({url:info.url,allowedHosts}))return false;
 if(!info.form||info.form.method.toUpperCase()!=='POST'||!portalAuthenticationRequestAllowed({url:info.form.action,method:'POST',allowedHosts}))return false;
 allowedPostUrls.add(new URL(info.form.action).href);return true;
}
