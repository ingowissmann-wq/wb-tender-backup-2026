import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {recoverLegacyCredential} from '../platform/submission-credential-recovery.mjs';
import {encryptSecret,decryptSecret} from '../platform/portal-credentials.mjs';
if(process.env.WB_TENDER_ISOLATION_TEST_DATABASE!=='true')throw new Error('isolated_submission_database_required');
const pool=new pg.Pool({host:'127.0.0.1',port:5432,user:'postgres',database:'postgres'});
await pool.query("SELECT marker FROM public.wb_submission_isolated_database_marker WHERE marker='SUBMISSION_ISOLATED_TEST_ONLY'").then(r=>assert.equal(r.rowCount,1));
await test('secure reentry preserves old ciphertext and bindings, verifies encrypted readback and rejects another company',async()=>{
 const id=()=>crypto.randomUUID(),tenant=id(),company=id(),profile=id(),actor=id(),portal=id(),oldId=id(),key=crypto.randomBytes(32),unavailableKey=crypto.randomBytes(32);
 const encrypted=encryptSecret({username:'old-fixture',password:'unavailable-fixture'},unavailableKey),secret={username:'reentered-fixture',password:crypto.randomBytes(32).toString('base64url')};
 const db=await pool.connect();let saved;
 try{
  await db.query('BEGIN');await db.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_user_id',$2,true),set_config('app.company_ids',$3,true),set_config('app.configuration_tenant_id',$1,true)",[tenant,actor,company]);
  await db.query("INSERT INTO iam.users(id,email,password_hash) VALUES($1,$2,'NON_LOGIN_FIXTURE')",[actor,actor+'@sandbox.invalid']);
  await db.query("INSERT INTO saas.tenants(id,slug,display_name,customer_identity_hash,status) VALUES($1,$2,'Recovery fixture',$3,'ACTIVE')",[tenant,tenant,tenant.replaceAll('-','').repeat(2)]);
  await db.query("INSERT INTO cms.business_units(id,code,name) VALUES($1,$2,'Recovery fixture')",[company,company]);
  await db.query("INSERT INTO tender.company_profiles(id,company_id,version,name) VALUES($1,$2,1,'Recovery fixture')",[profile,company]);
  await db.query("INSERT INTO tender.enterprise_company_links(company_id,tender_profile_id,legal_name,display_name,technical_key,slug,active,sector_status,discovery_status,matching_status,calculation_status,creation_source,configuration_version,applied_transaction_id) VALUES($1,$2,'Fixture','Fixture',$3,$3,true,'manual-sector-approval-required','BLOCKED','BLOCKED','BLOCKED','ISOLATED_TEST',2,$4)",[company,profile,company,id()]);
  await db.query('INSERT INTO saas.legacy_company_tenant_bindings(company_id,tenant_id,backfill_run_id) VALUES($1,$2,$3)',[company,tenant,id()]);
  await db.query('INSERT INTO tender.configuration_tenants(id,tenant_key) VALUES($1,$2)',[tenant,tenant]);
  await db.query("INSERT INTO tender.configuration_scopes(tenant_id,company_id,canonical_service,profile_id) VALUES($1,$2,'cleaning',$3)",[tenant,company,profile]);
  await db.query("INSERT INTO tender.portal_registry(id,display_name,canonical_domain) VALUES($1,'Recovery fixture',$2)",[portal,portal+'.invalid']);
  await db.query('INSERT INTO tender.portal_credential_secrets(id,portal_id,version,ciphertext,iv,auth_tag,key_version,read_only,created_by) VALUES($1,$2,1,$3,$4,$5,1,true,$6)',[oldId,portal,encrypted.ciphertext,encrypted.iv,encrypted.authTag,actor]);
  await db.query('INSERT INTO tender.portal_credential_companies(credential_id,company_id) VALUES($1,$2)',[oldId,company]);
  await assert.rejects(recoverLegacyCredential(db,{credentialId:oldId,companyId:id(),companyIds:[company],actorUserId:actor,...secret},key),/scope_changed/);
  saved=await recoverLegacyCredential(db,{credentialId:oldId,companyId:company,companyIds:[company],actorUserId:actor,...secret},key);assert.equal(saved.readbackVerified,true);
  const old=(await db.query('SELECT * FROM tender.portal_credential_secrets WHERE id=$1',[oldId])).rows[0];assert.deepEqual(old.ciphertext,encrypted.ciphertext);assert.equal(old.status,'REPLACED');
  const binding=(await db.query('SELECT * FROM tender.portal_credential_companies WHERE credential_id=$1',[oldId])).rows[0];assert.equal(binding.active,false);assert.equal(binding.replaced_by,saved.credentialId);
  assert.equal((await db.query('SELECT count(*)::int n FROM tender.submission_credential_recoveries WHERE previous_credential_id=$1 AND company_id=$2',[oldId,company])).rows[0].n,1);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
 // A new connection reads the committed ciphertext without any prior in-memory session.
 const fresh=await pool.connect();try{const row=(await fresh.query('SELECT * FROM tender.portal_credential_secrets WHERE id=$1',[saved.credentialId])).rows[0];assert.deepEqual(decryptSecret(row,key),secret);assert.equal(row.ciphertext.includes(Buffer.from(secret.password)),false);await assert.rejects(fresh.query('DELETE FROM tender.submission_credential_recoveries WHERE new_credential_id=$1',[saved.credentialId]),/immutable/)}finally{fresh.release()}
});
await pool.end();
