import fs from "node:fs";
import Fastify from "fastify";
import pg from "pg";
import {registerAutopilotRoutes} from "../platform/autopilot-routes.mjs";
import {createFixedScopedPool,loadBackgroundScope} from "../platform/scoped-pg-pool.mjs";

const testRunId=String(process.env.CANARY_TEST_RUN_ID||"WB-TENDER-E2E-TEST-MANAGEMENT-INBOX-READONLY");
if(!/^WB-TENDER-E2E-TEST-[A-Za-z0-9_.:-]+$/.test(testRunId))throw new Error("CANARY_TEST_RUN_ID_invalid");
const connectionString=fs.readFileSync(process.env.DATABASE_URL_FILE||"/run/secrets/database_url","utf8").trim();
const rawPool=new pg.Pool({connectionString,max:4,options:"-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=3000"});
const backgroundScope=await loadBackgroundScope(rawPool),scopedPool=createFixedScopedPool(rawPool,backgroundScope).pool;
let capturedMainQuery=null;
const captureOnly=process.env.MANAGEMENT_INBOX_EXPLAIN_ONLY==="true";
const explainAnalyze=process.env.MANAGEMENT_INBOX_EXPLAIN_ANALYZE==="true";
const pool=captureOnly?{
  async query(sql,params=[]){
    if(String(sql).trimStart().startsWith("WITH active_scope AS")){capturedMainQuery={sql:String(sql),params};const error=new Error("management_inbox_query_captured");error.code="WB_CAPTURE_ONLY";throw error}
    return scopedPool.query(sql,params);
  },
  connect:(...args)=>scopedPool.connect(...args),
}:scopedPool;
const app=Fastify({logger:false}),identity={userId:"00000000-0000-4000-8000-000000000503",permissions:["tender.admin","tender.inbox.view"],companyIds:[],sectorSlugs:[]};
registerAutopilotRoutes(app,{pool,maintenancePool:pool,requirePermission:()=>async req=>{req.identity=identity},csrf:async()=>{},visibleTender:async()=>true,scanDocument:async()=>({status:"SCAN_ERROR"})});
const invoke=async query=>{const started=performance.now(),response=await app.inject({method:"GET",url:`/api/management-inbox?${new URLSearchParams(query)}`}),body=response.json();return{query,status:response.statusCode,durationMs:Math.round(performance.now()-started),error:body.error||null,retryAfter:response.headers["retry-after"]||null,total:Number(body.total||0),itemCount:Array.isArray(body.items)?body.items.length:null,selectedCompany:body.selectedCompany||null,companies:Array.isArray(body.companies)?body.companies.map(item=>({companyId:item.company_id,legalName:item.legal_name,serviceLine:item.service_line,tenantId:item.tenant_id})):[]}};
try{
  const initial=await invoke({company:"all",regionClass:"all",relevance:"relevant",serviceLine:"",page:"1",pageSize:"50"}),results=[initial];
  if(initial.status===200)for(const company of initial.companies)results.push(await invoke({company:company.companyId,regionClass:"all",relevance:"relevant",serviceLine:company.serviceLine,page:"1",pageSize:"50"}));
  let explain=null;
  if(capturedMainQuery){const plan=(await scopedPool.query(`EXPLAIN (${explainAnalyze?"ANALYZE TRUE, BUFFERS TRUE, TIMING TRUE,":""} FORMAT JSON, COSTS TRUE, VERBOSE FALSE) ${capturedMainQuery.sql}`,capturedMainQuery.params)).rows[0]["QUERY PLAN"][0],nodes=flattenPlan(plan.Plan).sort((left,right)=>(right.actualTime||right.totalCost)-(left.actualTime||left.totalCost)).slice(0,30);explain={analyze:explainAnalyze,querySha256:(await import("node:crypto")).createHash("sha256").update(capturedMainQuery.sql).digest("hex"),parameters:capturedMainQuery.params,planningTimeMs:plan["Planning Time"]||null,executionTimeMs:plan["Execution Time"]||null,root:summarizePlan(plan.Plan),hotspots:nodes}}
  console.log(JSON.stringify({TEST_ONLY:true,SYNTHETIC:true,testRunId,createdBy:"CODEX_AUTOMATED_TEST",purpose:"Read-only production route diagnosis for Management Inbox",status:captureOnly&&explain?"EXPLAIN_CAPTURED":results.every(item=>item.status===200)?"PASSED":"FAILED",readOnly:true,externalWrite:false,transmitted:false,backgroundScope:{tenantId:backgroundScope.tenantId,companyCount:backgroundScope.companyIds.length},results,explain},null,2));
}finally{await app.close();await rawPool.end()}

function summarizePlan(node){return{nodeType:node["Node Type"],relation:node["Relation Name"]||null,index:node["Index Name"]||null,joinType:node["Join Type"]||null,totalCost:node["Total Cost"],planRows:node["Plan Rows"],actualRows:node["Actual Rows"]??null,actualLoops:node["Actual Loops"]??null,actualTime:node["Actual Total Time"]??null,sharedHitBlocks:node["Shared Hit Blocks"]??null,sharedReadBlocks:node["Shared Read Blocks"]??null,filter:node.Filter||null,indexCondition:node["Index Cond"]||null,sortKey:node["Sort Key"]||null}}
function flattenPlan(node,path="0",rows=[]){rows.push({path,...summarizePlan(node)});for(const [index,child] of (node.Plans||[]).entries())flattenPlan(child,`${path}.${index}`,rows);return rows}
