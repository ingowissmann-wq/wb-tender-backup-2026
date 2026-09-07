import test from 'node:test';
import assert from 'node:assert/strict';
import {testReadOnlyPortal} from '../platform/portal-credentials.mjs';
const portal={canonical_domain:'vergabe.example',login_path:'/login',document_path:'/documents',authentication_domains:['auth.example'],download_domains:['download.example']};
const credential={username:'synthetic-user',password:'synthetic-not-a-real-secret'};
const form=(action='/login',method='post')=>`<form action="${action}" method="${method}"><input name="username"><input name="password" type="password"></form>`;
const html=(body,init={})=>new Response(body,{status:200,...init});
test('untrusted form targets are rejected before any credential request',async()=>{
 for(const action of ['https://foreign.example/collect','https://download.example/collect','http://vergabe.example/collect']){
  const calls=[];const result=await testReadOnlyPortal({portal,credential,fetchImpl:async(url,options)=>{calls.push({url:String(url),body:options.body});return html(form(action));}});
  assert.equal(result.resultCode,'LOGIN_REDIRECT_UNERWARTET');assert.equal(calls.length,1);assert.equal(calls[0].body,undefined);
 }
});
test('credential forms using GET are rejected without placing secrets in URLs',async()=>{
 let calls=0;const result=await testReadOnlyPortal({portal,credential,fetchImpl:async()=>{calls++;return html(form('/login','get'));}});
 assert.equal(result.resultCode,'LOGIN_FORMULAR_GEAENDERT');assert.equal(calls,1);
});
test('303 after login becomes GET with no credential body or content headers',async()=>{
 const calls=[];const result=await testReadOnlyPortal({portal,credential,fetchImpl:async(url,options)=>{
  calls.push({url:String(url),method:options.method,body:options.body,headers:options.headers});
  if(calls.length===1)return html(form());
  if(calls.length===2)return html('',{status:303,headers:{location:'/account','set-cookie':'session=synthetic; Path=/; Secure; HttpOnly'}});
  return html('<h1>Dokumente</h1>');
 }});
 assert.equal(result.resultCode,'LOGIN_ERFOLGREICH');assert.equal(calls[1].method,'POST');assert.equal(calls[2].method,'GET');assert.equal(calls[2].body,undefined);assert.equal(calls[2].headers['content-type'],undefined);
});
test('307 never replays credentials to another approved origin',async()=>{
 let calls=0;const result=await testReadOnlyPortal({portal,credential,fetchImpl:async()=>{calls++;return calls===1?html(form()):html('',{status:307,headers:{location:'https://auth.example/replay'}});}});
 assert.equal(result.resultCode,'LOGIN_REDIRECT_UNERWARTET');assert.equal(calls,2);
});
