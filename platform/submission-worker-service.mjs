import {submissionRuntimePolicy,assertSubmissionSchema} from './submission-runtime-policy.mjs';
import {readFileSync,fstatSync,constants,openSync,closeSync} from 'node:fs';
import {createServer} from 'node:http';
import pg from 'pg';
import {PostgresDispatchStore} from './submission-dispatch-store.mjs';
import {executeDispatch,productionDispatchGate,deliverDispatchNotification} from './submission-dispatch-worker.mjs';
import {TenantFilesystemStorage} from './tenant-storage.mjs';
import {SmtpEmailAdapter} from './saas-adapters.mjs';

function secret(name){
 if(process.env[name])throw new Error('inline_secret_forbidden');const file=process.env[name+'_FILE'];if(!file)throw new Error('secret_file_required');
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||(stat.mode&0o007))throw new Error('secret_file_permissions_invalid');return readFileSync(fd,'utf8').trim();}finally{closeSync(fd)}
}
submissionRuntimePolicy();
const pool=new pg.Pool({connectionString:secret('SUBMISSION_DATABASE_URL'),max:3,application_name:'wb-submission-worker'});
await assertSubmissionSchema(pool);
const store=new PostgresDispatchStore(pool,{workerId:process.env.SUBMISSION_WORKER_ID||'wb-tender-submission-worker'}),storage=new TenantFilesystemStorage({root:process.env.WB_TENDER_TENANT_STORAGE_ROOT});
const email=new SmtpEmailAdapter({host:secret('SAAS_SMTP_HOST'),port:secret('SAAS_SMTP_PORT'),secure:secret('SAAS_SMTP_SECURE')==='true',user:secret('SAAS_SMTP_USER'),password:secret('SAAS_SMTP_PASSWORD'),from:secret('SAAS_SMTP_FROM'),verificationBaseUrl:process.env.SAAS_PUBLIC_BASE_URL});
const credentialFiles={keyringFile:process.env.SAAS_PORTAL_CREDENTIAL_KEYRING_FILE,legacyKeyFile:process.env.PORTAL_CREDENTIAL_KEY_FILE};
let stopping=false,lastHealthy=0,lastError=null,metrics={};
process.once('SIGTERM',()=>{stopping=true});process.once('SIGINT',()=>{stopping=true});
const server=createServer((req,res)=>{if(!['/health','/healthz'].includes(req.url)){res.writeHead(404);res.end();return}const ready=!stopping&&!lastError&&Date.now()-lastHealthy<60000;res.writeHead(ready?200:503,{'content-type':'application/json'});res.end(JSON.stringify({status:ready?'ok':'unavailable',component:'submission-worker',sourceCommit:process.env.RELEASE_COMMIT,externalSubmissionEnabled:process.env.EXTERNAL_SUBMISSION_ENABLED==='true',lastError,metrics}));});
await new Promise(resolve=>server.listen(Number(process.env.PORT||4241),'0.0.0.0',resolve));
const healthTimer=setInterval(async()=>{try{await pool.query('INSERT INTO tender.submission_worker_heartbeats(worker_id,source_commit,observed_at,last_error) VALUES($1,$2,now(),$3) ON CONFLICT(worker_id) DO UPDATE SET observed_at=excluded.observed_at,last_error=excluded.last_error',[store.workerId,process.env.RELEASE_COMMIT||'unknown',lastError]);metrics=(await pool.query('SELECT tender.submission_monitor_snapshot() snapshot')).rows[0].snapshot;lastHealthy=Date.now();}catch{lastError='submission_worker_database_unavailable'}},10000);healthTimer.unref();
try{
 await pool.query('SELECT 1');lastHealthy=Date.now();
 while(!stopping){
  try{
   await deliverDispatchNotification(pool,email);
   if(process.env.EXTERNAL_SUBMISSION_ENABLED==='true'&&process.env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION==='true'){
    const claim=await store.claim();if(claim){await executeDispatch(claim,{storage,credentialFiles,operationalGate:async(db,row)=>{if(stopping)throw new Error('submission_worker_stopping');return productionDispatchGate(db,row)}});continue;}
   }
   lastError=null;
  }catch{lastError='submission_worker_operation_failed'}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
}finally{clearInterval(healthTimer);email.transport.close();await pool.end();await new Promise(resolve=>server.close(resolve));}
