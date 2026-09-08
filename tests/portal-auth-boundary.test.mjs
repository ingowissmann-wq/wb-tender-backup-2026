import test from 'node:test';
import assert from 'node:assert/strict';
import {portalAuthenticationHosts,portalAuthenticationRequestAllowed,validatePortalCredentialField} from '../platform/portal-auth-boundary.mjs';
const portal={canonical_domain:'VERGABE.example.',authentication_domains:['auth.example'],download_domains:['documents.example']};
const allowedHosts=portalAuthenticationHosts(portal),credential={username:'buyer@example.test',password:'synthetic-password-only'};
const allowed=(url,method='GET')=>portalAuthenticationRequestAllowed({url,method,allowedHosts,credential});
test('authentication permits only explicit HTTPS login hosts and rejects credential URLs and unsafe methods',()=>{
 assert.equal(allowed('https://vergabe.example/login'),true);assert.equal(allowed('https://auth.example/login','POST'),true);
 for(const url of ['http://vergabe.example/login','https://vergabe.example:8443/login','https://vergabe.example.attacker.test/login','https://documents.example/login','https://127.0.0.1/login','https://user:password@vergabe.example/login','https://vergabe.example/?password=synthetic-password-only','https://vergabe.example/?user=buyer%2540example.test'])assert.equal(allowed(url),false,url);
 assert.equal(allowed('https://vergabe.example/login','DELETE'),false);
});
test('credential fields reject GET forms and foreign frame/action origins before filling',async()=>{
 const field=info=>({evaluate:async()=>info});const valid={url:'https://vergabe.example/login',form:{action:'https://auth.example/signin',method:'post'}};
 assert.equal(await validatePortalCredentialField(field(valid),allowedHosts),true);
 assert.equal(await validatePortalCredentialField(field({...valid,form:{...valid.form,method:'get'}}),allowedHosts),false);
 assert.equal(await validatePortalCredentialField(field({...valid,url:'https://foreign.example/frame'}),allowedHosts),false);
 assert.equal(await validatePortalCredentialField(field({...valid,form:{...valid.form,action:'https://foreign.example/collect'}}),allowedHosts),false);
});

test('browser diagnostics omit arbitrary exception text that may contain credential values',async()=>{
 const {safeBrowserFailure}=await import('../platform/semantic-browser-auth.mjs');
 const result=safeBrowserFailure(new Error('locator.fill failed with SYNTHETIC-PRIVATE-VALUE at https://example.test/?token=PRIVATE'),'CREDENTIAL_SUBMISSION');
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(result.failurePhase,'CREDENTIAL_SUBMISSION');assert.equal(result.resultCode,'TECHNISCHER_CONNECTORFEHLER');
});
