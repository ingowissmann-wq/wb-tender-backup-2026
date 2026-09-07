import test from 'node:test';
import assert from 'node:assert/strict';
import {SmtpEmailAdapter} from '../platform/saas-adapters.mjs';
import {deliverBookingEmail} from '../platform/saas-email-worker.mjs';

test('booking confirmation makes trial expiry and manual package renewal explicit',async()=>{
 const adapter=new SmtpEmailAdapter({host:'127.0.0.1',from:'sender@wb-test.invalid',verificationBaseUrl:'https://www.enwi.online'});
 const messages=[];adapter.transport={sendMail:async message=>{messages.push(message);return {accepted:[message.to],messageId:message.messageId};}};
 await adapter.sendBookingConfirmation({to:'test@wb-test.invalid',bookingId:'test-booking',purchaseKind:'TRIAL',planName:'14 Tage Komplettzugang',amountSubtotal:29900,billingPath:'AUTO_CARD',periodEnd:'2026-09-21T00:00:00Z'});
 assert.match(messages[0].text,/299,00/);assert.match(messages[0].text,/Keine automatische Verlängerung/);assert.match(messages[0].text,/keine Umwandlung/);
 for(const billingPath of ['INVOICE_BANK_TRANSFER','INVOICE_BILLIE']){
 await adapter.sendBookingConfirmation({to:'test@wb-test.invalid',bookingId:'test-'+billingPath,purchaseKind:'PACKAGE',planName:'Pro',amountSubtotal:349000,billingPath,periodEnd:'2026-10-07T00:00:00Z'});
 assert.match(messages.at(-1).text,/Weitere Monate buchen und bezahlen Sie gesondert/);
 assert.doesNotMatch(messages.at(-1).text,/monatlich per Karte/);
 }
});

test('dispatcher records SMTP failure for durable retry and acknowledges only accepted messages',async()=>{
 for(const succeeds of [false,true]){
 const completed=[];const item={id:'outbox-1',booking_id:'booking-1',recipient:'test@wb-test.invalid',lease_token:'lease-1',payload:{purchaseKind:'TRIAL'},attempts:1};
 const pool={query:async(sql,params)=>{if(sql==='SELECT * FROM saas.claim_booking_email()')return {rows:[item]};completed.push(params);return {rows:[{finished:true}]};}};
 const result=await deliverBookingEmail(pool,{sendBookingConfirmation:async()=>{if(!succeeds)throw new Error('SMTP synthetic error');}});
 assert.equal(result.delivered,succeeds);assert.deepEqual(completed,[['outbox-1','lease-1',succeeds]]);
 }
});
