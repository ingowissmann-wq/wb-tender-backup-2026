import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { StripeBillingAdapter } from "../platform/saas-adapters.mjs";
import { TenantFilesystemStorage, safeDownloadName } from "../platform/tenant-storage.mjs";

const A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222";

test("tenant storage upload/download/list/delete is physically isolated across two tenants", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"wb-tenant-storage-"));
  try {
    const store=new TenantFilesystemStorage({root}),a=await store.put(A,Buffer.from("tenant-a")),b=await store.put(B,Buffer.from("tenant-b"));
    assert.equal((await store.get(A,a.objectId)).toString(),"tenant-a");
    assert.equal((await store.get(B,b.objectId)).toString(),"tenant-b");
    await assert.rejects(()=>store.get(B,a.objectId),/ENOENT/);
    assert.deepEqual(await store.listPhysical(A),[a.objectId]); assert.deepEqual(await store.listPhysical(B),[b.objectId]);
    await store.delete(B,a.objectId); assert.deepEqual(await store.listPhysical(A),[a.objectId]);
    await store.delete(A,a.objectId); assert.deepEqual(await store.listPhysical(A),[]);
    assert.throws(()=>store.objectPath(A,"../../etc/passwd"),/storage_object_id_invalid/);
    assert.equal(safeDownloadName('../../secret\r\n".pdf').includes('/'),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("Stripe adapter rejects unpaid and unsigned events and accepts paid signed event", () => {
  const now=1_800_000_000_000, secret="whsec_test_test_test_test_test_test";
  const adapter=new StripeBillingAdapter({secretKey:"sk_test_placeholder",webhookSecret:secret,publicBaseUrl:"https://suite.example.invalid",priceIds:{CORE:"price_Core123"},now:()=>now});
  const event={id:"evt_paid",type:"checkout.session.completed",data:{object:{id:"cs_test",mode:"subscription",payment_status:"paid",client_reference_id:A,customer:"cus_test",subscription:"sub_test"}}};
  const raw=Buffer.from(JSON.stringify(event)),timestamp=Math.floor(now/1000),signature=crypto.createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest('hex');
  assert.equal(adapter.verifyWebhook(raw,`t=${timestamp},v1=${signature}`).type,"payment.confirmed");
  assert.throws(()=>adapter.verifyWebhook(raw,`t=${timestamp},v1=00`),/signature_invalid/);
  event.data.object.payment_status="unpaid"; const unpaid=Buffer.from(JSON.stringify(event)),unpaidSig=crypto.createHmac('sha256',secret).update(`${timestamp}.`).update(unpaid).digest('hex');
  assert.throws(()=>adapter.verifyWebhook(unpaid,`t=${timestamp},v1=${unpaidSig}`),/unsupported_or_unpaid/);
});

test("migration provides real CSM, People, Docs audit and tenant IAM with forced RLS", async () => {
  const sql=await readFile(new URL('../migrations/085_business_suite_trial_data_plane.sql',import.meta.url),'utf8');
  for(const table of ['csm_interactions','csm_service_cases','csm_tasks','people_onboarding_tasks','people_document_refs','people_absence_requests','storage_audit','tenant_invitations']) assert.match(sql,new RegExp(table));
  assert.match(sql,/FORCE ROW LEVEL SECURITY/); assert.match(sql,/saas\.tenant_matches\(tenant_id\)/);
  assert.doesNotMatch(sql,/career-data|wb-cms\.sqlite|recruiting\.application/i);
  const rollback=await readFile(new URL('../deployment/rollback-business-suite-trial-data-plane.sql',import.meta.url),'utf8');
  assert.match(rollback,/rollback_refused_customer_lifecycle_exists/);
});

test("tenant portal exposes guarded CSM, People, Docs and Control flows", async () => {
  const routes=await readFile(new URL('../platform/tenant-portal.mjs',import.meta.url),'utf8');
  for(const route of ['csm/customers','people/employees','modules/docs/files','control/members','control/invitations']) assert.match(routes,new RegExp(route));
  assert.match(routes,/requireSaasModule\(MODULE_KEYS\.CSM\)/); assert.match(routes,/tenantAdmin/); assert.match(routes,/tenantOwner/);
});
