import fs from "node:fs";
import pg from "pg";
import { recoverStoredParserFailures } from "../platform/autopilot-pipeline-worker.mjs";

const connectionString =
  process.env.DATABASE_URL ||
  fs.readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim();
const apply = process.env.APPLY_PARSER_RECOVERY === "true";
const client = new pg.Client({
  connectionString,
  options: process.env.DATABASE_SESSION_OPTIONS || undefined,
});

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('wb-parser-recovery',0))");
  const transmittedBefore = Number((await client.query(`SELECT count(*) count FROM tender.final_preflight_contexts WHERE transmitted IS TRUE`)).rows[0].count);
  const summary = await recoverStoredParserFailures(client,null,{safeRelevantOnly:true});
  const remaining = Number((await client.query(`SELECT count(*) count FROM tender.enrichment_documents
    WHERE procurement_relevant AND tender_association_verified AND magic_bytes_verified
      AND EXISTS(SELECT 1 FROM tender.document_malware_scans scan
        WHERE scan.document_id=enrichment_documents.id
          AND scan.payload_sha256=enrichment_documents.payload_sha256 AND scan.status='CLEAN')
      AND (fetch_status='PARSER_FEHLER' OR extracted_data ? 'error')`)).rows[0].count);
  const transmittedAfter = Number((await client.query(`SELECT count(*) count FROM tender.final_preflight_contexts WHERE transmitted IS TRUE`)).rows[0].count);
  if(summary.failed||summary.hashMismatch||remaining||transmittedBefore||transmittedAfter)
    throw new Error(`parser_recovery_gate_failed:${JSON.stringify({summary,remaining,transmittedBefore,transmittedAfter})}`);
  if(apply)await client.query("COMMIT");else await client.query("ROLLBACK");
  console.log(JSON.stringify({passed:true,mode:apply?"APPLIED":"DRY_RUN_ROLLED_BACK",summary,remaining,externalSubmission:false,transmitted:false},null,2));
} catch(error) {
  await client.query("ROLLBACK").catch(()=>{});
  throw error;
} finally {
  await client.end();
}
