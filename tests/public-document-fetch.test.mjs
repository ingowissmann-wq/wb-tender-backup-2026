import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {fetchPublicDocument,publicDocumentUrl,publicDocumentAddress} from '../platform/public-document-fetch.mjs';
const lookupImpl=async()=>[{address:'93.184.216.34',family:4}];
function transport(replies,seen=[]){return (url,options,callback)=>{
 const request=new EventEmitter();request.end=()=>queueMicrotask(()=>{
  seen.push({url:String(url),options});const reply=replies.shift();
  const response=Readable.from(reply.body?[Buffer.from(reply.body)]:[]);response.statusCode=reply.status;response.headers=reply.headers;
  callback(response);
 });return request;
}}
test('public document fetch pins a public address, sends GET without credentials and validates bytes',async()=>{
 const seen=[];const result=await fetchPublicDocument('https://documents.example.org/file',{lookupImpl,requestImpl:transport([{status:200,headers:{'content-type':'application/pdf','content-disposition':'filename="../../secret"'},body:'%PDF-synthetic'}],seen)});
 assert.equal(result.filename,'Vergabeunterlage.pdf');assert.equal(result.bytes.toString(),'%PDF-synthetic');assert.equal(seen[0].options.method,'GET');
 assert.equal(seen[0].options.headers.cookie,undefined);assert.equal(seen[0].options.headers.authorization,undefined);
 seen[0].options.lookup('ignored',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}])});
});
test('public document fetch refuses private networks, cross-origin redirects, HTML and oversized bodies',async()=>{
 for(const value of ['127.0.0.1','10.1.2.3','100.64.0.1','169.254.169.254','172.16.0.1','192.168.1.1','198.19.0.1','224.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(publicDocumentAddress(value),false);
 for(const value of ['http://public.example/file','https://user:password@public.example/file','https://public.example:8443/file','https://[::1]/file'])assert.throws(()=>publicDocumentUrl(value),/document_fetch_url_invalid/);
 await assert.rejects(fetchPublicDocument('https://public.example/file',{lookupImpl:async()=>[{address:'127.0.0.1'}],requestImpl:()=>{throw Error('must not connect')}}),/network_forbidden/);
 for(const reply of [{status:302,headers:{location:'https://other.example/file'}},{status:200,headers:{'content-type':'text/html'},body:'login'},{status:200,headers:{'content-type':'application/pdf'},body:'not a PDF'},{status:200,headers:{'content-type':'application/pdf'},body:'%PDF-too-large'}])await assert.rejects(fetchPublicDocument('https://public.example/file',{lookupImpl,requestImpl:transport([reply]),maxBytes:10}),/document_fetch_/);
});
