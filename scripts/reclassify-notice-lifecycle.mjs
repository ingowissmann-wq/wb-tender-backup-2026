import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { buildLifecyclePlan, canonicalJson, loadLifecycleRows } from "../platform/lifecycle-plan.mjs";

const apply = process.argv.includes("--apply"), configuredAsOf = process.env.NOTICE_LIFECYCLE_AS_OF || null;
if (apply && !configuredAsOf) throw new Error("NOTICE_LIFECYCLE_AS_OF is required for a deterministic apply plan");
const asOf = configuredAsOf ? new Date(configuredAsOf) : new Date();
if (Number.isNaN(asOf.getTime())) throw new Error("NOTICE_LIFECYCLE_AS_OF must be a valid ISO-8601 timestamp");
const readJson = (path) => path ? JSON.parse(readFileSync(path, "utf8")) : [];
const relationEvidence = readJson(process.env.NOTICE_RELATION_EVIDENCE_FILE);
const deadlineEvidence = readJson(process.env.NOTICE_DEADLINE_EVIDENCE_FILE);
const connectionString = process.env.DATABASE_URL || readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
const pool = new pg.Pool({ connectionString, max: 1 }), client = await pool.connect();
const runId = process.env.NOTICE_LIFECYCLE_CORRECTION_RUN_ID || "";
const changed = (row) => row.fromLifecycle !== row.toLifecycle || row.fromParticipation !== row.toParticipation || row.fromClassification !== row.classification || row.fromDeadline !== row.deadlineTo || row.lots.length > 0 || row.deadlineEvidence.length > 0 || row.relations.length > 0;
let idempotentApply = false;
try {
  await client.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
  if (apply) {
    if (process.env.NOTICE_LIFECYCLE_WRITE_APPROVED !== "true") throw new Error("NOTICE_LIFECYCLE_WRITE_APPROVED=true is required");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error("valid NOTICE_LIFECYCLE_CORRECTION_RUN_ID is required");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30min'");
  }
  const sourceRows = await loadLifecycleRows(client);
  const plan = buildLifecyclePlan(sourceRows, { asOf, relationEvidence, deadlineEvidence });
  const changes = plan.rows.filter(changed);
  if (process.env.NOTICE_PLAN_MANIFEST_FILE) writeFileSync(process.env.NOTICE_PLAN_MANIFEST_FILE, canonicalJson(plan.planDocument), { flag: "wx", mode: 0o600 });
  if (apply) {
    const priorRun = (await client.query("SELECT run_id,status,plan_sha256 FROM tender.notice_lifecycle_correction_runs WHERE run_id=$1", [runId])).rows[0];
    if (priorRun) {
      const stored = (await client.query("SELECT input_sha256 FROM tender.notice_lifecycle_correction_runs WHERE run_id=$1", [runId])).rows[0];
      const conflicts = Number((await client.query(`SELECT count(*) count FROM tender.notice_lifecycle_correction_rows c JOIN tender.tenders t ON t.id=c.tender_id WHERE c.run_id=$1 AND (t.source_lifecycle_status IS DISTINCT FROM c.applied_tender->>'source_lifecycle_status' OR t.participation_status IS DISTINCT FROM c.applied_tender->>'participation_status' OR t.notice_classification IS DISTINCT FROM c.applied_tender->>'notice_classification' OR t.offer_deadline IS DISTINCT FROM nullif(c.applied_tender->>'offer_deadline','')::timestamptz)`, [runId])).rows[0].count);
      if (priorRun.plan_sha256 === process.env.EXPECTED_PLAN_SHA256 && priorRun.status === "APPLIED" && stored.input_sha256 === plan.inputSha256 && conflicts === 0) {
        await client.query("ROLLBACK");
        console.log(JSON.stringify({ mode: "APPLY", idempotent: true, runId, planSha256: priorRun.plan_sha256, inputSha256: plan.inputSha256, conflicts: 0 }));
        idempotentApply = true;
      } else throw new Error("correction run id already exists with a different state");
    } else {
      if (process.env.EXPECTED_PLAN_SHA256 !== plan.planSha256) throw new Error(`plan hash mismatch; expected ${process.env.EXPECTED_PLAN_SHA256 || "missing"}, observed ${plan.planSha256}`);
      await client.query("CREATE TEMP TABLE lifecycle_plan_stage(id uuid PRIMARY KEY,plan jsonb NOT NULL) ON COMMIT DROP");
      for (let offset = 0; offset < plan.rows.length; offset += 500) {
        const batch = plan.rows.slice(offset, offset + 500).map((row) => ({ id: row.id, plan: row }));
        await client.query("INSERT INTO lifecycle_plan_stage SELECT id,plan FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,plan jsonb)", [JSON.stringify(batch)]);
      }
      const transitionCount = plan.rows.reduce((total, row) => total + Number(row.fromLifecycle !== row.toLifecycle || row.fromParticipation !== row.toParticipation) + row.lots.length, 0);
      await client.query(`INSERT INTO tender.notice_lifecycle_correction_runs(run_id,plan_sha256,input_sha256,status,planned_row_count,lifecycle_transition_count,plan_document,as_of)
        VALUES($1,$2,$3,'PREPARED',$4,$5,$6::jsonb,$7)`, [runId, plan.planSha256, plan.inputSha256, changes.length, transitionCount, canonicalJson(plan.planDocument), asOf]);
      await client.query(`INSERT INTO tender.notice_lifecycle_correction_rows(run_id,tender_id,previous_tender,previous_deadline_evidence,previous_lot_lifecycles,previous_relationships,applied_tender,applied_deadline_evidence,applied_lot_lifecycles,applied_relationships,row_plan_sha256)
        SELECT $1,t.id,
          jsonb_build_object('source_lifecycle_status',t.source_lifecycle_status,'participation_status',t.participation_status,'notice_classification',t.notice_classification,'participation_block_reason',t.participation_block_reason,'offer_deadline',t.offer_deadline,'notice_type_code',t.notice_type_code,'notice_subtype',t.notice_subtype,'notice_form_type',t.notice_form_type,'procedure_identifier',t.procedure_identifier),
          coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM tender.tender_deadline_evidence e WHERE e.tender_id=t.id),'[]'::jsonb),
          coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM tender.tender_lot_lifecycles l WHERE l.tender_id=t.id),'[]'::jsonb),
          coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM tender.tender_notice_relationships r WHERE r.source_tender_id=t.id),'[]'::jsonb),
          jsonb_build_object('source_lifecycle_status',s.plan->>'toLifecycle','participation_status',s.plan->>'toParticipation','notice_classification',s.plan->>'classification','participation_block_reason',s.plan->>'reason','offer_deadline',s.plan->>'deadlineTo','notice_type_code',s.plan->>'noticeType','notice_subtype',s.plan->>'noticeSubtype','notice_form_type',s.plan->>'formType','procedure_identifier',s.plan->>'procedureIdentifier'),
          s.plan->'deadlineEvidence',s.plan->'lots',s.plan->'relations',s.plan->>'rowPlanSha256'
        FROM lifecycle_plan_stage s JOIN tender.tenders t ON t.id=s.id
        WHERE t.source_lifecycle_status IS DISTINCT FROM s.plan->>'toLifecycle' OR t.participation_status IS DISTINCT FROM s.plan->>'toParticipation'
          OR t.notice_classification IS DISTINCT FROM s.plan->>'classification' OR t.offer_deadline IS DISTINCT FROM nullif(s.plan->>'deadlineTo','')::timestamptz
          OR jsonb_array_length(s.plan->'deadlineEvidence')>0 OR jsonb_array_length(s.plan->'lots')>0 OR jsonb_array_length(s.plan->'relations')>0`, [runId]);
      await client.query(`INSERT INTO tender.notice_lifecycle_transitions(tender_id,correction_run_id,lot_key,from_lifecycle,to_lifecycle,from_participation,to_participation,reason_code,evidence)
        SELECT t.id,$1,NULL,t.source_lifecycle_status,s.plan->>'toLifecycle',t.participation_status,s.plan->>'toParticipation',s.plan->>'reason',jsonb_build_object('planSha256',$2::text,'rowPlanSha256',s.plan->>'rowPlanSha256')
        FROM lifecycle_plan_stage s JOIN tender.tenders t ON t.id=s.id
        WHERE t.source_lifecycle_status IS DISTINCT FROM s.plan->>'toLifecycle' OR t.participation_status IS DISTINCT FROM s.plan->>'toParticipation'`, [runId, plan.planSha256]);
      await client.query(`INSERT INTO tender.notice_lifecycle_transitions(tender_id,correction_run_id,lot_key,from_lifecycle,to_lifecycle,from_participation,to_participation,reason_code,evidence)
        SELECT s.id,$1,lot->>'lotKey',previous.lifecycle_status,lot->>'lifecycleStatus',previous.participation_status,lot->>'participationStatus',lot->>'blockReason',jsonb_build_object('planSha256',$2::text,'rowPlanSha256',s.plan->>'rowPlanSha256')
        FROM lifecycle_plan_stage s CROSS JOIN LATERAL jsonb_array_elements(s.plan->'lots') lot
        LEFT JOIN tender.tender_lot_lifecycles previous ON previous.tender_id=s.id AND previous.lot_key=lot->>'lotKey' AND previous.is_current
        WHERE previous.id IS NULL OR previous.lifecycle_status IS DISTINCT FROM lot->>'lifecycleStatus' OR previous.participation_status IS DISTINCT FROM lot->>'participationStatus'`, [runId, plan.planSha256]);
      await client.query(`UPDATE tender.tenders t SET source_lifecycle_status=s.plan->>'toLifecycle',participation_status=s.plan->>'toParticipation',notice_classification=s.plan->>'classification',participation_block_reason=nullif(s.plan->>'reason',''),offer_deadline=nullif(s.plan->>'deadlineTo','')::timestamptz,notice_type_code=nullif(s.plan->>'noticeType',''),notice_subtype=nullif(s.plan->>'noticeSubtype',''),notice_form_type=nullif(s.plan->>'formType',''),procedure_identifier=nullif(s.plan->>'procedureIdentifier',''),updated_at=now()
        FROM lifecycle_plan_stage s WHERE t.id=s.id`);
      await client.query("UPDATE tender.tender_deadline_evidence e SET is_current=false,updated_at=now() FROM lifecycle_plan_stage s WHERE e.tender_id=s.id AND e.is_current");
      await client.query(`INSERT INTO tender.tender_deadline_evidence(tender_id,source_code,source_notice_id,procedure_identifier,lot_key,deadline_type,source_date,source_time,source_timezone,normalized_utc,europe_berlin,source_timestamp,source_version,source_kind,parsing_status,decision_reason,date_only,evidence_sha256,raw_evidence,is_current)
        SELECT s.id,s.plan->>'source',coalesce(e->>'sourceNoticeId',s.plan->>'externalId'),nullif(e->>'procedureIdentifier',''),nullif(e->>'lotKey',''),coalesce(e->>'deadlineType','TENDER_RECEIPT'),nullif(e->>'sourceDate',''),nullif(e->>'sourceTime',''),nullif(e->>'sourceTimezone',''),nullif(e->>'normalizedUtc','')::timestamptz,nullif(e->>'europeBerlin',''),nullif(e->>'sourceTimestamp','')::timestamptz,nullif(e->>'sourceVersion',''),e->>'sourceKind',e->>'parsingStatus',e->>'decisionReason',coalesce((e->>'dateOnly')::boolean,false),e->>'evidenceSha256',e,true
        FROM lifecycle_plan_stage s CROSS JOIN LATERAL jsonb_array_elements(s.plan->'deadlineEvidence') e
        ON CONFLICT(tender_id,evidence_sha256) DO UPDATE SET is_current=true,updated_at=now()`);
      await client.query("UPDATE tender.tender_lot_lifecycles l SET is_current=false,updated_at=now() FROM lifecycle_plan_stage s WHERE l.tender_id=s.id AND l.is_current");
      await client.query(`INSERT INTO tender.tender_lot_lifecycles(tender_id,lot_key,lifecycle_status,participation_status,participation_block_reason,offer_deadline,deadline_quality,deadline_evidence_id,is_current)
        SELECT s.id,lot->>'lotKey',lot->>'lifecycleStatus',lot->>'participationStatus',nullif(lot->>'blockReason',''),nullif(lot->>'deadlineUtc','')::timestamptz,lot->>'deadlineQuality',e.id,true
        FROM lifecycle_plan_stage s CROSS JOIN LATERAL jsonb_array_elements(s.plan->'lots') lot
        LEFT JOIN LATERAL(SELECT evidence.id FROM tender.tender_deadline_evidence evidence WHERE evidence.tender_id=s.id AND evidence.lot_key=lot->>'lotKey' AND evidence.is_current AND evidence.parsing_status='EXACT' AND lot->>'deadlineQuality'='EXACT' ORDER BY evidence.id LIMIT 1)e ON true
        ON CONFLICT(tender_id,lot_key) DO UPDATE SET lifecycle_status=excluded.lifecycle_status,participation_status=excluded.participation_status,participation_block_reason=excluded.participation_block_reason,offer_deadline=excluded.offer_deadline,deadline_quality=excluded.deadline_quality,deadline_evidence_id=excluded.deadline_evidence_id,is_current=true,updated_at=now()`);
      await client.query(`INSERT INTO tender.lots(tender_id,external_id,title,deadline,source_reference_id)
        SELECT life.tender_id,life.lot_key,life.lot_key,life.offer_deadline,reference.id
        FROM tender.tender_lot_lifecycles life
        LEFT JOIN LATERAL(SELECT source.id FROM tender.source_references source
          WHERE source.tender_id=life.tender_id ORDER BY source.retrieved_at DESC,source.id DESC LIMIT 1)reference ON true
        WHERE life.is_current AND life.lot_key IS NOT NULL AND btrim(life.lot_key)<>''
        ON CONFLICT(tender_id,external_id) WHERE external_id IS NOT NULL DO UPDATE
        SET deadline=coalesce(excluded.deadline,tender.lots.deadline),
            source_reference_id=coalesce(tender.lots.source_reference_id,excluded.source_reference_id)`);
      await client.query(`INSERT INTO tender.tender_notice_relationships(source_tender_id,related_tender_id,source_code,source_external_id,related_external_id,procedure_identifier,relationship_type,evidence)
        SELECT s.id,related.id,s.plan->>'source',s.plan->>'externalId',r->>'relatedExternalId',nullif(r->>'procedureIdentifier',''),r->>'relationshipType',jsonb_build_object('planSha256',$1::text,'correctionRunId',$2::text)
        FROM lifecycle_plan_stage s CROSS JOIN LATERAL jsonb_array_elements(s.plan->'relations') r LEFT JOIN tender.tenders related ON related.source_code=s.plan->>'source' AND related.external_id=r->>'relatedExternalId'
        ON CONFLICT(source_tender_id,related_external_id,relationship_type) DO UPDATE SET related_tender_id=excluded.related_tender_id,procedure_identifier=excluded.procedure_identifier,evidence=excluded.evidence,updated_at=now()`, [plan.planSha256, runId]);
      await client.query("INSERT INTO tender.audit_events(action,metadata) VALUES('NOTICE_LIFECYCLE_CORRECTION_APPLIED',$1::jsonb)", [JSON.stringify({ runId, planSha256: plan.planSha256, inputSha256: plan.inputSha256, changedRows: changes.length, physicalDeletes: 0 })]);
      await client.query("UPDATE tender.notice_lifecycle_correction_runs SET status='APPLIED',applied_at=now() WHERE run_id=$1", [runId]);
      await client.query("COMMIT");
    }
  } else await client.query("ROLLBACK");
  if (!idempotentApply) {
    const summary = {};
    for (const row of plan.rows) { const key = `${row.source}:${row.classification}:${row.fromLifecycle}->${row.toLifecycle}:${row.toParticipation}:${row.deadlineQuality}`; summary[key] = (summary[key] || 0) + 1; }
    console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY_RUN", asOf: asOf.toISOString(), rows: plan.rows.length, physicallyChangedRows: changes.length, planSha256: plan.planSha256, inputSha256: plan.inputSha256, canonicalPlanSchema: plan.planDocument.schema, summary, physicalDeletes: 0, userDataPreserved: true }, null, 2));
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {}); throw error;
} finally { client.release(); await pool.end(); }
