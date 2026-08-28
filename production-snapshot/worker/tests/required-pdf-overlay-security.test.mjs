import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAutopilotRoutes } from "../platform/autopilot-routes.mjs";

const tender="11111111-1111-4111-8111-111111111111",company="22222222-2222-4222-8222-222222222222",required="33333333-3333-4333-8333-333333333333";

test("overlay mutation behaviorally enforces permission, CSRF and company scope before data access",async t=>{
  let queryCount=0;
  const app=Fastify({logger:false}),pool={query:async()=>{queryCount++;throw new Error("database_must_not_be_reached")},connect:async()=>{queryCount++;throw new Error("database_must_not_be_reached")}};
  const requirePermission=permission=>async(req,reply)=>{const granted=req.headers["x-test-permission"]==="yes";req.identity={userId:"44444444-4444-4444-8444-444444444444",permissions:granted?[...(Array.isArray(permission)?permission:[permission])]:[],companyIds:req.headers["x-test-company"]==="yes"?[company]:[]};if(!granted)return reply.code(403).send({error:"permission_forbidden"})};
  const csrf=async(req,reply)=>{if(req.headers["x-csrf-token"]!=="valid")return reply.code(403).send({error:"csrf_invalid"})};
  registerAutopilotRoutes(app,{pool,requirePermission,csrf,visibleTender:async()=>true});t.after(()=>app.close());
  const url=`/api/tenders/${tender}/required-documents/${required}/working-copy/overlays`,payload={company,lot:"LOT-0001",baseVersion:1,elements:[]};
  const noPermission=await app.inject({method:"POST",url,payload,headers:{"x-csrf-token":"valid"}});assert.equal(noPermission.statusCode,403);assert.equal(noPermission.json().error,"permission_forbidden");
  const noCsrf=await app.inject({method:"POST",url,payload,headers:{"x-test-permission":"yes","x-test-company":"yes"}});assert.equal(noCsrf.statusCode,403);assert.equal(noCsrf.json().error,"csrf_invalid");
  const wrongCompany=await app.inject({method:"POST",url,payload,headers:{"x-test-permission":"yes","x-csrf-token":"valid"}});assert.equal(wrongCompany.statusCode,403);assert.equal(wrongCompany.json().error,"company_scope_forbidden");
  assert.equal(queryCount,0);
});
