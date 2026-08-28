import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pool, query } from "./db.js";
const documentSchema = z.object({
    name: z.string().min(1).max(180),
    mimeType: z.literal("application/pdf"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(5).max(25_000_000),
    contentBase64: z.string().max(34_000_000)
});
const eventSchema = z.object({
    eventType: z.enum(["created", "updated", "backfill", "replay"]).default("created"),
    inquiry: z.record(z.unknown()),
    documents: z.array(documentSchema).max(20).default([])
});
const stages = ["Neu eingegangen", "Automatisch geprüft", "Kontaktaufnahme ausstehend", "Kontaktiert", "Bedarf qualifiziert", "Angebot in Bearbeitung", "Angebot versandt", "Nachverfolgung", "Gewonnen", "Verloren"];
const clean = (v) => String(v ?? "").trim();
const normalizeEmail = (v) => clean(v).toLowerCase();
const normalizePhone = (v) => clean(v).replace(/[^\d+]/g, "");
const keyHash = (...v) => crypto.createHash("sha256").update(v.map(clean).join("|").toLowerCase()).digest("hex");
const sourceId = (i) => clean(i.id || i.reference);
const reference = (i) => clean(i.reference || i.id);
const safeFileName = (v) => v.replace(/[\r\n"]/g, "_").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 180) || "Dokument.pdf";
async function resource(type, externalId, title, status, data, raw) {
    const r = await query(`INSERT INTO app.resources(domain,resource_type,title,status,data,raw_source,source_system,external_id,source_hash)
 VALUES('crm',$1,$2,$3,$4,$5,'calculator',$6,$7)
 ON CONFLICT(source_system,resource_type,external_id) DO UPDATE SET
 title=EXCLUDED.title,status=CASE WHEN app.resources.status IN ('won','lost') THEN app.resources.status ELSE EXCLUDED.status END,
 data=app.resources.data||EXCLUDED.data,raw_source=EXCLUDED.raw_source,source_hash=EXCLUDED.source_hash,
 version=app.resources.version+1,updated_at=now()
 RETURNING id`, [type, title, status, data, raw ?? null, externalId, keyHash(JSON.stringify(raw ?? data))]);
    return r.rows[0].id;
}
async function existing(type, sql, values) {
    const r = await query(`SELECT id FROM app.resources WHERE resource_type=$1 AND deleted_at IS NULL AND ${sql} ORDER BY created_at LIMIT 1`, [type, ...values]);
    return r.rows[0]?.id;
}
async function storeDocument(calculatorId, doc, privateRoot) {
    const bytes = Buffer.from(doc.contentBase64, "base64");
    if (bytes.length !== doc.size || crypto.createHash("sha256").update(bytes).digest("hex") !== doc.sha256 || bytes.subarray(0, 4).toString() !== "%PDF")
        throw new Error("document_integrity_failed");
    let f = await query("SELECT id FROM files.objects WHERE sha256=$1 AND size_bytes=$2 AND protection_class='private' AND deleted_at IS NULL", [doc.sha256, doc.size]);
    if (!f.rowCount) {
        const storageName = `calculator-${doc.sha256}-${crypto.randomUUID()}`;
        const target = path.resolve(privateRoot, storageName);
        if (path.basename(storageName) !== storageName || !target.startsWith(path.resolve(privateRoot) + path.sep))
            throw new Error("path_traversal");
        await fs.writeFile(target, bytes, { mode: 0o600, flag: "wx" });
        f = await query(`INSERT INTO files.objects(storage_name,original_name,mime_type,size_bytes,sha256,protection_class,verified)
   VALUES($1,$2,'application/pdf',$3,$4,'private',true) RETURNING id`, [storageName, safeFileName(doc.name), doc.size, doc.sha256]);
    }
    await query(`INSERT INTO app.resource_files(resource_id,file_id,kind,metadata) VALUES($1,$2,'calculator-pdf',$3)
  ON CONFLICT(resource_id,file_id) DO NOTHING`, [calculatorId, f.rows[0].id, { sourceSha256: doc.sha256 }]);
    return f.rows[0].id;
}
export async function processCalculatorEvent(body, idempotencyKey, eventId, privateRoot) {
    const i = body.inquiry, c = i.customer || {}, p = i.payload || {}, calc = i.calculation || {}, offer = i.offer || {};
    const sid = sourceId(i), ref = reference(i);
    if (!sid || !ref)
        throw new Error("missing_source_identity");
    const name = clean(c.name || p.name || "Unbekannter Interessent"), company = clean(c.company || p.company), email = normalizeEmail(c.email || p.email), phone = normalizePhone(c.phone || p.phone);
    const normalized = {
        reference: ref, sourceId: sid, name, company, email, phone, service: clean(i.serviceName || p.service),
        category: clean(i.categoryName || p.category), objectAddress: clean(p.objectAddress || p.address),
        quantity: p.quantity ?? null, frequency: p.frequency ?? null, serviceStart: p.serviceStart ?? null, serviceEnd: p.serviceEnd ?? null,
        message: clean(p.message), answers: p.answers ?? {}, extras: p.extras ?? {}, calculation: calc, offer,
        priceIndication: Number(offer.price ?? calc.net ?? calc.to ?? 0) || 0, priority: clean(i.priority || "Normal"),
        source: "kalkulator.wb-holding.ag", consent: p.consent ?? p.privacyConsent ?? null,
        createdAt: i.createdAt ?? new Date().toISOString(), updatedAt: i.updatedAt ?? i.createdAt ?? new Date().toISOString(),
        transferStatus: "processed", stage: "Neu eingegangen", owner: clean(i.owner || "Administrator")
    };
    const pipeline = (await query("SELECT id FROM app.resources WHERE resource_type='pipelines' AND source_system='phase4d' AND external_id='calculator-default-pipeline'")).rows[0]?.id;
    const companyKey = company ? keyHash("company", company) : keyHash("private", email || phone || sid);
    let companyId = company ? await existing("companies", "lower(data->>'name')=lower($2)", [company]) : undefined;
    if (!companyId)
        companyId = await resource("companies", companyKey, company || `Privatkunde ${ref}`, "open", { name: company || "Privatkunde", source: "calculator" });
    let contactId = email ? await existing("contacts", "lower(data->>'email')=$2", [email]) : phone ? await existing("contacts", "regexp_replace(data->>'phone','[^0-9+]','','g')=$2", [phone]) : undefined;
    if (!contactId)
        contactId = await resource("contacts", keyHash("contact", email || phone || sid), name, "open", { name, email, phone, companyId, source: "calculator" });
    const leadId = await resource("leads", `${sid}:lead`, `${ref} · ${name}`, "new", { ...normalized, companyId, contactId, pipelineId: pipeline });
    const opportunityId = await resource("opportunities", `${sid}:opportunity`, `${ref} · ${normalized.service}`, "open", { ...normalized, companyId, contactId, leadId, pipelineId: pipeline, value: normalized.priceIndication });
    const activityId = await resource("activities", `${sid}:activity:calculator`, `Preiskalkulator ${ref}`, "done", { kind: "Preiskalkulator", companyId, contactId, leadId, opportunityId, occurredAt: normalized.createdAt });
    const due = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const taskId = await resource("tasks", `${sid}:task:first-contact`, `Erstkontakt ${ref}`, "open", { priority: normalized.priority, dueDate: due, companyId, contactId, leadId, opportunityId, owner: normalized.owner });
    const reminderId = await resource("reminders", `${sid}:reminder:first-contact`, `Wiedervorlage ${ref}`, "open", { dueDate: due, taskId, opportunityId, owner: normalized.owner });
    const calculatorId = await resource("calculator_records", sid, `${ref} · ${name}`, "new", normalized, i);
    const documentIds = [];
    for (const d of body.documents)
        documentIds.push(await storeDocument(calculatorId, d, privateRoot));
    await query(`INSERT INTO integration.calculator_links(calculator_id,company_id,contact_id,lead_id,opportunity_id,activity_id,task_id,reminder_id,pipeline_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(calculator_id) DO UPDATE SET
 company_id=EXCLUDED.company_id,contact_id=EXCLUDED.contact_id,lead_id=EXCLUDED.lead_id,opportunity_id=EXCLUDED.opportunity_id,
 activity_id=EXCLUDED.activity_id,task_id=EXCLUDED.task_id,reminder_id=EXCLUDED.reminder_id,pipeline_id=EXCLUDED.pipeline_id`, [calculatorId, companyId, contactId, leadId, opportunityId, activityId, taskId, reminderId, pipeline]);
    const links = { calculatorId, companyId, contactId, leadId, opportunityId, activityId, taskId, reminderId, pipelineId: pipeline, documentIds };
    await query("UPDATE integration.calculator_events SET status='processed',processed_at=now(),crm_links=$1,attempts=attempts+1 WHERE id=$2", [links, eventId]);
    return { duplicate: false, links };
}
export function registerCalculatorRoutes(app, ctx) {
    const secretPath = process.env.CALCULATOR_WEBHOOK_SECRET_FILE || "/run/secrets/calculator_webhook_secret";
    async function secret() { const s = (await fs.readFile(secretPath, "utf8")).trim(); if (s.length < 32)
        throw new Error("webhook_secret_invalid"); return s; }
    app.post("/api/service/v1/calculator/ingest", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
        const ts = clean(req.headers["x-wb-timestamp"]), nonce = clean(req.headers["x-wb-nonce"]), idem = clean(req.headers["idempotency-key"]), sig = clean(req.headers["x-wb-signature"]);
        if (!/^\d{10}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300)
            return reply.code(401).send({ error: "timestamp_invalid" });
        if (!/^[A-Za-z0-9_-]{24,128}$/.test(nonce) || idem.length < 8 || idem.length > 200 || !/^[a-f0-9]{64}$/.test(sig))
            return reply.code(400).send({ error: "signed_headers_invalid" });
        const parsed = eventSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "schema_invalid" });
        const canonical = JSON.stringify(req.body), expected = crypto.createHmac("sha256", await secret()).update(`${ts}.${nonce}.${idem}.${canonical}`).digest("hex");
        const a = Buffer.from(sig, "hex"), b = Buffer.from(expected, "hex");
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
            return reply.code(401).send({ error: "signature_invalid" });
        const nonceHash = keyHash(nonce);
        try {
            await query("INSERT INTO integration.webhook_nonces(nonce_hash,idempotency_key,expires_at) VALUES($1,$2,now()+interval '10 minutes')", [nonceHash, idem]);
        }
        catch {
            return reply.code(409).send({ error: "replay_detected" });
        }
        const payloadHash = keyHash(canonical), i = parsed.data.inquiry, sid = sourceId(i), ref = reference(i);
        let ev;
        try {
            ev = await query(`INSERT INTO integration.calculator_events(idempotency_key,source_id,reference,event_type,payload_sha256,raw_payload)
   VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [idem, sid, ref, parsed.data.eventType, payloadHash, parsed.data.inquiry]);
        }
        catch {
            const old = await query("SELECT id,status,crm_links FROM integration.calculator_events WHERE idempotency_key=$1 OR (source_id=$2 AND payload_sha256=$3) LIMIT 1", [idem, sid, payloadHash]);
            return reply.code(200).send({ duplicate: true, status: old.rows[0]?.status, links: old.rows[0]?.crm_links });
        }
        try {
            const result = await processCalculatorEvent(parsed.data, idem, ev.rows[0].id, ctx.privateRoot);
            await query("INSERT INTO audit.events(action,object_type,object_id,changed_fields,request_id,metadata) VALUES('calculator_ingest','calculator_event',$1,$2,$3,$4)", [ev.rows[0].id, ["status", "crm_links"], req.id, { sourceId: sid, reference: ref, documentCount: parsed.data.documents.length }]);
            return result;
        }
        catch (e) {
            await query("UPDATE integration.calculator_events SET status='failed',attempts=attempts+1,last_error_code=$1 WHERE id=$2", [clean(e?.message).slice(0, 120), ev.rows[0].id]);
            throw e;
        }
    });
    app.get("/api/admin/v1/calculator/dashboard", { preHandler: ctx.requirePermission("calculator.read") }, async () => {
        const r = await query(`SELECT
   count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int new_inquiries,
   count(*) FILTER(WHERE status='new')::int open_contacts,
   COALESCE(sum((data->>'priceIndication')::numeric),0) offer_total,
   count(*) FILTER(WHERE status='won')::int won,
   count(*) FILTER(WHERE status='lost')::int lost
   FROM app.resources WHERE resource_type='calculator_records' AND deleted_at IS NULL`);
        const overdue = await query("SELECT count(*)::int n FROM app.resources WHERE resource_type='reminders' AND status='open' AND (data->>'dueDate')::timestamptz<now()");
        const dlq = await query("SELECT count(*)::int n FROM integration.calculator_events WHERE status IN ('failed','dead_letter')");
        return { ...r.rows[0], overdue_reminders: overdue.rows[0].n, error_queue: dlq.rows[0].n, conversion: Number(r.rows[0].won) + Number(r.rows[0].lost) ? Number(r.rows[0].won) / (Number(r.rows[0].won) + Number(r.rows[0].lost)) : 0 };
    });
    app.get("/api/admin/v1/calculator", { preHandler: ctx.requirePermission("calculator.read") }, async (req) => {
        const q = clean(req.query?.q).slice(0, 200), status = clean(req.query?.status), priority = clean(req.query?.priority), service = clean(req.query?.service), owner = clean(req.query?.owner);
        const page = Math.max(1, Number(req.query?.page) || 1), limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
        const sort = ["title", "status", "created_at", "updated_at"].includes(req.query?.sort) ? req.query.sort : "updated_at", direction = req.query?.direction === "asc" ? "ASC" : "DESC";
        const v = [];
        let w = "resource_type='calculator_records' AND deleted_at IS NULL";
        if (q) {
            v.push(`%${q}%`);
            w += ` AND (title ILIKE $${v.length} OR data::text ILIKE $${v.length})`;
        }
        if (status) {
            v.push(status);
            w += ` AND status=$${v.length}`;
        }
        if (priority) {
            v.push(priority);
            w += ` AND data->>'priority'=$${v.length}`;
        }
        if (service) {
            v.push(service);
            w += ` AND data->>'service'=$${v.length}`;
        }
        if (owner) {
            v.push(owner);
            w += ` AND data->>'owner'=$${v.length}`;
        }
        const c = await query(`SELECT count(*)::int total FROM app.resources WHERE ${w}`, v);
        v.push(limit, (page - 1) * limit);
        const r = await query(`SELECT id,title,status,data,version,created_at,updated_at FROM app.resources WHERE ${w} ORDER BY ${sort} ${direction} LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
        return { items: r.rows, total: c.rows[0].total, page, limit };
    });
    async function deletionState(id, client = query) {
        const r = await client(`SELECT r.id,r.title,r.deleted_at,r.data,
   rc.retention_until,rc.legal_hold,rc.hold_reason,rc.audit_hold,rc.audit_hold_reason,
   rc.deletion_reason,rc.deletion_requested_by,rc.deletion_requested_at,
   u.email deletion_requested_by_email
   FROM app.resources r
   LEFT JOIN integration.retention_controls rc ON rc.resource_id=r.id
   LEFT JOIN iam.users u ON u.id=rc.deletion_requested_by
   WHERE r.id=$1 AND r.resource_type='calculator_records'`, [id]);
        if (!r.rowCount)
            return null;
        const links = await client(`SELECT x.kind,x.id,linked.title FROM integration.calculator_links l
   CROSS JOIN LATERAL(VALUES
    ('Unternehmen',l.company_id),('Kontakt',l.contact_id),('Lead',l.lead_id),
    ('Chance',l.opportunity_id),('Aktivität',l.activity_id),('Aufgabe',l.task_id),
    ('Wiedervorlage',l.reminder_id)
   )x(kind,id)
   JOIN app.resources linked ON linked.id=x.id AND linked.deleted_at IS NULL
   WHERE l.calculator_id=$1`, [id]);
        const files = await client(`SELECT f.id,f.original_name,f.storage_name,f.sha256,
   (SELECT count(*)::int FROM app.resource_files other WHERE other.file_id=f.id AND other.resource_id<>$1) other_references
   FROM app.resource_files rf JOIN files.objects f ON f.id=rf.file_id
   WHERE rf.resource_id=$1 AND f.deleted_at IS NULL`, [id]);
        const row = r.rows[0], blockers = [];
        if (row.legal_hold)
            blockers.push({ code: "legal_hold", message: row.hold_reason || "Legal Hold ist aktiv." });
        if (row.audit_hold)
            blockers.push({ code: "audit_hold", message: row.audit_hold_reason || "Audit- oder Nachweispflicht ist aktiv." });
        if (row.retention_until && new Date(row.retention_until) > new Date())
            blockers.push({ code: "retention", message: `Aufbewahrungsfrist bis ${new Date(row.retention_until).toLocaleDateString("de-DE")}.` });
        for (const link of links.rows)
            blockers.push({ code: "active_dependency", message: `Aktive Verknüpfung: ${link.kind} „${link.title}“`, resourceId: link.id });
        return { ...row, dependencies: links.rows, files: files.rows, blockers };
    }
    async function requireFreshDeleteReauthentication(req, reply) {
        const verified = Date.parse(req.auth?.mfaVerifiedAt || "");
        if (!Number.isFinite(verified) || Date.now() - verified > 5 * 60 * 1000) {
            reply.code(403).send({ error: "reauthentication_required" });
            return false;
        }
        const token = clean(req.body?.reauthToken);
        if (token.length < 32) {
            reply.code(403).send({ error: "reauthentication_required" });
            return false;
        }
        if (!await ctx.consumeDeleteReauth(token, req.auth.sessionHash)) {
            reply.code(403).send({ error: "reauthentication_required" });
            return false;
        }
        return true;
    }
    app.get("/api/admin/v1/calculator/trash", { preHandler: ctx.requirePermission("calculator.read") }, async () => {
        const ids = (await query("SELECT id FROM app.resources WHERE resource_type='calculator_records' AND deleted_at IS NOT NULL ORDER BY deleted_at DESC")).rows;
        const items = [];
        for (const row of ids) {
            const item = await deletionState(row.id);
            if (item)
                items.push(item);
        }
        return { items, total: items.length };
    });
    app.delete("/api/admin/v1/calculator/:id", { preHandler: [ctx.requirePermission("calculator.delete"), ctx.csrf] }, async (req, reply) => {
        const parsed = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "deletion_reason_required" });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const r = await client.query("UPDATE app.resources SET deleted_at=now(),updated_at=now() WHERE id=$1 AND resource_type='calculator_records' AND deleted_at IS NULL RETURNING id,title", [req.params.id]);
            if (!r.rowCount) {
                await client.query("ROLLBACK");
                return reply.code(404).send({ error: "not_found" });
            }
            await client.query(`INSERT INTO integration.retention_controls(resource_id,deletion_requested_at,deletion_reason,deletion_requested_by)
    VALUES($1,now(),$2,$3) ON CONFLICT(resource_id) DO UPDATE SET
    deletion_requested_at=now(),deletion_reason=EXCLUDED.deletion_reason,deletion_requested_by=EXCLUDED.deletion_requested_by,updated_at=now()`, [req.params.id, parsed.data.reason, req.auth.userId]);
            await client.query("INSERT INTO audit.events(actor_id,action,object_type,object_id,changed_fields,request_id,metadata) VALUES($1,'calculator_soft_delete','calculator_record',$2,$3,$4,$5)", [req.auth.userId, req.params.id, ["deleted_at", "deletion_reason"], req.id, { reason: parsed.data.reason, title: r.rows[0].title }]);
            await client.query("COMMIT");
            return { ok: true, recoverable: true };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    });
    app.post("/api/admin/v1/calculator/trash/restore", { preHandler: [ctx.requirePermission("calculator.delete"), ctx.csrf] }, async (req, reply) => {
        const parsed = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_request" });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const restored = await client.query("UPDATE app.resources SET deleted_at=NULL,updated_at=now() WHERE resource_type='calculator_records' AND deleted_at IS NOT NULL AND id=ANY($1::uuid[]) RETURNING id,title", [parsed.data.ids]);
            for (const row of restored.rows)
                await client.query("INSERT INTO audit.events(actor_id,action,object_type,object_id,changed_fields,request_id) VALUES($1,'calculator_restore','calculator_record',$2,$3,$4)", [req.auth.userId, row.id, ["deleted_at"], req.id]);
            await client.query("COMMIT");
            return { ok: true, restored: restored.rowCount };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    });
    async function permanentlyDelete(req, reply, ids) {
        if (!await requireFreshDeleteReauthentication(req, reply))
            return;
        const reason = clean(req.body?.reason);
        if (reason.length < 3 || reason.length > 500)
            return reply.code(400).send({ error: "deletion_reason_required" });
        if (req.body?.confirmation !== "ENDGÜLTIG LÖSCHEN")
            return reply.code(400).send({ error: "confirmation_required" });
        const deleted = [], blocked = [];
        for (const id of ids) {
            const state = await deletionState(id);
            if (!state || !state.deleted_at) {
                blocked.push({ id, reason: "Datensatz ist nicht im Papierkorb." });
                continue;
            }
            if (state.blockers.length) {
                blocked.push({ id, title: state.title, blockers: state.blockers });
                continue;
            }
            const client = await pool.connect(), physical = [];
            try {
                await client.query("BEGIN");
                const current = await deletionState(id, (sql, values) => client.query(sql, values));
                if (!current || !current.deleted_at || current.blockers.length) {
                    await client.query("ROLLBACK");
                    blocked.push({ id, title: current?.title, blockers: current?.blockers || [{ code: "state_changed", message: "Datensatzstatus wurde zwischenzeitlich geändert." }] });
                    continue;
                }
                for (const file of current.files) {
                    await client.query("DELETE FROM app.resource_files WHERE resource_id=$1 AND file_id=$2", [id, file.id]);
                    if (Number(file.other_references) === 0) {
                        await client.query("UPDATE files.objects SET deleted_at=now() WHERE id=$1", [file.id]);
                        physical.push(file.storage_name);
                    }
                }
                await client.query("DELETE FROM app.resources WHERE id=$1 AND resource_type='calculator_records'", [id]);
                await client.query("INSERT INTO audit.events(actor_id,action,object_type,object_id,changed_fields,request_id,metadata) VALUES($1,'calculator_permanent_delete','calculator_record',$2,$3,$4,$5)", [req.auth.userId, id, ["permanent_delete"], req.id, { reason, title: current.title, deletedFiles: physical }]);
                await client.query("COMMIT");
                for (const storageName of physical)
                    await fs.unlink(ctx.assertStoragePath(storageName)).catch(() => { });
                deleted.push({ id, title: current.title, deletedFiles: physical.length });
            }
            catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
            finally {
                client.release();
            }
        }
        return { ok: true, deleted, blocked };
    }
    app.post("/api/admin/v1/calculator/trash/permanent", { preHandler: [ctx.requirePermission("calculator.delete"), ctx.csrf] }, async (req, reply) => {
        const parsed = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_request" });
        return permanentlyDelete(req, reply, parsed.data.ids);
    });
    app.post("/api/admin/v1/calculator/trash/empty", { preHandler: [ctx.requirePermission("calculator.delete"), ctx.csrf] }, async (req, reply) => {
        const ids = (await query("SELECT id FROM app.resources WHERE resource_type='calculator_records' AND deleted_at IS NOT NULL ORDER BY deleted_at")).rows.map(x => x.id);
        if (!ids.length)
            return { ok: true, deleted: [], blocked: [] };
        return permanentlyDelete(req, reply, ids);
    });
    app.get("/api/admin/v1/calculator/failures", { preHandler: ctx.requirePermission("calculator.replay") }, async () => {
        const r = await query(`SELECT id,reference,event_type,status,attempts,last_error_code,received_at
   FROM integration.calculator_events WHERE status IN ('failed','dead_letter') ORDER BY received_at DESC LIMIT 100`);
        return { items: r.rows };
    });
    app.get("/api/admin/v1/calculator/:id", { preHandler: ctx.requirePermission("calculator.read") }, async (req, reply) => {
        const r = await query(`SELECT r.*,l.company_id,l.contact_id,l.lead_id,l.opportunity_id,l.activity_id,l.task_id,l.reminder_id,l.pipeline_id,
   e.status transfer_status,e.attempts transfer_attempts,e.last_error_code,e.id event_id,rc.retention_until,rc.legal_hold,rc.hold_reason
   FROM app.resources r LEFT JOIN integration.calculator_links l ON l.calculator_id=r.id
   LEFT JOIN LATERAL(SELECT * FROM integration.calculator_events WHERE source_id=r.external_id ORDER BY received_at DESC LIMIT 1)e ON true
   LEFT JOIN integration.retention_controls rc ON rc.resource_id=r.id WHERE r.id=$1 AND r.resource_type='calculator_records'`, [req.params.id]);
        if (!r.rowCount)
            return reply.code(404).send({ error: "not_found" });
        const activities = await query("SELECT id,title,status,data,updated_at FROM app.resources WHERE resource_type IN ('activities','tasks','reminders','notes') AND (data->>'opportunityId'=$1 OR external_id LIKE $2) ORDER BY updated_at DESC", [r.rows[0].opportunity_id, `${r.rows[0].external_id}:%`]);
        return { ...r.rows[0], files: await ctx.fileRows(req.params.id), activities: activities.rows, stages };
    });
    app.post("/api/admin/v1/calculator/:id/replay", { preHandler: [ctx.requirePermission("calculator.replay"), ctx.csrf] }, async (req, reply) => {
        const e = await query("SELECT * FROM integration.calculator_events WHERE id=$1 AND status IN ('failed','dead_letter')", [req.body?.eventId]);
        if (!e.rowCount)
            return reply.code(404).send({ error: "not_replayable" });
        const body = { eventType: "replay", inquiry: e.rows[0].raw_payload, documents: [] };
        const result = await processCalculatorEvent(body, e.rows[0].idempotency_key, e.rows[0].id, ctx.privateRoot);
        await query("UPDATE integration.dead_letters SET replayed_at=now(),replayed_by=$1 WHERE event_id=$2", [req.auth.userId, e.rows[0].id]);
        await ctx.audit(req, "calculator_replay", "calculator_event", e.rows[0].id);
        return result;
    });
    app.post("/api/admin/v1/calculator/failures/:eventId/replay", { preHandler: [ctx.requirePermission("calculator.replay"), ctx.csrf] }, async (req, reply) => {
        const e = await query("SELECT * FROM integration.calculator_events WHERE id=$1 AND status IN ('failed','dead_letter')", [req.params.eventId]);
        if (!e.rowCount)
            return reply.code(404).send({ error: "not_replayable" });
        const body = { eventType: "replay", inquiry: e.rows[0].raw_payload, documents: [] };
        const result = await processCalculatorEvent(body, e.rows[0].idempotency_key, e.rows[0].id, ctx.privateRoot);
        await query("UPDATE integration.dead_letters SET replayed_at=now(),replayed_by=$1 WHERE event_id=$2", [req.auth.userId, e.rows[0].id]);
        await ctx.audit(req, "calculator_replay", "calculator_event", e.rows[0].id);
        return result;
    });
    app.post("/api/admin/v1/calculator/:id/action", { preHandler: [ctx.requirePermission("calculator.write"), ctx.csrf] }, async (req, reply) => {
        const p = z.object({ kind: z.enum(["note", "task", "reminder"]), title: z.string().min(1).max(300), dueDate: z.string().max(40).optional() }).safeParse(req.body);
        if (!p.success)
            return reply.code(400).send({ error: "invalid_request" });
        const c = await query("SELECT external_id FROM app.resources WHERE id=$1 AND resource_type='calculator_records'", [req.params.id]);
        if (!c.rowCount)
            return reply.code(404).send({ error: "not_found" });
        const l = await query("SELECT opportunity_id FROM integration.calculator_links WHERE calculator_id=$1", [req.params.id]), type = p.data.kind === "note" ? "notes" : p.data.kind === "task" ? "tasks" : "reminders";
        const id = await resource(type, `${c.rows[0].external_id}:${type}:${crypto.randomUUID()}`, p.data.title, type === "notes" ? "done" : "open", { opportunityId: l.rows[0]?.opportunity_id, dueDate: p.data.dueDate, owner: req.auth.email });
        await ctx.audit(req, `calculator_${p.data.kind}_create`, type, id);
        return reply.code(201).send({ id });
    });
    app.put("/api/admin/v1/calculator/:id/privacy", { preHandler: [ctx.requirePermission("calculator.privacy.manage"), ctx.csrf] }, async (req, reply) => {
        const p = z.object({ retentionUntil: z.string().date().nullable(), legalHold: z.boolean(), holdReason: z.string().max(500).optional() }).safeParse(req.body);
        if (!p.success)
            return reply.code(400).send({ error: "invalid_request" });
        await query(`INSERT INTO integration.retention_controls(resource_id,retention_until,legal_hold,hold_reason) VALUES($1,$2,$3,$4)
   ON CONFLICT(resource_id) DO UPDATE SET retention_until=EXCLUDED.retention_until,legal_hold=EXCLUDED.legal_hold,hold_reason=EXCLUDED.hold_reason,updated_at=now()`, [req.params.id, p.data.retentionUntil, p.data.legalHold, p.data.holdReason || null]);
        await ctx.audit(req, "calculator_privacy_update", "calculator_record", req.params.id, Object.keys(p.data));
        return { ok: true };
    });
}
