import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import pg from 'pg';
import {SmtpEmailAdapter} from '../platform/saas-adapters.mjs';
import {deliverDispatchNotification} from '../platform/submission-dispatch-worker.mjs';
if(process.env.WB_TENDER_ISOLATION_TEST_DATABASE!=='true')throw new Error('isolated_submission_database_required');
const admin=new pg.Pool({host:'127.0.0.1',port:5432,user:'postgres',database:'postgres'}),worker=new pg.Pool({host:'127.0.0.1',port:5432,user:'postgres',database:'postgres',options:'-c role=tender_submission_worker_runtime'});
await admin.query("SELECT marker FROM public.wb_submission_isolated_database_marker WHERE marker='SUBMISSION_ISOLATED_TEST_ONLY'").then(r=>assert.equal(r.rowCount,1));
await test('durable notification is delivered through SMTP and marked sent only after acceptance',async()=>{
 let accepted=0,message='';const sockets=new Set();
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('220 fixture.invalid ESMTP\r\n');let buffered='',data=false;socket.on('data',chunk=>{buffered+=chunk.toString();while(buffered.includes('\r\n')){const index=buffered.indexOf('\r\n'),line=buffered.slice(0,index);buffered=buffered.slice(index+2);if(data){if(line==='.'){data=false;accepted++;socket.write('250 accepted\r\n')}else message+=line+'\n';continue}if(/^EHLO|^HELO/.test(line))socket.write('250 fixture.invalid\r\n');else if(/^MAIL FROM:|^RCPT TO:|^RSET/.test(line))socket.write('250 ok\r\n');else if(line==='DATA'){data=true;socket.write('354 send data\r\n')}else if(line==='QUIT'){socket.end('221 bye\r\n')}else socket.write('250 ok\r\n')}})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const email=new SmtpEmailAdapter({host:'127.0.0.1',port:server.address().port,secure:false,from:'fixture@submission.invalid',verificationBaseUrl:'https://wb-tender.com'});
 try{const before=Number((await admin.query("SELECT count(*) n FROM tender.submission_dispatch_notifications WHERE delivery_status='SENT'")).rows[0].n);assert.equal(await deliverDispatchNotification(worker,email),true);assert.equal(accepted,1);assert.match(message,/WB-Tender/);assert.doesNotMatch(message,/password|ciphertext|authorization/i);const after=Number((await admin.query("SELECT count(*) n FROM tender.submission_dispatch_notifications WHERE delivery_status='SENT'")).rows[0].n);assert.equal(after,before+1)}
 finally{email.transport.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))}
});
await worker.end();await admin.end();
