import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {BlockList,isIPv4} from 'node:net';
import {safeDownloadName} from './tenant-storage.mjs';
const blocked=new BlockList();
for(const [network,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(network,bits,'ipv4');
const fail=code=>Object.assign(new Error(code),{statusCode:409});
export function publicDocumentUrl(value){
 let url;try{url=new URL(value)}catch{throw fail('document_fetch_url_invalid')}
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash||url.hostname.includes(':'))throw fail('document_fetch_url_invalid');
 return url;
}
export function publicDocumentAddress(address){return isIPv4(address)&&!blocked.check(address,'ipv4')}
const types=new Map([
 ['application/pdf','.pdf'],['application/vnd.openxmlformats-officedocument.wordprocessingml.document','.docx'],
 ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx'],['text/csv','.csv'],['application/xml','.xml'],['text/xml','.xml'],
]);
export async function fetchPublicDocument(value,{lookupImpl=lookup,requestImpl=https.request,maxBytes=10*1024*1024,timeoutMs=20000}={}){
 const original=publicDocumentUrl(value),signal=AbortSignal.timeout(timeoutMs);let current=original;
 for(let redirect=0;redirect<5;redirect++){
  let addresses;try{addresses=await lookupImpl(current.hostname,{family:4,all:true,verbatim:true})}catch{throw fail('document_fetch_dns_failed')}
  if(!addresses.length||addresses.some(x=>!publicDocumentAddress(x.address)))throw fail('document_fetch_network_forbidden');
  const address=addresses[0].address;
  const result=await new Promise((resolve,reject)=>{
   const request=requestImpl(current,{method:'GET',agent:false,signal,minVersion:'TLSv1.2',headers:{accept:[...types.keys()].join(', '),'user-agent':'WB-Tender-Public-Document/1.0'},
    lookup:(_host,options,callback)=>callback(null,...(options?.all?[[{address,family:4}]]:[address,4])),
   },response=>{
    if([301,302,303,307,308].includes(response.statusCode)){response.resume();return resolve({location:response.headers.location})}
    if(response.statusCode!==200){response.resume();return reject(fail('document_fetch_not_public_or_unavailable'))}
    const mediaType=String(response.headers['content-type']||'').split(';')[0].trim().toLowerCase();
    if(!types.has(mediaType)||Number(response.headers['content-length']||0)>maxBytes){response.destroy();return reject(fail('document_fetch_type_or_size_rejected'))}
    const parts=[];let size=0;
    response.on('data',part=>{size+=part.length;if(size>maxBytes){response.destroy();reject(fail('document_fetch_type_or_size_rejected'))}else parts.push(part)});
    response.on('error',()=>reject(fail('document_fetch_transport_failed')));
    response.on('end',()=>{if(!size)return reject(fail('document_fetch_empty'));const bytes=Buffer.concat(parts);
     if(mediaType==='application/pdf'&&bytes.subarray(0,5).toString()!=='%PDF-'||/\.docx|\.xlsx/.test(types.get(mediaType))&&bytes.subarray(0,2).toString()!=='PK')return reject(fail('document_fetch_signature_invalid'));
     // Use a neutral name; untrusted disposition headers never determine a path.
     resolve({bytes,mediaType,filename:safeDownloadName('Vergabeunterlage'+types.get(mediaType))});
    });
   });
   request.on('error',()=>reject(fail('document_fetch_transport_failed')));request.end();
  });
  if(result.bytes)return result;
  if(!result.location)throw fail('document_fetch_redirect_invalid');
  const next=publicDocumentUrl(new URL(result.location,current).href);
  if(next.origin!==original.origin)throw fail('document_fetch_redirect_forbidden');current=next;
 }
 throw fail('document_fetch_redirect_limit');
}
