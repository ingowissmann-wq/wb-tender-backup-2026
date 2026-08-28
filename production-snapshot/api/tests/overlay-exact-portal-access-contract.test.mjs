import assert from "node:assert/strict";
import {existsSync,readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import test from "node:test";

const overlayBase=new URL("../deployment/context-portal-readiness-128-overlay/platform/",import.meta.url);
const shippedBase=new URL("../platform/",import.meta.url);
const base=existsSync(fileURLToPath(new URL("registered-portal-scope.mjs",overlayBase)))?overlayBase:shippedBase;
const {registeredTenderPortalScope}=await import(new URL("registered-portal-scope.mjs",base));
const routes=readFileSync(new URL("autopilot-routes.mjs",base),"utf8");

test("portal access endpoint binds the supplied canonical lot to the document portal role",()=>{
  const route=routes.slice(routes.indexOf('"/api/portal-access/for-tender/:tenderId"'),
    routes.indexOf('"/api/portal-access/:portalId/tenders"'));
  for(const token of ["lot_required","lotKey: requestedLot",'portalRole: "DOCUMENT_PORTAL"',
    "requireCredential: false",'portal_mapping_status: "REGISTERED_EXACT_SCOPE"'])
    assert.ok(route.includes(token),token);
  assert.ok(!route.includes("evidencePortalId"));
  assert.ok(!route.includes("exactRegisteredScope"));
});

test("an exact assignment can be shown for credential setup but protected actions still require a credential",async()=>{
  const row={tender_id:"t",company_id:"c",portal_id:"p",credential_id:null};
  const db={query:async()=>({rows:[row]})};
  assert.deepEqual(await registeredTenderPortalScope(db,{tenderId:"t",companyId:"c",lotKey:"LOT-1",
    portalRole:"DOCUMENT_PORTAL",requireCredential:false}),row);
  assert.equal(await registeredTenderPortalScope(db,{tenderId:"t",companyId:"c",lotKey:"LOT-1",
    portalRole:"DOCUMENT_PORTAL"}),null);
});
