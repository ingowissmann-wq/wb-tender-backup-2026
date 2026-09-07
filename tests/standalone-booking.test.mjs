import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { bookingContract, BOOKING_TERMS_VERSION, nextBillingPeriod } from '../platform/saas-booking.mjs';
import { applyBillingEvent } from '../platform/saas-platform.mjs';
import { effectiveAccess } from '../platform/saas-catalog.mjs';
const tenant='11111111-1111-4111-8111-111111111111', booking='22222222-2222-4222-8222-222222222222';
const now=new Date('2026-09-07T12:00:00Z');
const terms={consentVersion:BOOKING_TERMS_VERSION,bookingConfirmed:true,billingPath:'AUTO_CARD'};
test('booking rejects missing consent, free-form plans, subscription trials and SEPA',()=>{
  for(const input of [
    {...terms,plan:'TRIAL'},
    {...terms,purchaseKind:'TRIAL',plan:'NORMAL'},
    {...terms,purchaseKind:'PACKAGE',plan:'TRIAL'},
    {...terms,purchaseKind:'TRIAL',plan:'TRIAL',bookingConfirmed:false},
    {...terms,purchaseKind:'TRIAL',plan:'TRIAL',billingPath:'SEPA'},
    {...terms,purchaseKind:'TRIAL',plan:'TRIAL',renewal:true},
  ])assert.throws(()=>bookingContract(input),/billing_/);
  assert.equal(bookingContract({...terms,purchaseKind:'TRIAL',plan:'TRIAL'}).amountSubtotal,29900);
  for(const [plan,amount] of [['NORMAL',349000],['PROFESSIONAL',639000],['ENTERPRISE',1239000]])assert.equal(bookingContract({...terms,purchaseKind:'PACKAGE',plan}).amountSubtotal,amount);
  assert.equal(bookingContract({...terms,purchaseKind:'PACKAGE',plan:'NORMAL',billingPath:'INVOICE_BILLIE',renewal:true}).amountSubtotal,99000);
});
function fixture({kind='TRIAL',checkoutStatus='CREATED',duplicate=false,currentKind=null,currentStatus='PENDING_PAYMENT'}={}){
  const queries=[];
  const current={plan_code:'ENTERPRISE',status:currentStatus,purchase_kind:currentKind};
  const checkout={purchase_kind:kind,plan_code:kind==='TRIAL'?'ENTERPRISE':'NORMAL',booking_id:booking,billing_path:'AUTO_CARD',consent_version:BOOKING_TERMS_VERSION,consented_at:now,amount_subtotal:kind==='TRIAL'?29900:349000,status:checkoutStatus,renewal:false};
  return {queries,current,checkout,async query(sql,args=[]){
    queries.push([sql,args]);
    if(sql.startsWith('INSERT INTO saas.billing_events'))return{rowCount:duplicate?0:1,rows:[]};
    if(sql.startsWith('SELECT * FROM saas.subscriptions'))return{rows:[current]};
    if(sql.startsWith('SELECT * FROM saas.checkout_sessions'))return{rows:[checkout]};
    if(sql.startsWith('SELECT email_verified_at'))return{rows:[{email_verified_at:now,iam_provisioned_at:now}]};
    if(sql.startsWith('SELECT iam_provisioned_at'))return{rows:[{iam_provisioned_at:now}]};
    if(sql.startsWith('SELECT customer_identity_hash'))return{rows:[{customer_identity_hash:'synthetic'}]};
    if(sql.startsWith('SELECT code,position'))return{rows:[{code:'ENTERPRISE',position:3,seat_limit:null,company_limit:null},{code:'NORMAL',position:1,seat_limit:3,company_limit:1}]};
    if(sql.startsWith('SELECT (SELECT count'))return{rows:[{seats:1,companies:1}]};
    return{rowCount:1,rows:[]};
  }};
}
function event(kind='TRIAL') { return {provider:'stripe',id:'evt_synthetic',type:'payment.confirmed',tenantId:tenant,checkoutRef:'cs_synthetic',bookingId:booking,purchaseKind:kind,billingPath:'AUTO_CARD',plan:kind==='TRIAL'?'TRIAL':'NORMAL',amountSubtotal:kind==='TRIAL'?29900:349000,subscriptionRef:kind==='TRIAL'?null:'sub_synthetic',customerRef:'cus_synthetic'}; }
test('paid trial starts exactly 14 days and cannot be activated by a package event',async()=>{
  const db=fixture();assert.equal((await applyBillingEvent(db,event(),Buffer.from('{}'),now)).status,'TRIAL_ACTIVE');
  const update=db.queries.find(([q])=>q.startsWith('UPDATE saas.subscriptions SET status'))[1];
  assert.equal(update[3].getTime()-update[2].getTime(),14*86400000);
  assert.equal(effectiveAccess({status:'TRIAL_ACTIVE',trial_ends_at:update[3]},update[3]).allowed,false);
  for(const change of [{purchaseKind:'PACKAGE'},{subscriptionRef:'sub_wrong'},{plan:'NORMAL'},{amountSubtotal:1},{bookingId:tenant}]){
    const wrong=fixture();await assert.rejects(applyBillingEvent(wrong,{...event(),...change},'{}',now),/checkout_session_not_bound|billing_trial_contract_invalid/);
    assert.equal(wrong.queries.at(-1)[0],'ROLLBACK');
    assert.ok(!wrong.queries.some(([q])=>q.startsWith('UPDATE saas.subscriptions')));
  }
});
test('direct and post-trial package bookings activate only their own paid package and never claim a trial',async()=>{
  for(const status of ['PENDING_PAYMENT','TRIAL_ACTIVE','TRIAL_EXPIRED']){
    const db=fixture({kind:'PACKAGE',currentStatus:status,currentKind:status==='PENDING_PAYMENT'?null:'TRIAL'});
    assert.equal((await applyBillingEvent(db,event('PACKAGE'),'{}',now)).status,'ACTIVE');
    assert.ok(!db.queries.some(([q])=>q.startsWith('INSERT INTO saas.trial_claims')));
    assert.equal(db.queries.find(([q])=>q.startsWith('UPDATE saas.subscriptions SET status'))[1][9],'NORMAL');
    assert.equal(db.queries.find(([q])=>q.startsWith('UPDATE saas.subscriptions SET current_period'))[1][1].toISOString(),'2026-10-07T12:00:00.000Z');
  }
  await assert.rejects(applyBillingEvent(fixture({kind:'PACKAGE'}),event(),'{}',now),/checkout_session_not_bound/);
});
test('duplicate events and different events for the same checkout never activate twice',async()=>{
  for(const config of [{duplicate:true},{checkoutStatus:'PAYMENT_CONFIRMED'}]){
    const db=fixture(config);assert.equal((await applyBillingEvent(db,event(),'{}',now)).idempotent,true);
    assert.ok(!db.queries.some(([q])=>q.startsWith('UPDATE saas.subscriptions')));
  }
});
test('invoice events alone cannot convert a trial into a package',async()=>{
  const db=fixture({currentKind:'TRIAL',currentStatus:'TRIAL_ACTIVE'});
  await assert.rejects(applyBillingEvent(db,{...event('PACKAGE'),type:'invoice.paid'},'{}',now),/billing_separate_package_required/);
  assert.equal(db.queries.at(-1)[0],'ROLLBACK');
});
test('one manually booked month handles month-end dates without spilling into another month',()=>{
  assert.equal(nextBillingPeriod('2026-01-31T12:00:00Z').toISOString(),'2026-02-28T12:00:00.000Z');
});
test('commercial gate supports native authentication and file peppers without fictitious OIDC',()=>{
  const env={PATH:process.env.PATH,WB_TENDER_SAAS_ENABLED:'true',SAAS_IAM_ADAPTER:'native',SAAS_BILLING_ADAPTER:'stripe',SAAS_BILLING_PROVIDER:'stripe',SAAS_EMAIL_ADAPTER:'smtp',SAAS_EMAIL_PROVIDER:'smtp',WB_TENDER_TENANT_STORAGE_ADAPTER:'filesystem'};
  for(const name of ['WB_TENDER_TENANT_ISOLATION_VERIFIED','WB_TENDER_WB_BACKFILL_VERIFIED','WB_ADMIN_SAAS_ENABLED','WB_ADMIN_TENANCY_ENFORCED','WB_ADMIN_REAL_MODULE_ISOLATION_VERIFIED','WB_TENDER_LEGAL_APPROVED','WB_TENDER_COMMERCIAL_PRICES_APPROVED'])env[name]='true';
  for(const name of ['WB_TENDER_RUNTIME_DB_ROLE','STRIPE_PRICE_NORMAL','STRIPE_PRICE_PROFESSIONAL','STRIPE_PRICE_ENTERPRISE','STRIPE_PRICE_ACTIVATION','STRIPE_PRICE_SETUP_NORMAL','STRIPE_PRICE_SETUP_PROFESSIONAL','STRIPE_PRICE_SETUP_ENTERPRISE','WB_TENDER_PUBLIC_BASE_URL','WB_TENDER_TERMS_URL','WB_TENDER_PRIVACY_URL','WB_TENDER_IMPRINT_URL','WB_TENDER_DPA_URL'])env[name]='synthetic_configuration';
  for(const name of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SAAS_VERIFICATION_PEPPER','SAAS_INVITATION_PEPPER','SAAS_SMTP_HOST','SAAS_SMTP_PORT','SAAS_SMTP_SECURE','SAAS_SMTP_USER','SAAS_SMTP_PASSWORD','SAAS_SMTP_FROM'])env[name+'_FILE']='/run/secrets/synthetic';
  const output=execFileSync(process.execPath,['scripts/saas-commercial-readiness-gate.mjs'],{env,encoding:'utf8'});assert.equal(JSON.parse(output).passed,true);
  assert.throws(()=>execFileSync(process.execPath,['scripts/saas-commercial-readiness-gate.mjs'],{env:{...env,SAAS_INVITATION_PEPPER:'inline-forbidden'},stdio:'pipe'}));
});
