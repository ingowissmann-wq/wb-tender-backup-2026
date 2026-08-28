import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const paths=String(process.env.TED_DEADLINE_EVIDENCE_INPUTS||"").split(",").map(value=>value.trim()).filter(Boolean),output=process.env.NOTICE_DEADLINE_EVIDENCE_FILE;
if(!paths.length||!output)throw new Error("TED_DEADLINE_EVIDENCE_INPUTS and NOTICE_DEADLINE_EVIDENCE_FILE are required");
const byNotice=new Map();for(const path of paths)for(const item of JSON.parse(readFileSync(path,"utf8"))){const key=`${item.sourceCode}:${item.externalId}`;if(byNotice.has(key))throw new Error(`duplicate deadline evidence: ${key}`);byNotice.set(key,item)}
const rows=[...byNotice.values()].sort((a,b)=>`${a.sourceCode}:${a.externalId}`.localeCompare(`${b.sourceCode}:${b.externalId}`)),json=JSON.stringify(rows,null,2),sha256=crypto.createHash("sha256").update(json).digest("hex");
writeFileSync(output,`${json}\n`,{flag:"wx",mode:0o600});
console.log(JSON.stringify({mode:"MERGE_READ_ONLY_EVIDENCE",rows:rows.length,exactDeadlineRecords:rows.flatMap(row=>row.deadlines||[]).filter(row=>row.parsingStatus==="EXACT").length,failedSources:rows.filter(row=>row.fetchStatus==="FAILED").length,sha256}));
