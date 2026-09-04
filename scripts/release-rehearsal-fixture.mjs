import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { DatabaseSync } from "node:sqlite";
import { encryptTotpSecret, hashTenderPassword } from "../platform/admin-auth.mjs";
import { approvalBinding, manifestHash } from "../platform/bid-workflow.mjs";

const mode = process.argv[2];
const directory = process.env.REHEARSAL_SECRET_DIR;
if (!directory || !path.isAbsolute(directory)) throw new Error("rehearsal_secret_dir_absolute_required");
const files = Object.freeze({ database: "database_url", runtimeDatabase: "runtime_database_url", pepper: "session_pepper", fieldKey: "field_encryption_key", email: "e2e_email", password: "e2e_password", totp: "e2e_totp", portalKey: "portal_credential_key", careerDb: "career.db" });
const file = (key) => path.join(directory, files[key]);
const read = (key) => readFileSync(file(key), "utf8").trim();
const write = (key, value) => writeFileSync(file(key), `${value}\n`, { mode: 0o600, flag: "wx" });
const json = (value) => JSON.stringify(value);
const sha = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : json(value)).digest("hex");
const uuid = (name) => {
  const bytes = crypto.createHash("sha256").update(`WB_RELEASE_REHEARSAL_20260904:${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [bytes.subarray(0, 4), bytes.subarray(4, 6), bytes.subarray(6, 8), bytes.subarray(8, 10), bytes.subarray(10)].map((part) => part.toString("hex")).join("-");
};
const ids = Object.freeze(Object.fromEntries([
  "tenant", "companyA", "companyB", "profileA", "profileB", "profileApprovalA", "profileApprovalB", "configA", "configB", "tenderA", "tenderB", "versionA", "versionB",
  "lotA", "lotB", "lotLifecycleA", "lotLifecycleB", "enrichmentA", "enrichmentB", "enrichmentLotA", "enrichmentLotB", "documentA",
  "portal", "adapter", "scopeSentinel", "calculation", "management", "approvalRequest", "requiredDocument", "backfillRun",
].map((name) => [name, uuid(name)])));
const marker = "WB_RELEASE_REHEARSAL_20260904";
const randomBase32 = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", bytes = crypto.randomBytes(20);
  let bits = "", output = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  for (let offset = 0; offset < bits.length; offset += 5) output += alphabet[Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, "0"), 2)];
  return output;
};
const prepareRuntimeRole = async (client) => {
  await client.query(`DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wb_rehearsal_runtime') THEN CREATE ROLE wb_rehearsal_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END$$`);
  await client.query("GRANT CONNECT ON DATABASE wb_rehearsal TO wb_rehearsal_runtime");
  for (const schema of ["saas", "tenant_portal", "app", "files", "crm", "audit", "integration", "communication", "tender", "iam"]) {
    if (!(await client.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) present", [schema])).rows[0].present) continue;
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO wb_rehearsal_runtime`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO wb_rehearsal_runtime`);
    await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO wb_rehearsal_runtime`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO wb_rehearsal_runtime`);
  }
};

if (mode === "generate") {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  write("database", ["postgresql:", "", "postgres@db", "wb_rehearsal"].join("/"));
  write("runtimeDatabase", ["postgresql:", "", "wb_rehearsal_runtime@db", "wb_rehearsal"].join("/"));
  write("pepper", crypto.randomBytes(48).toString("base64url"));
  write("fieldKey", crypto.randomBytes(32).toString("hex"));
  write("email", "wb-release-rehearsal-20260904@example.invalid");
  write("password", `R-${crypto.randomBytes(30).toString("base64url")}!9a`);
  write("totp", randomBase32());
  write("portalKey", crypto.randomBytes(32).toString("base64url"));
  const career = new DatabaseSync(file("careerDb"));
  career.exec("CREATE TABLE recruiting_user_sectors(user_id TEXT NOT NULL,sector_id TEXT NOT NULL,access_active INTEGER NOT NULL DEFAULT 1,can_read INTEGER NOT NULL DEFAULT 1)");
  career.close();
  console.log(JSON.stringify({ generated: true, namespace: marker, syntheticIdentity: true, secretValuesLogged: false }));
} else if (mode === "prepare-runtime") {
  if (process.env.DATABASE_URL) throw new Error("inline_secret_forbidden_database_url");
  const pool = new pg.Pool({ connectionString: read("database"), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wb-release-rehearsal-fixture-20260904'))");
    await prepareRuntimeRole(client);
    await client.query("COMMIT");
    console.log(JSON.stringify({ runtimePrepared: true, isolatedRole: "wb_rehearsal_runtime", secretValuesLogged: false }));
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); await pool.end(); }
} else if (mode === "seed") {
  if (process.env.DATABASE_URL) throw new Error("inline_secret_forbidden_database_url");
  const pool = new pg.Pool({ connectionString: read("database"), max: 1 });
  const passwordHash = await hashTenderPassword(read("password"));
  const encryptedTotp = encryptTotpSecret(read("totp"), Buffer.from(read("fieldKey"), "hex"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wb-release-rehearsal-fixture-20260904'))");
    const existing = await client.query("SELECT count(*)::int n FROM tender.tenders WHERE id=ANY($1::uuid[])", [[ids.tenderA, ids.tenderB]]);
    if (existing.rows[0].n) throw new Error("rehearsal_fixture_already_present");
    await prepareRuntimeRole(client);
    const user = (await client.query(`INSERT INTO iam.users(email,password_hash,active,mfa_required,mfa_secret_encrypted,failed_attempts,mfa_last_counter) VALUES($1,$2,true,true,$3,0,NULL) RETURNING id`, [read("email"), passwordHash, encryptedTotp])).rows[0];
    const role = (await client.query("INSERT INTO iam.roles(code,label) VALUES($1,$2) RETURNING id", [`tender.release_rehearsal.${marker.toLowerCase()}`, `${marker} route acceptance`])).rows[0];
    const permissions = ["tender.view_assigned", "tender.source.view", "tender.task.manage", "tender.deadline.manage", "tender.connector.view", "tender.document.view", "tender.calculation.create", "tender.board.view", "tender.board.approve", "tender.submission.approve", "tender.config.read", "tender.profile.manage"];
    for (const permission of permissions) {
      const row = (await client.query("SELECT id FROM iam.permissions WHERE code=$1", [permission])).rows[0];
      if (!row) throw new Error(`required_permission_missing:${permission}`);
      await client.query("INSERT INTO iam.role_permissions(role_id,permission_id) VALUES($1,$2)", [role.id, row.id]);
    }
    await client.query("INSERT INTO iam.user_roles(user_id,role_id) VALUES($1,$2)", [user.id, role.id]);
    await client.query("INSERT INTO saas.tenants(id,slug,display_name,status,customer_identity_hash,tenant_kind) VALUES($1,$2,$3,'ACTIVE',$4,'INTERNAL')", [ids.tenant, `${marker.toLowerCase().replaceAll("_", "-")}-tenant`, `${marker}_TENANT`, sha("tenant")]);
    await client.query("INSERT INTO tender.configuration_tenants(id,tenant_key) VALUES($1,$2)", [ids.tenant, `${marker}_TENANT`]);
    for (const suffix of ["A", "B"]) {
      const company = ids[`company${suffix}`], profile = ids[`profile${suffix}`], config = ids[`config${suffix}`];
      await client.query("INSERT INTO cms.business_units(id,code,name,status) VALUES($1,$2,$3,'approved')", [company, `${marker.toLowerCase()}_bu_${suffix.toLowerCase()}`, `${marker}_COMPANY_${suffix}`]);
      await client.query(`INSERT INTO tender.company_profiles(id,company_id,version,name,capabilities,certifications,reference_profile,commercial_profile,status,lifecycle_status,service_lines,regions,field_provenance,approved_at,approved_by,profile_sha256) VALUES($1,$2,1,$3,'{}','{}','{}','{}','ACTIVE','ACTIVE',ARRAY['security'],'{}','{}',now(),$4,$5)`, [profile, company, `${marker}_PROFILE_${suffix}`, user.id, sha(`profile-${suffix}`)]);
      await client.query("INSERT INTO tender.company_profile_approvals(id,company_profile_id,profile_sha256,decision,approved_by,source_approval_reference,metadata) VALUES($1,$2,$3,'APPROVED',$4,$5,$6::jsonb)", [ids[`profileApproval${suffix}`], profile, sha(`profile-${suffix}`), user.id, marker, json({ namespace: marker, synthetic: true })]);
      await client.query(`INSERT INTO tender.enterprise_company_links(company_id,tender_profile_id,legal_name,display_name,technical_key,slug,active,sector_slug,sector_status,discovery_status,matching_status,calculation_status,creation_source,configuration_version,applied_transaction_id) VALUES($1,$2,$3,$3,$4,$4,true,'security','approved','APPROVED','APPROVED','BLOCKED',$5,2,$6)`, [company, profile, `${marker}_COMPANY_${suffix}`, `${marker.toLowerCase()}-company-${suffix.toLowerCase()}`, marker, uuid(`transaction${suffix}`)]);
      await client.query("INSERT INTO tender.configuration_scopes(tenant_id,company_id,canonical_service,profile_id) VALUES($1,$2,'security',$3)", [ids.tenant, company, profile]);
      await client.query(`INSERT INTO tender.configuration_versions(id,status,company_id,service_line,source,reason,payload,validation,impact_preview,checksum,created_by,approved_by,submitted_at,approved_at,activated_at,tenant_id,canonical_service,profile_id) VALUES($1,'ACTIVE',$2,'security',$3,$3,'{}','{}','{}',$4,$5,$5,now(),now(),now(),$6,'security',$7)`, [config, company, marker, sha(`config-${suffix}`), user.id, ids.tenant, profile]);
      await client.query("INSERT INTO tender.cost_configurations(id,company_id,service_line,version,effective_from,values,sources,status,created_by) VALUES($1,$2,'security',1,current_date,$3::jsonb,$4::jsonb,'ACTIVE',$5)", [config, company, json({ namespace: marker, synthetic: true }), json({ namespace: marker, synthetic: true }), user.id]);
      await client.query("INSERT INTO saas.legacy_company_tenant_bindings(company_id,tenant_id,backfill_run_id) VALUES($1,$2,$3)", [company, ids.tenant, ids.backfillRun]);
    }
    await client.query("INSERT INTO iam.tender_identity_scopes(user_id,scope_type,scope_id,active) VALUES($1,'company',$2,true)", [user.id, ids.companyA]);
    for (const suffix of ["A", "B"]) {
      const tender = ids[`tender${suffix}`], company = ids[`company${suffix}`], version = ids[`version${suffix}`], lot = ids[`lot${suffix}`], lifecycle = ids[`lotLifecycle${suffix}`], enrichment = ids[`enrichment${suffix}`], enrichmentLot = ids[`enrichmentLot${suffix}`];
      const title = `${marker}_TENDER_${suffix}`, rawHash = sha(`tender-${suffix}`), deadline = "2099-09-30T12:00:00Z";
      await client.query(`INSERT INTO tender.tenders(id,data_class,source_code,external_id,notice_number,buyer,title,description,cpv_codes,regions,company_id,assigned_user_id,publication_date,offer_deadline,contract_start,contract_end,duration_months,currency,source_url,source_timestamp,status,raw_sha256,last_synced_at,source_lifecycle_status,classification_status,wb_relevance_status,assigned_service_line,classification_confidence,classification_basis,classification_reason,classified_at,notice_classification,participation_status) VALUES($1,'PUBLIC_REAL','TED',$2,$2,$3,$3,$4,ARRAY['79713000'],ARRAY['DE212'],$5,$6,current_date,$7,'2099-10-01','2100-09-30',12,'EUR',$8,now(),'ACTIVE',$9,now(),'ACTIVE','CLASSIFIED','RELEVANT','security','HIGH',$10,$10,now(),'COMPETITION','ELIGIBLE')`, [tender, title, title, `${marker} fully synthetic isolated route context`, company, suffix === "A" ? user.id : null, deadline, `https://example.invalid/${marker.toLowerCase()}/${suffix.toLowerCase()}`, rawHash, marker]);
      // This seed runs only as the isolated rehearsal superuser. Suppress the
      // production enqueue trigger for the synthetic version itself; all HTTP
      // workflow and authorization paths remain the real application paths.
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query("INSERT INTO tender.tender_versions(id,tender_id,version,source_sha256,normalized_data,change_kind,source_timestamp) VALUES($1,$2,1,$3,$4::jsonb,'INITIAL',now())", [version, tender, rawHash, json({ namespace: marker, synthetic: true, externalWrite: false })]);
      await client.query("SET LOCAL session_replication_role=origin");
      await client.query("INSERT INTO tender.lots(id,tender_id,external_id,title,description,locations,cpv_codes,currency,deadline) VALUES($1,$2,'LOT-REHEARSAL-1',$3,$3,'[]',ARRAY['79713000'],'EUR',$4)", [lot, tender, `${marker}_LOT_${suffix}`, deadline]);
      await client.query("INSERT INTO tender.tender_lot_lifecycles(id,tender_id,lot_key,lifecycle_status,participation_status,offer_deadline,deadline_quality,is_current) VALUES($1,$2,'LOT-REHEARSAL-1','ACTIVE','ELIGIBLE',$3,'EXACT',true)", [lifecycle, tender, deadline]);
      await client.query(`INSERT INTO tender.enrichment_versions(id,tender_id,version,source_code,notice_identifier,notice_version,change_state,retrieved_at,source_url,payload_sha256,raw_payload,raw_content_type,structured_data,quality_summary,mapper_version,parser_version,historical) VALUES($1,$2,1,'TED',$3,'1','REHEARSAL',now(),$4,$5,$6,'application/json',$7::jsonb,$8::jsonb,$9,$9,false)`, [enrichment, tender, title, `https://example.invalid/${marker.toLowerCase()}/${suffix.toLowerCase()}`, sha(`enrichment-${suffix}`), Buffer.from(json({ namespace: marker, suffix })), json({ namespace: marker, synthetic: true }), json({ synthetic: true }), marker]);
      await client.query("INSERT INTO tender.enrichment_lots(id,enrichment_version_id,lot_key,lot_number,title,structured_data,provenance) VALUES($1,$2,'LOT-REHEARSAL-1','1',$3,$4::jsonb,$5::jsonb)", [enrichmentLot, enrichment, `${marker}_LOT_${suffix}`, json({ namespace: marker }), json({ namespace: marker, synthetic: true })]);
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(`INSERT INTO tender.service_relevance_evaluations(tender_id,enrichment_version_id,company_id,lot_key,evaluation_version,classifier_version,snapshot_sha256,relevance_status,service_scope_gate,primary_company,alternative_company,service_line,recommendation,reason,positive_signals,exclusion_signals,applied_cpv_codes,applied_rules,prior_assignment,source_manifest) VALUES($1,$2,$3,'LOT-REHEARSAL-1',1,$4,$5,'RELEVANT','PASSED',true,false,'security','FULL_PIPELINE_ALLOWED',$4,'[]','[]','["79713000"]','{}','{}',$6::jsonb)`, [tender, enrichment, company, marker, sha(`relevance-${suffix}`), json({ namespace: marker, synthetic: true })]);
      await client.query("SET LOCAL session_replication_role=origin");
    }
    await client.query(`INSERT INTO tender.portal_adapters(id,portal_code,name,mode,supported_actions,authentication_type,mfa_required,feature_flag,kill_switch) VALUES($1,$2,$3,'READ_ONLY',ARRAY['DOCUMENT_LIST','DOCUMENT_DOWNLOAD'],'PASSWORD',false,$2,true)`, [ids.adapter, `${marker}_PORTAL`, `${marker} synthetic portal`]);
    await client.query(`INSERT INTO tender.portal_registry(id,display_name,canonical_domain,discovery_source,adapter_id,adapter_version,adapter_validation_status,capabilities,adapter_enabled,last_verified_at) VALUES($1,$2,'rehearsal.example.invalid',$3,$4,'1','TEST_ONLY',ARRAY['DOCUMENT_DOWNLOAD'],true,now())`, [ids.portal, `${marker} synthetic portal`, marker, `${marker}_PORTAL`]);
    await client.query(`INSERT INTO tender.portal_credential_secrets(id,portal_id,version,ciphertext,iv,auth_tag,username_masked,read_only,status,created_by,account_confirmed,submission_capable,registration_status,login_status) VALUES($1,$2,1,$3,$4,$5,NULL,true,'ACTIVE',$6,false,false,'NICHT_REGISTRIERT','LOGIN_UNGEPRUEFT')`, [ids.scopeSentinel, ids.portal, Buffer.from(`${marker}_NON_CREDENTIAL_SCOPE_SENTINEL`), Buffer.alloc(12), Buffer.alloc(16), user.id]);
    await client.query(`INSERT INTO tender.portal_credential_companies(credential_id,company_id,active,metadata_configured,internal_label,registration_status,login_status,tenant_id) VALUES($1,$2,true,false,$3,'NICHT_REGISTRIERT','LOGIN_UNGEPRUEFT',$4)`, [ids.scopeSentinel, ids.companyA, `${marker}_NON_CREDENTIAL_SCOPE_SENTINEL`, ids.tenant]);
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query(`INSERT INTO tender.enrichment_documents(id,enrichment_version_id,lot_id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,content,extracted_data,parser,parser_version,retrieved_at,provenance,resolution_status,document_class,procurement_relevant,tender_association_verified,lot_association_verified,magic_bytes_verified,content_size,procurement_verification_status) VALUES($1,$2,$3,'https://rehearsal.example.invalid/document','TENDER_DOCUMENT',$4,'VORHANDEN',200,'text/plain',$5,$6,$7::jsonb,'synthetic','1',now(),$8::jsonb,'DOWNLOAD_SUCCEEDED','PROCUREMENT_DOCUMENT',true,true,true,true,$9,'VERIFIED')`, [ids.documentA, ids.enrichmentA, ids.enrichmentLotA, `${marker}_DOCUMENT.txt`, sha("synthetic-document"), Buffer.from("synthetic rehearsal document"), json({ namespace: marker }), json({ portalId: ids.portal, namespace: marker, synthetic: true, externalWrite: false }), Buffer.byteLength("synthetic rehearsal document")]);
    await client.query("SET LOCAL session_replication_role=origin");
    const totals = { status: "CALCULATED_REAL", totalPrice: 100000, db1: 30000, db2: 20000, db3: 15000, profit: 10000, risk: 5000, fte: 2, productiveHours: 3200 };
    await client.query(`INSERT INTO tender.calculations(id,tender_id,lot_id,company_id,version,service_line,scenario,config_id,status,blocked_reasons,totals,created_by,lot_key,calculation_mode,scenario_assumptions,scenario_label,tenant_id) VALUES($1,$2,$3,$4,1,'security','BASE',$5,'CALCULATED_REAL','[]',$6::jsonb,$7,'LOT-REHEARSAL-1','SYNTHETIC_REHEARSAL','{}',$8,$9)`, [ids.calculation, ids.tenderA, ids.lotA, ids.companyA, ids.configA, json(totals), user.id, marker, ids.tenant]);
    const managementPayload = { schemaVersion: 1, status: "MANAGEMENT_OUTPUT_GENERATED", decision: "REVIEW", reason: `${marker} synthetic decision context`, calculation: totals, risk: { classification: "SYNTHETIC" }, externalTransmission: false };
    await client.query(`INSERT INTO tender.management_outputs(id,tender_id,lot_key,company_id,calculation_id,document_revision,management_output_version,output_sha256,status,payload,correlation_id,historical,scenario_key,calculation_mode,scenario_assumptions,tenant_id) VALUES($1,$2,'LOT-REHEARSAL-1',$3,$4,$5,1,$6,'MANAGEMENT_OUTPUT_GENERATED',$7::jsonb,$8,false,'BASE','SYNTHETIC_REHEARSAL','{}',$9)`, [ids.management, ids.tenderA, ids.companyA, ids.calculation, sha("synthetic-document"), sha(managementPayload), json(managementPayload), uuid("correlation"), ids.tenant]);
    await client.query(`INSERT INTO tender.required_documents(id,tender_id,tender_version_id,lot_key,company_id,requirement_code,requirement_title,requirement_description,source_document_id,source_reference,category,document_type,mandatory,submission_relevant,approval_relevant,expected_signatories,signature_required,accepted_formats,max_file_size,satisfaction_status,source_type,reusable_company_evidence,requirement_classification,classification_provenance,tenant_id) VALUES($1,$2,$3,'LOT-REHEARSAL-1',$4,$5,$5,$6,$7,$8,'TECHNICAL','PROCUREMENT_DOCUMENT',true,false,false,'[]',false,ARRAY['text/plain'],1048576,'VALIDATED','TENDER_DOCUMENT',false,'INFORMATIONAL_TEXT',$9::jsonb,$10)`, [ids.requiredDocument, ids.tenderA, ids.versionA, ids.companyA, `${marker}_REQUIREMENT`, `${marker} synthetic required document`, ids.documentA, marker, json({ namespace: marker, synthetic: true }), ids.tenant]);
    await client.query("INSERT INTO tender.tasks(tender_id,assignee_id,due_at,title) VALUES($1,$2,'2099-09-20T12:00:00Z',$3)", [ids.tenderA, user.id, `${marker}_TASK_SEEDED`]);
    await client.query("INSERT INTO tender.reminders(tender_id,user_id,remind_at) VALUES($1,$2,'2099-09-21T12:00:00Z')", [ids.tenderA, user.id]);
    await client.query(`INSERT INTO tender.management_inbox(tender_id,tender_version_id,event_kind,company_id,sector_slug,service_line,decision,hard_gates,missing_information,risks,recommended_next_step,responsible_user_id,workflow_status,source_code,event_fingerprint,tenant_id,canonical_service,profile_id) VALUES($1,$2,'NEW',$3,'security','security','REVIEW','[]','[]','[]',$4,$5,'NEW','TED',$6,$7,'security',$8)`, [ids.tenderA, ids.versionA, ids.companyA, marker, user.id, sha("management-inbox"), ids.tenant, ids.profileA]);
    const documentRevision = manifestHash([{ id: ids.documentA, sha256: sha("synthetic-document"), status: "VERIFIED" }]);
    const binding = approvalBinding({ tenderId: ids.tenderA, lotKey: "LOT-REHEARSAL-1", companyId: ids.companyA, portalAdapterId: ids.adapter, tenderVersionId: ids.versionA, documentVersion: documentRevision, calculationId: ids.calculation, calculationVersion: 1, managementOutputId: ids.management, managementVersion: 1, offerVersion: 1, approverRole: "BOARD_OR_AUTHORIZED_EMPLOYEE" });
    if (binding.status !== "APPROVAL_BINDING_READY") throw new Error("synthetic_approval_binding_incomplete");
    await client.query(`INSERT INTO tender.approval_requests(id,tender_id,action_type,payload_sha256,payload_manifest,tender_version_id,calculation_id,status,requested_by,expires_at,tenant_id,company_id) VALUES($1,$2,'BID_SUBMISSION',$3,$4::jsonb,$5,$6,'REQUESTED',$7,'2099-09-29T12:00:00Z',$8,$9)`, [ids.approvalRequest, ids.tenderA, binding.sha256, json(binding.binding), ids.versionA, ids.calculation, user.id, ids.tenant, ids.companyA]);
    const assertions = await Promise.all([
      client.query("SELECT count(*)::int n FROM tender.current_service_relevance WHERE tender_id=ANY($1::uuid[])", [[ids.tenderA, ids.tenderB]]),
      client.query("SELECT count(*)::int n FROM tender.current_registered_tender_company_portals WHERE tender_id=$1 AND company_id=$2", [ids.tenderA, ids.companyA]),
      client.query("SELECT count(*)::int n FROM tender.current_participation_eligible_lots WHERE tender_id=ANY($1::uuid[])", [[ids.tenderA, ids.tenderB]]),
    ]);
    if (assertions[0].rows[0].n !== 2 || assertions[1].rows[0].n !== 1 || assertions[2].rows[0].n !== 2) throw new Error(`fixture_derived_context_incomplete:${assertions.map((x) => x.rows[0].n).join(":")}`);
    await client.query("COMMIT");
    console.log(JSON.stringify({ seeded: true, namespace: marker, syntheticIdentity: true, syntheticCompanies: 2, syntheticTenders: 2, calculations: 1, managementOutputs: 1, tasks: 1, reminders: 1, documents: 1, exactCompanyScope: true, nonCredentialScopeSentinel: true, externalWrite: false, secretValuesLogged: false }));
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); await pool.end(); }
} else if (mode === "cleanup") {
  if (process.env.DATABASE_URL) throw new Error("inline_secret_forbidden_database_url");
  const pool = new pg.Pool({ connectionString: read("database"), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wb-release-rehearsal-fixture-20260904'))");
    const user = (await client.query("SELECT id FROM iam.users WHERE email=$1", [read("email")])).rows[0];
    const role = (await client.query("SELECT id FROM iam.roles WHERE code=$1", [`tender.release_rehearsal.${marker.toLowerCase()}`])).rows[0];
    const tenders = [ids.tenderA, ids.tenderB], companies = [ids.companyA, ids.companyB];
    for (const table of ["final_preflight_requirements", "final_preflight_user_actions", "package_readiness_checks", "portal_submission_schemas", "signature_documents"]) {
      if ((await client.query("SELECT to_regclass($1) present", [`tender.${table}`])).rows[0].present) await client.query(`DELETE FROM tender.${table} WHERE context_id IN(SELECT id FROM tender.final_preflight_contexts WHERE tender_id=ANY($1::uuid[]))`, [tenders]);
    }
    await client.query("DELETE FROM tender.final_preflight_contexts WHERE tender_id=ANY($1::uuid[])", [tenders]);
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query("DELETE FROM tender.approval_events WHERE approval_request_id IN(SELECT id FROM tender.approval_requests WHERE tender_id=ANY($1::uuid[]))", [tenders]);
    await client.query("DELETE FROM tender.approval_requests WHERE tender_id=ANY($1::uuid[])", [tenders]);
    await client.query("DELETE FROM tender.calculation_items WHERE calculation_id IN(SELECT id FROM tender.calculations WHERE tender_id=ANY($1::uuid[]))", [tenders]);
    for (const table of ["generated_documents", "bid_packages", "required_documents", "management_outputs", "calculations", "calculation_input_snapshots", "calculation_user_inputs", "management_inbox", "tasks", "reminders", "favorites", "notes", "evaluations", "service_relevance_evaluations", "tender_lot_lifecycles"]) {
      if ((await client.query("SELECT to_regclass($1) present", [`tender.${table}`])).rows[0].present) await client.query(`DELETE FROM tender.${table} WHERE tender_id=ANY($1::uuid[])`, [tenders]);
    }
    await client.query("DELETE FROM tender.audit_events WHERE tender_id=ANY($1::uuid[]) OR metadata->>'namespace'=$2", [tenders, marker]);
    await client.query("SET LOCAL session_replication_role=origin");
    await client.query("DELETE FROM tender.portal_credential_companies WHERE credential_id=$1", [ids.scopeSentinel]);
    await client.query("DELETE FROM tender.portal_credential_secrets WHERE id=$1", [ids.scopeSentinel]);
    await client.query("DELETE FROM tender.enrichment_document_blobs WHERE enrichment_document_id IN(SELECT id FROM tender.enrichment_documents WHERE enrichment_version_id=ANY($1::uuid[]))", [[ids.enrichmentA, ids.enrichmentB]]);
    await client.query("DELETE FROM tender.enrichment_documents WHERE enrichment_version_id=ANY($1::uuid[])", [[ids.enrichmentA, ids.enrichmentB]]);
    await client.query("DELETE FROM tender.enrichment_lots WHERE enrichment_version_id=ANY($1::uuid[])", [[ids.enrichmentA, ids.enrichmentB]]);
    await client.query("DELETE FROM tender.enrichment_versions WHERE id=ANY($1::uuid[])", [[ids.enrichmentA, ids.enrichmentB]]);
    await client.query("DELETE FROM tender.lots WHERE tender_id=ANY($1::uuid[])", [tenders]);
    await client.query("DELETE FROM tender.tender_versions WHERE tender_id=ANY($1::uuid[])", [tenders]);
    await client.query("DELETE FROM tender.tenders WHERE id=ANY($1::uuid[])", [tenders]);
    await client.query("DELETE FROM tender.portal_registry WHERE id=$1", [ids.portal]);
    await client.query("DELETE FROM tender.portal_adapters WHERE id=$1", [ids.adapter]);
    if (user) await client.query("DELETE FROM iam.tender_identity_scopes WHERE user_id=$1", [user.id]);
    await client.query("DELETE FROM tender.configuration_versions WHERE company_id=ANY($1::uuid[])", [companies]);
    await client.query("DELETE FROM tender.configuration_scopes WHERE company_id=ANY($1::uuid[])", [companies]);
    await client.query("DELETE FROM tender.cost_configurations WHERE company_id=ANY($1::uuid[])", [companies]);
    await client.query("DELETE FROM saas.legacy_company_tenant_bindings WHERE company_id=ANY($1::uuid[])", [companies]);
    await client.query("DELETE FROM tender.enterprise_company_links WHERE company_id=ANY($1::uuid[])", [companies]);
    await client.query("DELETE FROM tender.company_profile_approvals WHERE company_profile_id=ANY($1::uuid[])", [[ids.profileA, ids.profileB]]);
    await client.query("DELETE FROM tender.company_profiles WHERE id=ANY($1::uuid[])", [[ids.profileA, ids.profileB]]);
    await client.query("DELETE FROM cms.business_units WHERE id=ANY($1::uuid[])", [companies]);
    await client.query("DELETE FROM tender.configuration_tenants WHERE id=$1", [ids.tenant]);
    await client.query("DELETE FROM saas.tenants WHERE id=$1", [ids.tenant]);
    const accountHash = crypto.createHash("sha256").update(read("email").toLowerCase()).digest("hex");
    if (user) {
      await client.query("DELETE FROM iam.sessions WHERE user_id=$1", [user.id]);
      await client.query("DELETE FROM iam.tender_login_challenges WHERE user_id=$1", [user.id]);
      await client.query("DELETE FROM iam.user_roles WHERE user_id=$1", [user.id]);
      await client.query("DELETE FROM iam.users WHERE id=$1", [user.id]);
    }
    if (role) { await client.query("DELETE FROM iam.role_permissions WHERE role_id=$1", [role.id]); await client.query("DELETE FROM iam.roles WHERE id=$1", [role.id]); }
    await client.query("DELETE FROM iam.login_attempts WHERE account_hash=$1", [accountHash]);
    const absent = await client.query(`SELECT
      (SELECT count(*) FROM tender.tenders WHERE id=ANY($1::uuid[]))+
      (SELECT count(*) FROM tender.enterprise_company_links WHERE company_id=ANY($2::uuid[]))+
      (SELECT count(*) FROM tender.company_profiles WHERE id=ANY($3::uuid[]))+
      (SELECT count(*) FROM cms.business_units WHERE id=ANY($2::uuid[]))+
      (SELECT count(*) FROM tender.configuration_tenants WHERE id=$4)+
      (SELECT count(*) FROM saas.tenants WHERE id=$4)+
      (SELECT count(*) FROM tender.portal_registry WHERE id=$5)+
      (SELECT count(*) FROM tender.portal_credential_secrets WHERE id=$6)+
      (SELECT count(*) FROM iam.users WHERE email=$7)+
      (SELECT count(*) FROM iam.roles WHERE code=$8) AS n`, [tenders, companies, [ids.profileA, ids.profileB], ids.tenant, ids.portal, ids.scopeSentinel, read("email"), `tender.release_rehearsal.${marker.toLowerCase()}`]);
    if (Number(absent.rows[0].n) !== 0) throw new Error(`rehearsal_fixture_cleanup_incomplete:${absent.rows[0].n}`);
    await client.query("DROP OWNED BY wb_rehearsal_runtime");
    await client.query("DROP ROLE wb_rehearsal_runtime");
    await client.query("COMMIT");
    console.log(JSON.stringify({ cleaned: true, namespace: marker, postCleanupAbsence: true, absenceCount: 0, syntheticIdentity: true, secretValuesLogged: false }));
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); await pool.end(); }
} else {
  throw new Error("usage: release-rehearsal-fixture.mjs generate|prepare-runtime|seed|cleanup");
}
