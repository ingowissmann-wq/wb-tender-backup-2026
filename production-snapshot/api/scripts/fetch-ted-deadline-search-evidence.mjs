import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tedSearchDeadlineEvidence } from "../platform/tender-deadlines.mjs";

const inputPath=process.env.TED_DEADLINE_NOTICE_FILE,outputPath=process.env.NOTICE_DEADLINE_EVIDENCE_FILE,ambiguousPath=process.env.TED_AMBIGUOUS_NOTICE_FILE;
if(!inputPath||!outputPath||!ambiguousPath)throw new Error("TED_DEADLINE_NOTICE_FILE, NOTICE_DEADLINE_EVIDENCE_FILE and TED_AMBIGUOUS_NOTICE_FILE are required");
const input=JSON.parse(readFileSync(inputPath,"utf8")),wanted=new Map(input.map(item=>[item.externalId,item]));
const sha256=value=>crypto.createHash("sha256").update(value).digest("hex"),results=[],ambiguous=[];
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function post(body){for(let attempt=0;attempt<7;attempt++){const response=await fetch("https://api.ted.europa.eu/v3/notices/search",{method:"POST",headers:{"content-type":"application/json",accept:"application/json","user-agent":"WB-Tender-Lifecycle-ReadOnly-Evidence/1.0"},body:JSON.stringify(body),signal:AbortSignal.timeout(60_000)});if(response.ok)return response;if(response.status!==429&&response.status<500)throw new Error(`TED search HTTP ${response.status}`);const retry=Number(response.headers.get("retry-after")||0);await sleep(Math.max(1000,retry*1000,1000*(2**attempt)))}throw new Error("TED search retries exhausted")}
let token=null,pages=0,total=0;
do{
  const body={query:"deadline-receipt-tender-date-lot >= 20260820 AND place-of-performance IN (DE*)",fields:["publication-number","identifier-lot","deadline-receipt-tender-date-lot","deadline-receipt-tender-time-lot","procedure-identifier","notice-version"],limit:250,scope:"ALL",checkQuerySyntax:false,paginationMode:"ITERATION",...(token?{iterationNextToken:token}:{})};
  const response=await post(body);
  const bytes=Buffer.from(await response.arrayBuffer()),payload=JSON.parse(bytes.toString("utf8")),pageSha=sha256(bytes);pages++;
  for(const raw of payload.notices||[]){const id=String(raw["publication-number"]||"");if(!wanted.has(id))continue;const meta=wanted.get(id),deadlines=tedSearchDeadlineEvidence(raw,{sourceNoticeId:id,procedureIdentifier:raw["procedure-identifier"]||meta.procedureIdentifier||null,sourceTimestamp:meta.sourceTimestamp||null,sourceVersion:String(raw["notice-version"]||meta.sourceVersion||"")||null});const item={sourceCode:"TED",externalId:id,sourceUrl:`https://api.ted.europa.eu/v3/notices/search`,apiPageSha256:pageSha,sourceTimestamp:meta.sourceTimestamp||null,sourceVersion:String(raw["notice-version"]||meta.sourceVersion||"")||null,deadlines};if(deadlines.length&&deadlines.every(deadline=>deadline.parsingStatus==="EXACT"&&deadline.lotKey))results.push(item);else ambiguous.push({...meta,searchEvidence:item});total++}
  token=payload.notices?.length?payload.iterationNextToken||null:null;
  process.stderr.write(`page ${pages}, matched ${total}\n`);
  await sleep(300);
}while(token);
results.sort((a,b)=>a.externalId.localeCompare(b.externalId));ambiguous.sort((a,b)=>a.externalId.localeCompare(b.externalId));
writeFileSync(outputPath,`${JSON.stringify(results,null,2)}\n`,{flag:"wx",mode:0o600});writeFileSync(ambiguousPath,`${JSON.stringify(ambiguous,null,2)}\n`,{flag:"wx",mode:0o600});
console.log(JSON.stringify({mode:"READ_ONLY_TED_SEARCH_EVIDENCE",pages,matched:total,exact:results.length,ambiguous:ambiguous.length,notReturned:wanted.size-total,evidenceSha256:sha256(JSON.stringify(results)),ambiguousSha256:sha256(JSON.stringify(ambiguous))}));
