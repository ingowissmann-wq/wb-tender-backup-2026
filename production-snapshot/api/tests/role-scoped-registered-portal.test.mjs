import assert from "node:assert/strict";
import test from "node:test";
import {registeredTenderPortalScope,requireRegisteredTenderPortalScope} from "../platform/registered-portal-scope.mjs";

test("registered execution scope requires one exact role/lot assignment with a capable credential",async()=>{
  let query;
  const row={tender_id:"t",company_id:"c",source_lot_id:"LOT-1",portal_role:"SUBMISSION_PORTAL",
    portal_id:"p",credential_id:"cred"};
  const scope=await registeredTenderPortalScope({query:async(sql,params)=>{query={sql,params};return {rows:[row]};}},
    {tenderId:"t",companyId:"c",lotKey:"LOT-1",portalRole:"SUBMISSION_PORTAL"});
  assert.equal(scope,row);
  assert.match(query.sql,/current_tender_company_portal_role_scopes/);
  assert.match(query.sql,/scope\.portal_role=\$3/);
  assert.match(query.sql,/scope\.source_lot_id=\$4/);
  assert.deepEqual(query.params,["t","c","SUBMISSION_PORTAL","LOT-1"]);
  assert.equal(await registeredTenderPortalScope({query:async()=>({rows:[{...row,credential_id:null}]})},
    {tenderId:"t",companyId:"c",lotKey:"LOT-1"}),null);
  assert.equal(await registeredTenderPortalScope({query:async()=>({rows:[row,{...row,portal_id:"p2"}]})},
    {tenderId:"t",companyId:"c",lotKey:"LOT-1"}),null);
});

test("missing credential and missing assignment expose executable fail-closed repairs",async()=>{
  for(const [assignments,status,repairAction] of [[1,"ACCOUNT_SETUP_REQUIRED","PORTAL_CREDENTIAL_FOR_EXACT_COMPANY_AND_HOST_CONFIGURE"],
    [0,"DATA_CONTEXT_REPAIR_REQUIRED","DOCUMENT_OR_SUBMISSION_PORTAL_FOR_EXACT_COMPANY_TENDER_LOT_CONFIRM"]]){
    const db={query:async sql=>sql.includes("SELECT scope.tender_id")?{rows:[]}:
      {rows:[{assignments,credential_ready:0}]}};
    let response;
    const reply={code(value){assert.equal(value,404);return this;},send(value){response=value;}};
    assert.equal(await requireRegisteredTenderPortalScope(db,reply,{tenderId:"t",companyId:"c",
      lotKey:"LOT-1",portalRole:"DOCUMENT_PORTAL"}),null);
    assert.equal(response.status,status);
    assert.equal(response.repairAction,repairAction);
    assert.equal(response.portalRole,"DOCUMENT_PORTAL");
    assert.equal(response.transmitted,false);
  }
});
