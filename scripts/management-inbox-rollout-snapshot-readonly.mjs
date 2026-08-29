import fs from "node:fs";
import pg from "pg";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const connectionString=fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:1,options:"-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=3000"});
const scope=await loadBackgroundScope(rawPool),pool=createFixedScopedPool(rawPool,scope).pool,client=await pool.connect();
const query=async(sql,params=[])=>(await client.query(sql,params)).rows;
try{
  await client.query("BEGIN READ ONLY");
  const [runtimeSettings,queueByStatus,queueByAction,queueHealth,scheduler,coreCounts,transmittedColumns]=await Promise.all([
    query("SELECT external_submission_enabled,allow_external_submission,global_kill_switch FROM tender.submission_runtime_settings"),
    query("SELECT status,count(*)::int count,min(created_at) oldest_created_at,max(coalesce(finished_at,heartbeat_at,started_at,created_at)) latest_activity_at FROM tender.autopilot_queue GROUP BY status ORDER BY status"),
    query("SELECT action_type,status,count(*)::int count FROM tender.autopilot_queue GROUP BY action_type,status ORDER BY action_type,status"),
    query(`SELECT count(*) FILTER(WHERE status IN('QUEUED','RETRY'))::int waiting,
      count(*) FILTER(WHERE status='RUNNING')::int running,
      count(*) FILTER(WHERE status='RUNNING' AND coalesce(heartbeat_at,started_at,created_at)<now()-interval '15 minutes')::int stale_running,
      count(*) FILTER(WHERE status IN('FAILED','DEAD_LETTER'))::int terminal_failures,
      count(*) FILTER(WHERE status IN('FAILED','DEAD_LETTER') AND coalesce(finished_at,heartbeat_at,started_at,created_at)>now()-interval '15 minutes')::int recent_terminal_failures
      FROM tender.autopilot_queue`),
    query(`SELECT source_code,enabled,kill_switch,last_success_at,last_failure_at,next_run_at
      FROM tender.scheduler_sources ORDER BY source_code`),
    query(`SELECT
      (SELECT count(*) FROM tender.tenders)::int tenders,
      (SELECT count(*) FROM tender.service_relevance_evaluations)::int relevance_evaluations,
      (SELECT count(*) FROM tender.region_evaluations)::int region_evaluations,
      (SELECT count(*) FROM tender.autopilot_queue)::int queue_rows,
      (SELECT count(*) FROM tender.submission_contexts)::int submission_contexts,
      (SELECT count(*) FROM tender.submission_receipts)::int submission_receipts`),
    query(`SELECT table_name FROM information_schema.columns
      WHERE table_schema='tender' AND column_name='transmitted' ORDER BY table_name`),
  ]);
  const transmitted={};
  for(const {table_name} of transmittedColumns)transmitted[table_name]=Number((await query(`SELECT count(*) count FROM tender.${table_name} WHERE transmitted IS TRUE`))[0].count);
  await client.query("ROLLBACK");
  const result={schema:"wb-tender/management-inbox-rollout-snapshot/1.0.0",capturedAt:new Date().toISOString(),transaction:"READ_ONLY_ROLLED_BACK",scope:{companyCount:scope.companyIds.length},runtimeSettings:runtimeSettings[0]||null,queueByStatus,queueByAction,queueHealth:queueHealth[0],scheduler,coreCounts:coreCounts[0],transmitted,externalWrite:false};
  const output=JSON.stringify(result,null,2);console.log(output);
  if(process.env.SNAPSHOT_OUTPUT)fs.writeFileSync(process.env.SNAPSHOT_OUTPUT,`${output}\n`,{mode:0o600});
}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}finally{client.release();await rawPool.end()}
