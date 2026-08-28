import { z } from "zod";
import { pool, query } from "./db.js";
const uuid = z.string().uuid();
const deletableTypes = new Set([
    "services", "blogposts", "jobs", "team", "locations", "industries", "media", "seo",
    "applications", "candidates", "appointments", "recruiting_notes",
    "companies", "contacts", "leads", "opportunities", "pipelines", "tasks",
    "reminders", "notes", "activities", "documents", "calculator_records",
]);
const modulePermission = {
    cms: "cms.write",
    recruiting: "recruiting.write",
    crm: "crm.write",
};
export function registerGlobalTrashRoutes(app, ctx) {
    async function requireResourceAccess(req, reply, resource) {
        if (!resource || !deletableTypes.has(resource.resource_type)) {
            reply.code(409).send({ error: "not_deletable", message: "Dieser Datensatztyp ist nicht eigenständig fachlich löschbar." });
            return false;
        }
        const permission = resource.resource_type === "calculator_records"
            ? "calculator.delete"
            : modulePermission[resource.domain];
        if (!permission || !req.auth.permissions.includes(permission)) {
            reply.code(403).send({ error: "forbidden" });
            return false;
        }
        return true;
    }
    async function state(id, client = query) {
        const result = await client(`SELECT r.*,du.email AS deleted_by_email,ru.email AS restored_by_email,
        rc.legal_hold AS retention_legal_hold,rc.hold_reason,rc.audit_hold,rc.audit_hold_reason,
        rc.retention_until AS controlled_retention_until
       FROM app.resources r
       LEFT JOIN iam.users du ON du.id=r.deleted_by
       LEFT JOIN iam.users ru ON ru.id=r.restored_by
       LEFT JOIN integration.retention_controls rc ON rc.resource_id=r.id
       WHERE r.id=$1`, [id]);
        if (!result.rowCount)
            return null;
        const resource = result.rows[0];
        const dependencies = (await client(`SELECT relation.kind,relation.related_id,related.title
         FROM (
           SELECT 'Datei'::text kind,rf.file_id related_id
           FROM app.resource_files rf WHERE rf.resource_id=$1
           UNION ALL
           SELECT 'Aktive Referenz'::text,r2.id
           FROM app.resources r2
           WHERE r2.deleted_at IS NULL AND r2.id<>$1
             AND r2.data::text LIKE '%'||$1::text||'%'
         ) relation
         LEFT JOIN app.resources related ON related.id=relation.related_id`, [id])).rows;
        const files = (await client(`SELECT f.id,f.original_name,f.storage_name,f.sha256,
          (SELECT count(*)::int FROM app.resource_files x WHERE x.file_id=f.id AND x.resource_id<>$1) other_references
         FROM app.resource_files rf JOIN files.objects f ON f.id=rf.file_id
         WHERE rf.resource_id=$1 AND f.deleted_at IS NULL`, [id])).rows;
        const blockers = [];
        if (resource.legal_hold || resource.retention_legal_hold)
            blockers.push({ code: "legal_hold", message: resource.hold_reason || "Legal Hold ist aktiv." });
        if (resource.audit_hold)
            blockers.push({ code: "audit_hold", message: resource.audit_hold_reason || "Audit- oder Nachweispflicht ist aktiv." });
        const retention = resource.retention_until || resource.controlled_retention_until;
        if (retention && new Date(retention) > new Date())
            blockers.push({ code: "retention", message: `Aufbewahrungsfrist bis ${new Date(retention).toLocaleDateString("de-DE")}.` });
        for (const dependency of dependencies.filter((x) => x.kind === "Aktive Referenz"))
            blockers.push({ code: "active_dependency", message: `Aktive Abhängigkeit: ${dependency.title || dependency.related_id}` });
        return { ...resource, dependencies, files, blockers, permanentlyDeletable: blockers.length === 0 };
    }
    async function freshReauthentication(req, reply) {
        const verified = Date.parse(req.auth?.mfaVerifiedAt || "");
        if (!Number.isFinite(verified) || Date.now() - verified > 5 * 60 * 1000) {
            reply.code(403).send({ error: "reauthentication_required" });
            return false;
        }
        const token = String(req.body?.reauthToken || "");
        if (token.length < 32 || !(await ctx.consumeDeleteReauth(token, req.auth.sessionHash))) {
            reply.code(403).send({ error: "reauthentication_required" });
            return false;
        }
        return true;
    }
    app.get("/api/admin/v1/trash/preflight/:id", { preHandler: ctx.requirePermission("trash.view") }, async (req, reply) => {
        if (!uuid.safeParse(req.params.id).success)
            return reply.code(400).send({ error: "invalid_internal_id" });
        const item = await state(req.params.id);
        if (!item)
            return reply.code(404).send({ error: "not_found" });
        if (!(await requireResourceAccess(req, reply, item)))
            return;
        await ctx.audit(req, "delete_requested", item.resource_type, item.id, [], { dependencyCount: item.dependencies.length });
        return { item };
    });
    app.get("/api/admin/v1/trash", { preHandler: ctx.requirePermission("trash.view") }, async (req) => {
        const values = [];
        let where = "r.deleted_at IS NOT NULL";
        for (const [field, column] of [["module", "r.domain"], ["type", "r.resource_type"], ["deletedBy", "du.email"]]) {
            const value = String(req.query?.[field] || "").slice(0, 200);
            if (value) {
                values.push(value);
                where += ` AND ${column}=$${values.length}`;
            }
        }
        if (String(req.query?.legalHold || "") === "true")
            where += " AND (r.legal_hold OR COALESCE(rc.legal_hold,false))";
        if (String(req.query?.legalHold || "") === "false")
            where += " AND NOT r.legal_hold AND NOT COALESCE(rc.legal_hold,false)";
        const company = String(req.query?.company || "").slice(0, 200);
        if (company) {
            values.push(`%${company}%`);
            where += ` AND COALESCE(r.data->>'company',r.data->>'companyName','') ILIKE $${values.length}`;
        }
        const sector = String(req.query?.sector || "").slice(0, 200);
        if (sector) {
            values.push(`%${sector}%`);
            where += ` AND COALESCE(r.data->>'serviceSector',r.data->>'serviceSectorId',r.data->>'sector','') ILIKE $${values.length}`;
        }
        const deletedFrom = String(req.query?.deletedFrom || "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(deletedFrom)) {
            values.push(deletedFrom);
            where += ` AND r.deleted_at >= $${values.length}::date`;
        }
        const deletedTo = String(req.query?.deletedTo || "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(deletedTo)) {
            values.push(deletedTo);
            where += ` AND r.deleted_at < $${values.length}::date + interval '1 day'`;
        }
        const ids = (await query(`SELECT r.id FROM app.resources r
       LEFT JOIN iam.users du ON du.id=r.deleted_by
       LEFT JOIN integration.retention_controls rc ON rc.resource_id=r.id
       WHERE ${where} ORDER BY r.deleted_at DESC LIMIT 500`, values)).rows;
        const items = [];
        for (const row of ids) {
            const item = await state(row.id);
            if (item && await requireResourceAccess(req, { code: () => ({ send: () => undefined }) }, item))
                items.push(item);
        }
        const deletable = String(req.query?.deletable || "");
        const filtered = deletable === "true" ? items.filter((item) => item.permanentlyDeletable)
            : deletable === "false" ? items.filter((item) => !item.permanentlyDeletable) : items;
        return { items: filtered, total: filtered.length };
    });
    app.delete("/api/admin/v1/trash/:id", { preHandler: [ctx.requirePermission("trash.move"), ctx.csrf] }, async (req, reply) => {
        const parsed = z.object({ reason: z.string().trim().max(500).default(""), confirmed: z.literal(true) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "confirmation_required" });
        const before = await state(req.params.id);
        if (!before)
            return reply.code(404).send({ error: "not_found" });
        if (!(await requireResourceAccess(req, reply, before)))
            return;
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const changed = await client.query(`UPDATE app.resources SET deleted_at=now(),deleted_by=$1,delete_reason=$2,
          deletion_status='trash',previous_status=status,original_area=domain,
          scheduled_permanent_deletion_at=now()+interval '30 days',
          permanent_deletion_status='not_scheduled',restored_at=NULL,restored_by=NULL,updated_at=now()
         WHERE id=$3 AND deleted_at IS NULL RETURNING id,title,status`, [req.auth.userId, parsed.data.reason || null, before.id]);
            if (!changed.rowCount) {
                await client.query("ROLLBACK");
                return reply.code(404).send({ error: "not_found" });
            }
            await client.query(`INSERT INTO audit.events(actor_id,action,object_type,object_id,changed_fields,request_id,metadata)
         VALUES($1,'delete_confirmed',$2,$3,$4,$5,$6),($1,'moved_to_trash',$2,$3,$4,$5,$6)`, [req.auth.userId, before.resource_type, before.id, ["deleted_at", "deleted_by", "delete_reason", "deletion_status", "previous_status"], req.id, { reason: parsed.data.reason, previousStatus: before.status }]);
            await client.query("COMMIT");
            return { ok: true, recoverable: true, message: "Der Datensatz wurde in den Papierkorb verschoben." };
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    });
    app.post("/api/admin/v1/trash/restore", { preHandler: [ctx.requirePermission("trash.restore"), ctx.csrf] }, async (req, reply) => {
        const parsed = z.object({ ids: z.array(uuid).min(1).max(100) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_request" });
        const results = [];
        for (const id of parsed.data.ids) {
            const item = await state(id);
            if (!item || !(await requireResourceAccess(req, reply, item)))
                continue;
            const restored = await query(`UPDATE app.resources SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,
          deletion_status=CASE WHEN COALESCE(previous_status,status)='archived' THEN 'archived' ELSE 'active' END,
          status=COALESCE(previous_status,status),restored_at=now(),restored_by=$1,
          scheduled_permanent_deletion_at=NULL,permanent_deletion_status='not_scheduled',updated_at=now()
         WHERE id=$2 AND deleted_at IS NOT NULL RETURNING id`, [req.auth.userId, id]);
            if (restored.rowCount) {
                await ctx.audit(req, "restored_from_trash", item.resource_type, id, ["deleted_at", "status", "restored_at", "restored_by"]);
                results.push({ id, status: "restored" });
            }
        }
        return { ok: true, results, message: "Der Datensatz wurde wiederhergestellt." };
    });
    async function permanentOne(req, reply, id, confirmation, expected, reason) {
        if (confirmation !== expected || reason.trim().length < 3) {
            reply.code(400).send({ error: reason.trim().length < 3 ? "deletion_reason_required" : "confirmation_required" });
            return null;
        }
        const item = await state(id);
        if (!item) {
            reply.code(404).send({ error: "not_found" });
            return null;
        }
        if (!(await requireResourceAccess(req, reply, item)))
            return null;
        await ctx.audit(req, "permanent_delete_requested", item.resource_type, id);
        await ctx.audit(req, "legal_hold_checked", item.resource_type, id, [], { blocked: item.blockers.some((x) => x.code === "legal_hold") });
        await ctx.audit(req, "retention_checked", item.resource_type, id, [], { blocked: item.blockers.some((x) => x.code === "retention") });
        await ctx.audit(req, "dependencies_checked", item.resource_type, id, [], { blockers: item.blockers });
        if (!item.deleted_at) {
            reply.code(409).send({ error: "trash_only" });
            return null;
        }
        if (item.blockers.length) {
            await query("UPDATE app.resources SET permanent_deletion_status='blocked' WHERE id=$1", [id]);
            reply.code(423).send({ error: "deletion_blocked", message: item.blockers.map((x) => x.message).join(" ") });
            return null;
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("DELETE FROM app.resource_files WHERE resource_id=$1", [id]);
            await client.query("DELETE FROM cms.content_revisions WHERE resource_id=$1", [id]);
            await client.query("DELETE FROM cms.publication_events WHERE resource_id=$1", [id]);
            await client.query("DELETE FROM integration.retention_controls WHERE resource_id=$1", [id]);
            const deleted = await client.query("DELETE FROM app.resources WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id", [id]);
            if (!deleted.rowCount) {
                await client.query("ROLLBACK");
                reply.code(404).send({ error: "not_found" });
                return null;
            }
            await client.query("INSERT INTO audit.events(actor_id,action,object_type,object_id,changed_fields,request_id,metadata) VALUES($1,'permanently_deleted',$2,$3,$4,$5,$6)", [req.auth.userId, item.resource_type, id, ["permanent_deletion_status"], req.id, { reason }]);
            await client.query("COMMIT");
            return { id, status: "deleted" };
        }
        catch (error) {
            await client.query("ROLLBACK");
            await ctx.audit(req, "permanent_delete_failed", item.resource_type, id, [], { code: error?.code || "unknown" });
            reply.code(409).send({ error: "dependency_block", message: "Technische Integritätsbedingungen blockieren die endgültige Löschung." });
            return null;
        }
        finally {
            client.release();
        }
    }
    app.delete("/api/admin/v1/trash/:id/permanent", { preHandler: [ctx.requirePermission("trash.permanent.single"), ctx.csrf] }, async (req, reply) => {
        if (!(await freshReauthentication(req, reply)))
            return;
        const result = await permanentOne(req, reply, req.params.id, String(req.body?.confirmation || ""), "ENDGÜLTIG LÖSCHEN", String(req.body?.reason || ""));
        if (result)
            return { ok: true, result };
    });
    app.post("/api/admin/v1/trash/permanent", { preHandler: [ctx.requirePermission("trash.permanent.bulk"), ctx.csrf] }, async (req, reply) => {
        const parsed = z.object({ ids: z.array(uuid).min(1).max(100), confirmation: z.string(), reason: z.string(), reauthToken: z.string() }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: "invalid_request" });
        if (!(await freshReauthentication(req, reply)))
            return;
        if (parsed.data.confirmation !== "AUSGEWÄHLTE ENDGÜLTIG LÖSCHEN")
            return reply.code(400).send({ error: "confirmation_required" });
        const results = [];
        for (const id of parsed.data.ids) {
            const localReply = { code: () => ({ send: (body) => body }), send: (body) => body };
            const result = await permanentOne(req, localReply, id, "ENDGÜLTIG LÖSCHEN", "ENDGÜLTIG LÖSCHEN", parsed.data.reason);
            results.push(result || { id, status: "blocked_or_failed" });
        }
        await ctx.audit(req, "bulk_permanent_delete", "trash", undefined, [], { count: parsed.data.ids.length, results });
        return { ok: true, results };
    });
    app.post("/api/admin/v1/trash/empty", { preHandler: [ctx.requirePermission("trash.empty"), ctx.csrf] }, async (req, reply) => {
        if (req.body?.confirmation !== "PAPIERKORB LEEREN")
            return reply.code(400).send({ error: "confirmation_required" });
        if (!(await freshReauthentication(req, reply)))
            return;
        const ids = (await query("SELECT id FROM app.resources WHERE deleted_at IS NOT NULL ORDER BY deleted_at")).rows;
        const results = [];
        for (const row of ids) {
            const localReply = { code: () => ({ send: (body) => body }), send: (body) => body };
            const result = await permanentOne(req, localReply, row.id, "ENDGÜLTIG LÖSCHEN", "ENDGÜLTIG LÖSCHEN", String(req.body?.reason || "Papierkorb geleert"));
            results.push(result || { id: row.id, status: "blocked_or_failed" });
        }
        await ctx.audit(req, "trash_emptied", "trash", undefined, [], { count: ids.length, results });
        return {
            deleted: results.filter((x) => x.status === "deleted").length,
            anonymized: 0,
            skipped: results.filter((x) => x.status !== "deleted").length,
            blocked: results.filter((x) => x.status === "blocked_or_failed").length,
            failed: 0,
            results,
        };
    });
}
