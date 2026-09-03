import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import multipart from "@fastify/multipart";
import { Redis } from "ioredis";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as ArchiverModule from "archiver";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import sanitizeHtml from "sanitize-html";
import { pool, query } from "./db.js";
import { decryptSecret, encryptSecret, generateTotpSecret, hashToken, hashValue, ipPrefix, passwordHash, passwordVerify, randomToken, safeEqual, verifyTotp, } from "./security.js";
import { z } from "zod";
import { registerCalculatorRoutes } from "./calculator.js";
import { registerAutoSeoRoutes, validateAutoSeoConfiguration } from "./autoseo.js";
import { createIamUser } from "./iam-user-create.js";
import { registerGlobalTrashRoutes } from "./globalTrash.js";
import { defaultInterviewSubject, defaultInterviewText, invitationHtml, invitationValues, renderTemplate, validTeamsUrl, } from "./interviewInvitation.js";
const app = Fastify({
    logger: {
        redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.headers.x-wb-signature",
            "req.headers.x-autoseo-signature",
            "req.headers.x-autoseo-delivery",
            "req.body",
            "rawBody",
        ],
    },
    trustProxy: true,
    bodyLimit: 30_000_000,
});
app.removeContentTypeParser("application/json");
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = Buffer.from(body);
    try {
        done(null, JSON.parse(req.rawBody.toString("utf8")));
    }
    catch (error) {
        const parsingError = error;
        parsingError.statusCode = 422;
        done(parsingError, undefined);
    }
});
app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/"))
        reply.header("x-correlation-id", req.id);
    if (req.url.startsWith("/admin") || req.url === "/robots.txt")
        reply.header("x-robots-tag", "noindex, nofollow");
    if (req.url.startsWith("/admin/assets/"))
        reply.header("cache-control", "public,max-age=31536000,immutable");
    else if (req.url === "/admin" || req.url.startsWith("/admin/"))
        reply.header("cache-control", "no-store");
    return payload;
});
app.addHook("preValidation", async (req, reply) => {
    const id = req.params?.id;
    if (req.url.startsWith("/api/admin/") &&
        id !== undefined &&
        typeof id === "string" &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return reply
            .code(400)
            .send({
            error: "invalid_internal_id",
            message: "Die interne Datensatz-ID ist keine gültige UUID.",
            correlationId: req.id,
        });
    }
});
const redis = new Redis({
    host: process.env.REDIS_HOST || "redis",
    password: process.env.REDIS_PASSWORD,
    lazyConnect: false,
});
await app.register(cookie);
await app.register(multipart, {
    limits: { fileSize: 25_000_000, files: 1, fields: 20 },
});
await app.register(helmet, {
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            imgSrc: [
                "'self'",
                "data:",
                new URL(process.env.PUBLIC_MEDIA_BASE_URL || "https://www.wb-holding.ag").origin,
            ],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
        },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
});
await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
    redis,
    allowList: (req) => !req.url.startsWith("/api/"),
});
const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../admin/dist");
await app.register(staticPlugin, {
    root: adminRoot,
    prefix: "/admin/",
    wildcard: false,
});
for (const file of [
    "favicon.ico",
    "favicon.svg",
    "favicon-16x16.png",
    "favicon-32x32.png",
    "favicon-48x48.png",
    "apple-touch-icon.png",
    "android-chrome-192x192.png",
    "android-chrome-512x512.png",
    "maskable-icon-192x192.png",
    "maskable-icon-512x512.png",
    "site.webmanifest",
]) {
    app.get(`/${file}`, (_request, reply) => reply
        .header("Cache-Control", "public, max-age=86400, immutable")
        .sendFile(file));
}
app.get("/admin", (_, r) => r.redirect("/admin/"));
app.get("/admin/jobs", (_, r) => r.redirect("/admin/cms/jobs/"));
app.get("/admin/bewerbungen", (_, r) => r.redirect("/admin/recruiting/applications/"));
app.get("/admin/jobs/:careerId", (_, r) => r.sendFile("index.html"));
app.get("/admin/bewerbungen/:careerId", (_, r) => r.sendFile("index.html"));
app.get("/robots.txt", (_, r) => r.type("text/plain").send("User-agent: *\nDisallow: /\n"));
app.get("/admin/*", (req, r) => {
    const segment = String(req.params["*"] || "").split("/")[0];
    return ["cms", "recruiting", "crm", "security", "assets"].includes(segment)
        ? r.sendFile("index.html")
        : r.code(404).send({ error: "not_found" });
});
app.get("/api/healthz", async (_, r) => {
    await query("SELECT 1");
    await redis.ping();
    r.header("cache-control", "no-store");
    return { status: "ok" };
});
async function authenticate(req, reply) {
    const token = req.cookies.wb_session;
    if (!token)
        return reply.code(401).send({ error: "authentication_required" });
    const s = await query(`SELECT s.id_hash,s.csrf_hash,s.user_id,s.mfa_verified_at,u.email,array_remove(array_agg(DISTINCT p.code),NULL) permissions
 FROM iam.sessions s JOIN iam.users u ON u.id=s.user_id
 LEFT JOIN iam.user_roles ur ON ur.user_id=u.id LEFT JOIN iam.role_permissions rp ON rp.role_id=ur.role_id
 LEFT JOIN iam.permissions p ON p.id=rp.permission_id
 WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active
 GROUP BY s.id_hash,s.csrf_hash,s.user_id,s.mfa_verified_at,u.email`, [hashToken(token)]);
    if (!s.rowCount)
        return reply.code(401).send({ error: "authentication_required" });
    const row = s.rows[0];
    req.auth = {
        userId: row.user_id,
        email: row.email,
        permissions: row.permissions || [],
        csrf: row.csrf_hash,
        sessionHash: row.id_hash,
        mfaVerifiedAt: row.mfa_verified_at,
    };
    await query("UPDATE iam.sessions SET last_seen_at=now() WHERE id_hash=$1", [
        row.id_hash,
    ]);
}
function requirePermission(permission) {
    return async (req, reply) => {
        await authenticate(req, reply);
        if (reply.sent)
            return;
        if (!req.auth.permissions.includes(permission))
            return reply.code(403).send({ error: "forbidden" });
    };
}
async function csrf(req, reply) {
    const token = req.headers["x-csrf-token"];
    if (typeof token !== "string" ||
        !req.auth ||
        !safeEqual(hashToken(token), req.auth.csrf))
        return reply.code(403).send({ error: "csrf_failed" });
}
async function consumeDeleteReauth(token, sessionHash) {
    if (token.length < 32)
        return false;
    const key = `iam:delete-reauth:${hashToken(token)}`;
    const bound = await redis.get(key);
    if (bound !== sessionHash)
        return false;
    await redis.del(key);
    return true;
}
async function audit(req, action, type, id, fields = [], metadata = {}) {
    await query("INSERT INTO audit.events(actor_id,action,object_type,object_id,changed_fields,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)", [req.auth?.userId || null, action, type, id || null, fields, req.id, metadata]);
}
const careerDatabasePath = process.env.CAREER_DATABASE_PATH || "/career-data/wb-cms.sqlite";
const careerUploadRoot = path.resolve(process.env.CAREER_UPLOAD_ROOT || "/career-data/uploads");
let careerDatabaseInstance;
function careerDb() {
    if (!careerDatabaseInstance)
        careerDatabaseInstance = new DatabaseSync(careerDatabasePath);
    return careerDatabaseInstance;
}
function ensureSectorSchema() {
    careerDb().exec(`
 CREATE TABLE IF NOT EXISTS recruiting_sectors(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS recruiting_user_profiles(user_id TEXT PRIMARY KEY,first_name TEXT NOT NULL DEFAULT '',last_name TEXT NOT NULL DEFAULT '',global_access INTEGER NOT NULL DEFAULT 0,global_notification INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,created_by TEXT,updated_at TEXT NOT NULL,updated_by TEXT);
 CREATE TABLE IF NOT EXISTS recruiting_user_sectors(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,sector_id TEXT NOT NULL REFERENCES recruiting_sectors(id),access_active INTEGER NOT NULL DEFAULT 1,can_read INTEGER NOT NULL DEFAULT 1,can_edit INTEGER NOT NULL DEFAULT 0,notification_active INTEGER NOT NULL DEFAULT 0,is_primary INTEGER NOT NULL DEFAULT 0,is_delegate INTEGER NOT NULL DEFAULT 0,priority INTEGER NOT NULL DEFAULT 100,created_at TEXT NOT NULL,created_by TEXT,updated_at TEXT NOT NULL,updated_by TEXT,UNIQUE(user_id,sector_id));
 CREATE TABLE IF NOT EXISTS recruiting_job_sectors(job_id TEXT PRIMARY KEY,sector_id TEXT NOT NULL REFERENCES recruiting_sectors(id),updated_at TEXT NOT NULL,updated_by TEXT);
 CREATE TABLE IF NOT EXISTS recruiting_notification_rules(id TEXT PRIMARY KEY,sector_id TEXT NOT NULL REFERENCES recruiting_sectors(id),user_id TEXT NOT NULL,recipient_email TEXT NOT NULL,email_enabled INTEGER NOT NULL DEFAULT 1,is_primary INTEGER NOT NULL DEFAULT 0,is_delegate INTEGER NOT NULL DEFAULT 0,priority INTEGER NOT NULL DEFAULT 100,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,created_by TEXT,updated_at TEXT NOT NULL,updated_by TEXT,UNIQUE(sector_id,user_id));
 CREATE TABLE IF NOT EXISTS recruiting_global_notifications(id TEXT PRIMARY KEY,user_id TEXT,recipient_email TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,created_by TEXT,updated_at TEXT NOT NULL,updated_by TEXT);
 CREATE TABLE IF NOT EXISTS recruiting_notification_deliveries(id TEXT PRIMARY KEY,application_id TEXT NOT NULL,user_id TEXT,recipient_email TEXT NOT NULL,sector_id TEXT,delivery_status TEXT NOT NULL,delivered_at TEXT,message_id TEXT,retry_count INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',idempotency_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS recruiting_sector_audit(id TEXT PRIMARY KEY,action TEXT NOT NULL,actor_user_id TEXT,occurred_at TEXT NOT NULL,sector_id TEXT,object_type TEXT NOT NULL,object_id TEXT,old_value TEXT,new_value TEXT);
 CREATE INDEX IF NOT EXISTS recruiting_user_sectors_access ON recruiting_user_sectors(user_id,sector_id,access_active,can_read,can_edit);
 CREATE INDEX IF NOT EXISTS recruiting_notification_rules_sector ON recruiting_notification_rules(sector_id,active,email_enabled);
 CREATE INDEX IF NOT EXISTS recruiting_deliveries_application ON recruiting_notification_deliveries(application_id);
 `);
    const now = new Date().toISOString();
    for (const [id, code, name] of [
        ["security", "security", "Security"],
        ["cleaning", "cleaning", "Cleaning"],
        ["facility-management", "facility-management", "Facility Management"],
        ["surveillance", "surveillance", "Surveillance"],
        ["sicherheitstechnik", "sicherheitstechnik", "Sicherheitstechnik"],
        ["consulting", "consulting", "Consulting"],
        ["emergency-services", "emergency-services", "Emergency Services"],
        ["personalvermittlung", "personalvermittlung", "Personalvermittlung"],
        ["administration", "administration", "Konzern / Administration"],
    ])
        careerDb()
            .prepare("INSERT OR IGNORE INTO recruiting_sectors(id,code,name,created_at) VALUES(?,?,?,?)")
            .run(id, code, name, now);
    careerDb()
        .prepare("INSERT OR IGNORE INTO recruiting_global_notifications(id,user_id,recipient_email,active,created_at,created_by,updated_at,updated_by) VALUES('global-ingo',NULL,'ingo.wissmann@wb-holding.ag',1,?,'migration',?,'migration')")
        .run(now, now);
}
ensureSectorSchema();
function careerPayload(row) {
    try {
        return {
            ...JSON.parse(row.payload),
            _id: row.id,
            _createdDate: row.created_at,
            _updatedDate: row.updated_at,
        };
    }
    catch {
        return { _id: row.id };
    }
}
function careerItems(collection) {
    return careerDb()
        .prepare("SELECT id,payload,status,created_at,updated_at FROM content_items WHERE collection=? ORDER BY updated_at DESC")
        .all(collection).map(careerPayload);
}
function careerItem(collection, id) {
    const row = careerDb()
        .prepare("SELECT id,payload,status,created_at,updated_at FROM content_items WHERE collection=? AND id=?")
        .get(collection, id);
    return row ? careerPayload(row) : null;
}
function careerUpsert(collection, id, data, status = "published") {
    const now = new Date().toISOString(), existing = careerItem(collection, id);
    careerDb()
        .prepare(`INSERT INTO content_items(collection,id,payload,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,status=excluded.status,updated_at=excluded.updated_at`)
        .run(collection, id, JSON.stringify({ ...existing, ...data, _id: id }), status, data.sortOrder || 999, existing?._createdDate || now, now);
    return careerItem(collection, id);
}
const careerPermission = (domain) => requirePermission(domain === "cms" ? "cms.read" : "recruiting.read");
function mutationAllowed(req, domain) {
    const candidates = domain === "cms"
        ? ["cms.write", "cms.publish", "iam.manage"]
        : ["recruiting.write", "iam.manage"];
    return candidates.some((permission) => req.auth?.permissions?.includes(permission));
}
function requireCareerMutation(domain) {
    return async (req, reply) => {
        await authenticate(req, reply);
        if (reply.sent)
            return;
        if (!mutationAllowed(req, domain))
            return reply.code(403).send({ error: "forbidden" });
        if (domain === "recruiting" && req.params?.careerId) {
            const application = careerItem("applications", String(req.params.careerId));
            if (application && !applicationAllowed(req, application, true))
                return reply.code(403).send({ error: "forbidden" });
        }
    };
}
const questionTypes = new Set([
    "short_text",
    "long_text",
    "yes_no",
    "single_choice",
    "multiple_choice",
    "number",
    "date",
    "email",
    "phone",
]);
function normalizedQuestions(job) {
    return (Array.isArray(job?.screeningQuestions) ? job.screeningQuestions : [])
        .map((q, index) => ({
        id: String(q.id || crypto.randomUUID()),
        jobId: job._id,
        text: String(q.text || q.questionText || "").trim(),
        type: questionTypes.has(q.type) ? q.type : "short_text",
        required: Boolean(q.required),
        options: Array.isArray(q.options)
            ? q.options.map((x) => String(x).trim()).filter(Boolean)
            : [],
        order: Number.isFinite(Number(q.order)) ? Number(q.order) : index,
        active: q.active !== false,
        createdAt: q.createdAt || job._createdDate || new Date().toISOString(),
        updatedAt: q.updatedAt || job._updatedDate || new Date().toISOString(),
        createdBy: q.createdBy || "Altbestand",
        updatedBy: q.updatedBy || "Altbestand",
        archivedAt: q.archivedAt || null,
        archivedBy: q.archivedBy || null,
    }))
        .sort((a, b) => a.order - b.order)
        .map((q, index) => ({ ...q, order: index }));
}
function questionUsage(questionId) {
    return careerItems("applications").filter((application) => (application.screeningAnswers || []).some((answer) => answer.questionId === questionId)).length;
}
function validateQuestion(input) {
    const text = String(input?.text || "").trim(), type = String(input?.type || "");
    if (!text)
        return "Fragetext ist erforderlich.";
    if (!questionTypes.has(type))
        return "Fragetyp ist ungültig.";
    if (["single_choice", "multiple_choice"].includes(type)) {
        const options = (input.options || [])
            .map((x) => String(x).trim())
            .filter(Boolean);
        if (!options.length)
            return "Mindestens eine Antwortoption ist erforderlich.";
        if (new Set(options.map((x) => x.toLocaleLowerCase("de"))).size !==
            options.length)
            return "Doppelte Antwortoptionen sind nicht zulässig.";
    }
    return null;
}
function appendApplicationAudit(current, action, actor, details = {}) {
    return [
        ...(Array.isArray(current.auditTrail) ? current.auditTrail : []),
        { action, occurredAt: new Date().toISOString(), actor, details },
    ];
}
function sectorAudit(req, action, sectorId, type, id, oldValue, newValue) {
    careerDb()
        .prepare("INSERT INTO recruiting_sector_audit(id,action,actor_user_id,occurred_at,sector_id,object_type,object_id,old_value,new_value) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), action, req.auth?.userId || null, new Date().toISOString(), sectorId, type, id, oldValue === undefined ? null : JSON.stringify(oldValue), newValue === undefined ? null : JSON.stringify(newValue));
}
function isGlobalAdmin(req) {
    return Boolean(req.auth?.permissions?.includes("iam.manage"));
}
function applicationSector(application) {
    if (!application?.jobId)
        return null;
    return (careerDb()
        .prepare("SELECT sector_id FROM recruiting_job_sectors WHERE job_id=?")
        .get(application.jobId)?.sector_id || null);
}
function sectorGrant(req, sectorId, write = false) {
    if (isGlobalAdmin(req))
        return true;
    if (!sectorId)
        return false;
    return Boolean(careerDb()
        .prepare(`SELECT 1 FROM recruiting_user_sectors WHERE user_id=? AND sector_id=? AND access_active=1 AND ${write ? "can_edit" : "can_read"}=1`)
        .get(req.auth.userId, sectorId));
}
function applicationAllowed(req, application, write = false) {
    return sectorGrant(req, applicationSector(application), write);
}
function filteredApplications(req) {
    return careerItems("applications")
        .filter((item) => item.trashStatus !== "trashed")
        .filter((item) => applicationAllowed(req, item, false))
        .map((item) => ({
        ...item,
        serviceSectorId: applicationSector(item),
        sectorAssignmentRequired: !applicationSector(item),
        responsibilityWarning: !applicationSector(item) ||
            !careerDb()
                .prepare("SELECT 1 FROM recruiting_notification_rules WHERE sector_id=? AND active=1 AND email_enabled=1")
                .get(applicationSector(item) || ""),
    }));
}
function structuredTeam(item) {
    return {
        ...item,
        name: String(item.name || item.fullName || ""),
        fullName: String(item.name || item.fullName || ""),
        shortDescription: String(item.shortDescription || item.bio || ""),
        fullDescription: String(item.fullDescription || item.bio || ""),
        bio: String(item.fullDescription || item.bio || ""),
        imageId: String(item.imageId || ""),
        imageUrl: String(item.imageUrl || item.profilePicture || ""),
        profilePicture: String(item.imageUrl || item.profilePicture || ""),
        imageAlt: String(item.imageAlt || item.name || item.fullName || ""),
        imageFocalPointX: Number.isFinite(Number(item.imageFocalPointX)) ? Number(item.imageFocalPointX) : 50,
        imageFocalPointY: Number.isFinite(Number(item.imageFocalPointY)) ? Number(item.imageFocalPointY) : 50,
        imageCrop: String(item.imageCrop || "cover"),
        linkedinUrl: String(item.linkedinUrl || item.linkedInUrl || ""),
        linkedInUrl: String(item.linkedinUrl || item.linkedInUrl || ""),
        sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : 999,
        status: String(item.status || "draft"),
    };
}
function teamSlugExists(slug, exceptId = "") {
    const normalized = slug.trim().toLowerCase();
    if (!normalized)
        return false;
    return careerItems("teammembers").some((item) => item._id !== exceptId &&
        item.trashStatus !== "trashed" &&
        String(item.slug || "").trim().toLowerCase() === normalized);
}
function structuredJob(item) {
    item = normalizeJobPlainText(item);
    const cardImageId = String(item.cardImageId || item.imageId || "");
    const cardImageUrl = String(item.cardImageUrl ||
        item.imageUrl ||
        (String(item.image || "").startsWith("/") ? item.image : ""));
    const detailImageId = String(item.detailImageId || cardImageId);
    const detailImageUrl = String(item.detailImageUrl || cardImageUrl);
    return {
        ...item,
        sector: String(item.sector || item.area || ""),
        area: String(item.sector || item.area || ""),
        workingTime: String(item.workingTime || item.employmentType || ""),
        fullDescription: String(item.fullDescription || item.description || ""),
        responsibilities: String(item.responsibilities || item.tasks || ""),
        tasks: String(item.responsibilities || item.tasks || ""),
        imageId: cardImageId,
        imageUrl: cardImageUrl,
        cardImageId,
        cardImageUrl,
        cardImageAlt: String(item.cardImageAlt || item.imageAlt || item.title || ""),
        cardImageFocalPointX: Number.isFinite(Number(item.cardImageFocalPointX ?? item.imageFocalPointX)) ? Number(item.cardImageFocalPointX ?? item.imageFocalPointX) : 50,
        cardImageFocalPointY: Number.isFinite(Number(item.cardImageFocalPointY ?? item.imageFocalPointY)) ? Number(item.cardImageFocalPointY ?? item.imageFocalPointY) : 50,
        detailImageId,
        detailImageUrl,
        detailImageAlt: String(item.detailImageAlt || item.imageAlt || item.title || ""),
        detailImageFocalPointX: Number.isFinite(Number(item.detailImageFocalPointX ?? item.imageFocalPointX)) ? Number(item.detailImageFocalPointX ?? item.imageFocalPointX) : 50,
        detailImageFocalPointY: Number.isFinite(Number(item.detailImageFocalPointY ?? item.imageFocalPointY)) ? Number(item.detailImageFocalPointY ?? item.imageFocalPointY) : 50,
        imageAlt: String(item.imageAlt || item.title || ""),
        imageFocalPointX: Number.isFinite(Number(item.imageFocalPointX)) ? Number(item.imageFocalPointX) : 50,
        imageFocalPointY: Number.isFinite(Number(item.imageFocalPointY)) ? Number(item.imageFocalPointY) : 50,
        cardImageVariant: String(item.cardImageVariant || "landscape"),
        detailImageVariant: String(item.detailImageVariant || "hero"),
        sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : 999,
        applicationFormAssignment: String(item.applicationFormAssignment || "career-standard"),
        screeningQuestions: normalizedQuestions(item),
    };
}
app.get("/api/admin/v1/career/team", { preHandler: careerPermission("cms") }, async () => ({
    items: careerItems("teammembers")
        .filter((item) => item.trashStatus !== "trashed")
        .map(structuredTeam)
        .sort((a, b) => a.sortOrder - b.sortOrder),
}));
app.get("/api/admin/v1/career/team/by-id/:careerId", { preHandler: careerPermission("cms") }, async (req, reply) => {
    const item = careerItem("teammembers", req.params.careerId);
    return item ? structuredTeam(item) : reply.code(404).send({ error: "not_found" });
});
app.post("/api/admin/v1/career/team", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const id = crypto.randomUUID();
    const next = structuredTeam({ ...req.body, _id: id, status: req.body?.status || "draft", sortOrder: req.body?.sortOrder ?? 999 });
    if (!next.name.trim() || !next.position.trim())
        return reply.code(422).send({ error: "validation_failed", message: "Name und Position sind erforderlich." });
    if (teamSlugExists(String(next.slug || "")))
        return reply.code(409).send({ error: "slug_conflict", message: "Dieser Slug wird bereits verwendet." });
    const saved = careerUpsert("teammembers", id, next, next.status);
    await audit(req, "career_team_create", "career_team", id, Object.keys(req.body || {}));
    return reply.code(201).send(structuredTeam(saved));
});
app.patch("/api/admin/v1/career/team/by-id/:careerId", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const current = careerItem("teammembers", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    const next = structuredTeam({ ...current, ...req.body, _id: current._id });
    if (!next.name.trim() || !next.position.trim())
        return reply.code(422).send({ error: "validation_failed", message: "Name und Position sind erforderlich." });
    if (teamSlugExists(String(next.slug || ""), current._id))
        return reply.code(409).send({ error: "slug_conflict", message: "Dieser Slug wird bereits verwendet." });
    const saved = careerUpsert("teammembers", current._id, next, next.status);
    await audit(req, "career_team_update", "career_team", current._id, Object.keys(req.body || {}));
    return structuredTeam(saved);
});
app.post("/api/admin/v1/career/team/by-id/:careerId/lifecycle", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    if (!req.auth.permissions.includes("trash.move"))
        return reply.code(403).send({ error: "forbidden" });
    const current = careerItem("teammembers", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    if (req.body?.action !== "trash" || req.body?.confirm !== true)
        return reply.code(409).send({ error: "confirmation_required" });
    const now = new Date().toISOString();
    const saved = careerUpsert("teammembers", current._id, {
        ...current,
        previousStatus: current.status,
        status: "trash",
        trashStatus: "trashed",
        deletedAt: now,
        deletedBy: req.auth.email,
        deletionReason: String(req.body?.reason || "").slice(0, 500),
        scheduledDeletionAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    }, "trash");
    await audit(req, "career_team_moved_to_trash", "career_team", current._id, ["trashStatus", "status"]);
    return saved;
});
function previewSecret() {
    const value = String(process.env.SESSION_PEPPER || "");
    if (value.length < 32)
        throw new Error("preview_secret_not_configured");
    return value;
}
function signPreview(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", previewSecret()).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
}
function verifyPreview(token) {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature)
        return null;
    const expected = crypto.createHmac("sha256", previewSecret()).update(encoded).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
        return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.exp || Number(payload.exp) < Date.now())
        return null;
    return payload;
}
app.post("/api/admin/v1/preview/token", { preHandler: requirePermission("cms.read") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const parsed = z.object({
        type: z.enum(["team", "jobs"]),
        id: z.string().min(1).max(200),
        mode: z.enum(["card", "page", "grid", "detail"]),
    }).safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
    const collection = parsed.data.type === "team" ? "teammembers" : "jobangebote";
    if (!careerItem(collection, parsed.data.id))
        return reply.code(404).send({ error: "not_found" });
    const token = signPreview({
        ...parsed.data,
        sub: req.auth.userId,
        exp: Date.now() + 10 * 60_000,
        nonce: crypto.randomUUID(),
    });
    return {
        token,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        url: `${String(process.env.PREVIEW_WEBSITE_ORIGIN || "https://www.wb-holding.ag").replace(/\/$/, "")}/preview/cms?token=${encodeURIComponent(token)}`,
    };
});
app.get("/api/preview/v1/resolve", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    reply.header("x-robots-tag", "noindex, nofollow");
    reply.header("referrer-policy", "no-referrer");
    let payload;
    try {
        payload = verifyPreview(String(req.query?.token || ""));
    }
    catch {
        payload = null;
    }
    if (!payload)
        return reply.code(401).send({ error: "invalid_or_expired_preview" });
    const collection = payload.type === "team" ? "teammembers" : "jobangebote";
    const raw = careerItem(collection, payload.id);
    if (!raw)
        return reply.code(404).send({ error: "not_found" });
    const normalize = payload.type === "team" ? structuredTeam : structuredJob;
    const item = normalize(raw);
    const items = careerItems(collection)
        .filter((candidate) => candidate.status === "published" && candidate.trashStatus !== "trashed")
        .map(normalize)
        .filter((candidate) => candidate._id !== item._id)
        .concat(item)
        .sort((a, b) => Number(a.sortOrder || 999) - Number(b.sortOrder || 999));
    return { type: payload.type, mode: payload.mode, item, items, expiresAt: new Date(payload.exp).toISOString() };
});
app.get("/api/admin/v1/career/jobs", { preHandler: careerPermission("cms") }, async () => ({
    items: careerItems("jobangebote")
        .filter((item) => item.trashStatus !== "trashed")
        .map(structuredJob),
}));
app.post("/api/admin/v1/career/jobs/by-id/:careerId/lifecycle", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    if (!req.auth.permissions.includes("trash.move") && req.body?.action === "trash")
        return reply.code(403).send({ error: "forbidden" });
    if (!req.auth.permissions.includes("trash.restore") && req.body?.action === "restore")
        return reply.code(403).send({ error: "forbidden" });
    const current = careerItem("jobangebote", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    const action = String(req.body?.action || "");
    if (!["trash", "restore"].includes(action))
        return reply.code(422).send({ error: "invalid_action" });
    if (action === "trash" && req.body?.confirm !== true)
        return reply.code(409).send({ error: "confirmation_required" });
    const now = new Date().toISOString();
    const saved = careerUpsert("jobangebote", current._id, action === "trash"
        ? {
            ...current,
            previousStatus: current.status,
            status: "trash",
            active: false,
            trashStatus: "trashed",
            deletedAt: now,
            deletedBy: req.auth.email,
            deletionReason: String(req.body?.reason || "").slice(0, 500),
            scheduledDeletionAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        }
        : {
            ...current,
            status: current.previousStatus || "draft",
            active: current.previousStatus === "published",
            trashStatus: null,
            deletedAt: null,
            deletedBy: null,
            deletionReason: null,
            scheduledDeletionAt: null,
            restoredAt: now,
            restoredBy: req.auth.email,
        }, action === "trash" ? "trash" : current.previousStatus || "draft");
    await audit(req, action === "trash" ? "career_job_moved_to_trash" : "career_job_restored", "career_job", current._id, ["trashStatus", "status"], { reason: req.body?.reason || "" });
    return saved;
});
app.get("/api/admin/v1/career/trash", { preHandler: requirePermission("trash.view") }, async (req) => {
    const jobs = careerItems("jobangebote")
        .filter((item) => item.trashStatus === "trashed")
        .map((item) => ({
        id: item._id, external: true, collection: "jobangebote", domain: "cms",
        resource_type: "career_jobs", title: item.title, status: "trash",
        previous_status: item.previousStatus || "draft", original_area: "Karriere/Stellen",
        created_at: item._createdDate, deleted_at: item.deletedAt,
        deleted_by_email: item.deletedBy, delete_reason: item.deletionReason,
        scheduled_permanent_deletion_at: item.scheduledDeletionAt,
        dependencies: careerItems("applications").filter((application) => application.jobId === item._id)
            .map((application) => ({ kind: "Bewerbung", title: `${application.firstName} ${application.lastName}`, related_id: application._id })),
        blockers: careerItems("applications").some((application) => application.jobId === item._id)
            ? [{ code: "active_dependency", message: "Bestehende Bewerbungen schützen den historischen Stellenbezug." }]
            : [{ code: "career_retention", message: "Endgültige Löschung von Karriere-Stellen ist nur nach gesonderter Fristenprüfung zulässig." }],
        permanentlyDeletable: false,
    }));
    const team = careerItems("teammembers")
        .filter((item) => item.trashStatus === "trashed")
        .map((item) => ({
        id: item._id, external: true, collection: "teammembers", domain: "cms",
        resource_type: "career_team", title: item.name || item.fullName, status: "trash",
        previous_status: item.previousStatus || "draft", original_area: "CMS/Team",
        created_at: item._createdDate, deleted_at: item.deletedAt,
        deleted_by_email: item.deletedBy, delete_reason: item.deletionReason,
        scheduled_permanent_deletion_at: item.scheduledDeletionAt,
        dependencies: [],
        blockers: [{ code: "career_retention", message: "Endgültige Löschung von Teamprofilen ist nur nach gesonderter Fristenprüfung zulässig." }],
        permanentlyDeletable: false,
    }));
    const applications = careerItems("applications")
        .filter((item) => item.trashStatus === "trashed" && applicationAllowed(req, item, false))
        .map((item) => ({
        id: item._id, external: true, collection: "applications", domain: "recruiting",
        resource_type: "career_applications", title: `${item.firstName} ${item.lastName}`,
        status: "trash", previous_status: item.status, original_area: "Recruiting/Bewerbungen",
        created_at: item._createdDate, deleted_at: item.deletedAt,
        deleted_by_email: item.deletedBy, delete_reason: item.deletionReason,
        scheduled_permanent_deletion_at: item.scheduledDeletionAt,
        dependencies: (item.attachments || []).map((file) => ({ kind: "Anlage", title: file.originalName, related_id: file.id })),
        legal_hold: Boolean(item.legalHold),
        blockers: [{ code: item.legalHold ? "legal_hold" : "retention", message: item.legalHold ? "Legal Hold ist aktiv." : "Datenschutz- und Aufbewahrungsfrist muss vor endgültiger Löschung ablaufen." }],
        permanentlyDeletable: false,
    }));
    return { items: [...jobs, ...team, ...applications], total: jobs.length + team.length + applications.length };
});
app.post("/api/admin/v1/career/trash/restore", { preHandler: requirePermission("trash.restore") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const parsed = z.object({ collection: z.enum(["jobangebote", "teammembers", "applications"]), id: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
    const current = careerItem(parsed.data.collection, parsed.data.id);
    if (!current || current.trashStatus !== "trashed")
        return reply.code(404).send({ error: "not_found" });
    if (parsed.data.collection === "applications" && !applicationAllowed(req, current, true))
        return reply.code(403).send({ error: "forbidden" });
    const now = new Date().toISOString();
    const saved = careerUpsert(parsed.data.collection, current._id, {
        ...current, status: current.previousStatus || (parsed.data.collection === "applications" ? current.status : "draft"),
        active: parsed.data.collection === "jobangebote" && current.previousStatus === "published",
        trashStatus: null, deletedAt: null, deletedBy: null, deletionReason: null,
        scheduledDeletionAt: null, restoredAt: now, restoredBy: req.auth.email,
    }, current.previousStatus || (parsed.data.collection === "applications" ? "published" : "draft"));
    await audit(req, "restored_from_trash", parsed.data.collection === "applications" ? "career_application" : parsed.data.collection === "teammembers" ? "career_team" : "career_job", current._id);
    return { ok: true, item: saved, message: "Der Datensatz wurde wiederhergestellt." };
});
app.get("/api/admin/v1/career/sectors", { preHandler: requirePermission("recruiting.read") }, async () => ({
    items: careerDb()
        .prepare("SELECT id,code,name FROM recruiting_sectors WHERE active=1 ORDER BY name")
        .all(),
}));
app.get("/api/admin/v1/career/jobs/by-id/:careerId", { preHandler: careerPermission("cms") }, async (req, reply) => {
    const item = careerItem("jobangebote", req.params.careerId);
    if (!item)
        return reply.code(404).send({ error: "not_found" });
    const mapping = careerDb()
        .prepare("SELECT sector_id,updated_at,updated_by FROM recruiting_job_sectors WHERE job_id=?")
        .get(item._id);
    return {
        ...structuredJob(item),
        serviceSectorId: mapping?.sector_id || "",
        sectorAssignmentRequired: !mapping,
    };
});
app.post("/api/admin/v1/career/jobs", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const id = crypto.randomUUID(), saved = careerUpsert("jobangebote", id, structuredJob({ ...req.body, status: "draft", active: false, screeningQuestions: [] }), "draft");
    await audit(req, "career_job_create", "career_job", id, Object.keys(req.body || {}));
    return reply.code(201).send(saved);
});
app.patch("/api/admin/v1/career/jobs/by-id/:careerId", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const current = careerItem("jobangebote", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "status") ||
        Object.prototype.hasOwnProperty.call(req.body || {}, "active"))
        return reply.code(422).send({
            error: "status_action_required",
            message: "Status und Sichtbarkeit dürfen nur über eine bestätigte Statusaktion geändert werden.",
        });
    const currentStatus = String(current.status || "draft"), sectorId = String(req.body?.serviceSectorId || "");
    if (currentStatus === "published" && !sectorId)
        return reply
            .code(422)
            .send({
            error: "validation_failed",
            field: "sector",
            message: "Für veröffentlichte Stellen ist der Dienstleistungssektor erforderlich.",
            reference: req.id,
        });
    if (sectorId &&
        !careerDb()
            .prepare("SELECT 1 FROM recruiting_sectors WHERE id=? AND active=1")
            .get(sectorId))
        return reply.code(422).send({ error: "invalid_sector" });
    const questions = req.body?.screeningQuestions === undefined
        ? normalizedQuestions(current)
        : normalizedQuestions({
            ...current,
            screeningQuestions: req.body.screeningQuestions,
        }), { serviceSectorId, status: _status, active: _active, ...publicData } = req.body || {}, saved = careerUpsert("jobangebote", req.params.careerId, {
        ...structuredJob({ ...current, ...publicData }),
        screeningQuestions: questions,
        status: currentStatus,
        active: currentStatus === "published",
    }, currentStatus);
    const old = careerDb()
        .prepare("SELECT sector_id FROM recruiting_job_sectors WHERE job_id=?")
        .get(current._id)?.sector_id || null;
    if (sectorId) {
        const now = new Date().toISOString();
        careerDb()
            .prepare("INSERT INTO recruiting_job_sectors(job_id,sector_id,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET sector_id=excluded.sector_id,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
            .run(current._id, sectorId, now, req.auth.userId);
        if (old !== sectorId) {
            sectorAudit(req, "job_sector_assigned", sectorId, "career_job", current._id, old, sectorId);
            await audit(req, "career_job_sector_update", "career_job", current._id, ["serviceSectorId"]);
        }
    }
    await audit(req, "career_job_update", "career_job", req.params.careerId, Object.keys(publicData), {
        oldStatus: currentStatus,
        newStatus: currentStatus,
        statusPreserved: true,
    });
    return {
        ...saved,
        serviceSectorId: sectorId,
        sectorAssignmentRequired: !sectorId,
    };
});
app.post("/api/admin/v1/career/jobs/by-id/:careerId/status", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const current = careerItem("jobangebote", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    const action = String(req.body?.action || "");
    if (!["publish", "withdraw", "archive"].includes(action))
        return reply.code(422).send({ error: "invalid_status_action" });
    if (req.body?.confirm !== true)
        return reply.code(409).send({ error: "confirmation_required" });
    const mapping = careerDb()
        .prepare("SELECT sector_id FROM recruiting_job_sectors WHERE job_id=?")
        .get(current._id);
    if (action === "publish" && !mapping?.sector_id)
        return reply.code(422).send({
            error: "validation_failed",
            field: "sector",
            message: "Für veröffentlichte Stellen ist der Dienstleistungssektor erforderlich.",
            reference: req.id,
        });
    const oldStatus = String(current.status || "draft");
    const newStatus = action === "publish"
        ? "published"
        : action === "withdraw"
            ? "draft"
            : "archived";
    const saved = careerUpsert("jobangebote", current._id, {
        ...current,
        status: newStatus,
        active: newStatus === "published",
        publishedAt: newStatus === "published"
            ? current.publishedAt || new Date().toISOString()
            : current.publishedAt,
    }, newStatus);
    await audit(req, "career_job_status_transition", "career_job", current._id, ["status", "active"], {
        action,
        oldStatus,
        newStatus,
        oldActive: Boolean(current.active),
        newActive: newStatus === "published",
        reason: String(req.body?.reason || "").slice(0, 500),
    });
    return {
        ...saved,
        serviceSectorId: mapping?.sector_id || "",
        sectorAssignmentRequired: !mapping,
    };
});
app.post("/api/admin/v1/career/jobs/by-id/:careerId/duplicate", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const current = careerItem("jobangebote", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    const id = crypto.randomUUID(), saved = careerUpsert("jobangebote", id, {
        ...current,
        _id: id,
        title: `${current.title} (Kopie)`,
        slug: `${current.slug}-kopie-${id.slice(0, 8)}`,
        screeningQuestions: normalizedQuestions(current).map((q) => ({
            ...q,
            id: crypto.randomUUID(),
            jobId: id,
            createdAt: new Date().toISOString(),
            createdBy: req.auth.email,
        })),
        status: "draft",
        active: false,
    }, "draft");
    await audit(req, "career_job_duplicate", "career_job", id);
    return reply.code(201).send(saved);
});
app.get("/api/admin/v1/career/jobs/by-id/:careerId/questions", { preHandler: careerPermission("cms") }, async (req, reply) => {
    const job = careerItem("jobangebote", req.params.careerId);
    if (!job)
        return reply.code(404).send({ error: "not_found" });
    return {
        items: normalizedQuestions(job).map((q) => ({
            ...q,
            answerCount: questionUsage(q.id),
        })),
    };
});
app.post("/api/admin/v1/career/jobs/by-id/:careerId/questions", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const job = careerItem("jobangebote", req.params.careerId);
    if (!job)
        return reply.code(404).send({ error: "not_found" });
    const error = validateQuestion(req.body);
    if (error)
        return reply
            .code(422)
            .send({ error: "validation_failed", message: error });
    const now = new Date().toISOString(), questions = normalizedQuestions(job), question = {
        id: crypto.randomUUID(),
        jobId: job._id,
        text: String(req.body.text).trim(),
        type: req.body.type,
        required: Boolean(req.body.required),
        options: (req.body.options || [])
            .map((x) => String(x).trim())
            .filter(Boolean),
        order: questions.length,
        active: true,
        createdAt: now,
        updatedAt: now,
        createdBy: req.auth.email,
        updatedBy: req.auth.email,
        archivedAt: null,
        archivedBy: null,
    };
    careerUpsert("jobangebote", job._id, { ...job, screeningQuestions: [...questions, question] }, job.status);
    await audit(req, "screening_question_create", "screening_question", question.id, ["text", "type", "required", "options"]);
    return reply.code(201).send({ ...question, answerCount: 0 });
});
app.patch("/api/admin/v1/career/jobs/by-id/:careerId/questions/:questionId", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const job = careerItem("jobangebote", req.params.careerId);
    if (!job)
        return reply.code(404).send({ error: "not_found" });
    const questions = normalizedQuestions(job), index = questions.findIndex((q) => q.id === req.params.questionId);
    if (index < 0)
        return reply.code(404).send({ error: "not_found" });
    const candidate = {
        ...questions[index],
        ...req.body,
        id: questions[index].id,
        jobId: job._id,
        updatedAt: new Date().toISOString(),
        updatedBy: req.auth.email,
    };
    const error = validateQuestion(candidate);
    if (error)
        return reply
            .code(422)
            .send({ error: "validation_failed", message: error });
    questions[index] = candidate;
    careerUpsert("jobangebote", job._id, { ...job, screeningQuestions: questions }, job.status);
    await audit(req, "screening_question_update", "screening_question", candidate.id, Object.keys(req.body || {}));
    return { ...candidate, answerCount: questionUsage(candidate.id) };
});
app.post("/api/admin/v1/career/jobs/by-id/:careerId/questions/reorder", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const job = careerItem("jobangebote", req.params.careerId);
    if (!job)
        return reply.code(404).send({ error: "not_found" });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [], questions = normalizedQuestions(job);
    if (ids.length !== questions.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !questions.some((q) => q.id === id)))
        return reply.code(422).send({ error: "invalid_order" });
    const reordered = ids.map((id, order) => ({
        ...questions.find((q) => q.id === id),
        order,
        updatedAt: new Date().toISOString(),
        updatedBy: req.auth.email,
    }));
    careerUpsert("jobangebote", job._id, { ...job, screeningQuestions: reordered }, job.status);
    await audit(req, "screening_question_reorder", "career_job", job._id, [
        "screeningQuestions",
    ]);
    return { items: reordered };
});
app.delete("/api/admin/v1/career/jobs/by-id/:careerId/questions/:questionId", { preHandler: requireCareerMutation("cms") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const job = careerItem("jobangebote", req.params.careerId);
    if (!job)
        return reply.code(404).send({ error: "not_found" });
    const questions = normalizedQuestions(job), question = questions.find((q) => q.id === req.params.questionId);
    if (!question)
        return reply.code(404).send({ error: "not_found" });
    if (questionUsage(question.id) > 0)
        return reply
            .code(409)
            .send({
            error: "question_has_answers",
            message: "Bereits beantwortete Fragen können nur archiviert werden.",
        });
    careerUpsert("jobangebote", job._id, {
        ...job,
        screeningQuestions: questions
            .filter((q) => q.id !== question.id)
            .map((q, order) => ({ ...q, order })),
    }, job.status);
    await audit(req, "screening_question_delete", "screening_question", question.id);
    return reply.code(204).send();
});
app.get("/api/admin/v1/career/applications", { preHandler: careerPermission("recruiting") }, async (req) => ({ items: filteredApplications(req) }));
app.get("/api/admin/v1/career/applications/by-id/:careerId", { preHandler: careerPermission("recruiting") }, async (req, reply) => {
    const item = careerItem("applications", req.params.careerId);
    if (!item)
        return reply.code(404).send({ error: "not_found" });
    if (!applicationAllowed(req, item, false))
        return reply.code(403).send({ error: "forbidden" });
    const sectorId = applicationSector(item);
    await audit(req, "career_application_sector_open", "career_application", req.params.careerId, sectorId ? [sectorId] : []);
    sectorAudit(req, "application_opened", sectorId, "career_application", item._id, null, null);
    return {
        ...item,
        serviceSectorId: sectorId,
        sectorAssignmentRequired: !sectorId,
    };
});
app.patch("/api/admin/v1/career/applications/by-id/:careerId", { preHandler: requireCareerMutation("recruiting") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const current = careerItem("applications", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    if (!applicationAllowed(req, current, true))
        return reply.code(403).send({ error: "forbidden" });
    const allowed = [
        "firstName",
        "lastName",
        "email",
        "phone",
        "address",
        "internalClassification",
        "status",
        "jobId",
        "jobSlug",
        "jobTitleSnapshot",
    ], updates = {};
    for (const key of allowed)
        if (req.body?.[key] !== undefined)
            updates[key] = String(req.body[key]).slice(0, 1000);
    if (((updates.email && updates.email !== current.email) ||
        (updates.jobId && updates.jobId !== current.jobId)) &&
        req.body?.confirmSensitive !== true)
        return reply
            .code(409)
            .send({
            error: "confirmation_required",
            message: "E-Mail-Adresse und Stellenzuordnung erfordern eine ausdrückliche Bestätigung.",
        });
    const changes = Object.entries(updates)
        .filter(([key, value]) => current[key] !== value)
        .map(([field, newValue]) => ({
        field,
        oldValue: current[field] ?? null,
        newValue,
        changedAt: new Date().toISOString(),
        changedBy: req.auth.email,
        reason: String(req.body?.reason || "").slice(0, 500),
    }));
    const notes = Array.isArray(current.notes) ? current.notes : [];
    if (req.body?.note)
        notes.push({
            text: String(req.body.note).slice(0, 4000),
            createdAt: new Date().toISOString(),
            author: req.auth.email,
        });
    const originalSubmission = current.originalSubmission || {
        firstName: current.firstName,
        lastName: current.lastName,
        email: current.email,
        phone: current.phone,
        address: current.address,
        jobId: current.jobId,
        jobSlug: current.jobSlug,
        jobTitleSnapshot: current.jobTitleSnapshot,
        message: current.message,
        screeningAnswers: current.screeningAnswers,
        submittedAt: current.submittedAt || current.applicationDate,
    };
    const action = req.body?.note
        ? "Interne Notiz hinzugefügt"
        : changes.length
            ? "Bewerbungsdaten bearbeitet"
            : "Status geändert", saved = careerUpsert("applications", req.params.careerId, {
        ...current,
        ...updates,
        notes,
        originalSubmission,
        changeHistory: [...(current.changeHistory || []), ...changes],
        auditTrail: appendApplicationAudit(current, action, req.auth.email, {
            fields: changes.map((x) => x.field),
            reason: String(req.body?.reason || "").slice(0, 500),
        }),
    }, "published");
    const sectorId = applicationSector(current);
    await audit(req, "career_application_sector_update", "career_application", req.params.careerId, [...Object.keys(req.body || {}), ...(sectorId ? [sectorId] : [])]);
    sectorAudit(req, "application_updated", sectorId, "career_application", current._id, null, Object.keys(req.body || {}));
    return saved;
});
app.post("/api/admin/v1/career/applications/by-id/:careerId/lifecycle", { preHandler: requireCareerMutation("recruiting") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const current = careerItem("applications", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    const action = String(req.body?.action || ""), now = new Date().toISOString();
    if (!["archive", "trash", "restore"].includes(action))
        return reply.code(422).send({ error: "invalid_action" });
    if (action === "trash" && !req.auth.permissions.includes("trash.move"))
        return reply.code(403).send({ error: "forbidden" });
    if (action === "restore" && !req.auth.permissions.includes("trash.restore"))
        return reply.code(403).send({ error: "forbidden" });
    if (action === "trash" && req.body?.confirm !== true)
        return reply.code(409).send({ error: "confirmation_required" });
    const patch = action === "archive"
        ? { status: "Archiviert", archivedAt: now, archivedBy: req.auth.email }
        : action === "trash"
            ? {
                previousStatus: current.status,
                trashStatus: "trashed",
                deletedAt: now,
                deletedBy: req.auth.email,
                deletionReason: String(req.body?.reason || "").slice(0, 500),
                restoreUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
                scheduledDeletionAt: new Date(Date.now() + 31 * 86400000).toISOString(),
            }
            : {
                status: current.previousStatus || current.status,
                trashStatus: null,
                deletedAt: null,
                deletedBy: null,
                deletionReason: null,
                restoreUntil: null,
                scheduledDeletionAt: null,
                restoredAt: now,
                restoredBy: req.auth.email,
            };
    const saved = careerUpsert("applications", current._id, {
        ...current,
        ...patch,
        auditTrail: appendApplicationAudit(current, action === "archive"
            ? "Bewerbung archiviert"
            : action === "trash"
                ? "In Papierkorb verschoben"
                : "Bewerbung wiederhergestellt", req.auth.email),
    }, "published");
    await audit(req, `career_application_${action}`, "career_application", current._id);
    return saved;
});
app.delete("/api/admin/v1/career/applications/by-id/:careerId/permanent", { preHandler: requirePermission("iam.manage") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const current = careerItem("applications", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    if (req.headers["x-confirm-permanent-delete"] !== "DELETE" ||
        req.body?.reauthenticated !== true)
        return reply.code(409).send({ error: "confirmation_required" });
    if (current.legalHold)
        return reply.code(423).send({ error: "legal_hold" });
    if (current.trashStatus !== "trashed" ||
        (!current._id.startsWith("test-") &&
            !String(current.firstName || "").includes("SYSTEMTEST")))
        return reply.code(409).send({ error: "retention_or_test_guard" });
    const assets = (current.attachments || []).map((x) => x.id);
    careerDb().exec("BEGIN");
    try {
        careerDb()
            .prepare("DELETE FROM content_items WHERE collection='applications' AND id=?")
            .run(current._id);
        for (const id of assets) {
            const row = careerDb()
                .prepare("SELECT disk_name FROM assets WHERE id=?")
                .get(id);
            if (row) {
                const target = path.resolve(careerUploadRoot, row.disk_name);
                if (target.startsWith(careerUploadRoot + path.sep) &&
                    fs.existsSync(target))
                    fs.unlinkSync(target);
                careerDb().prepare("DELETE FROM assets WHERE id=?").run(id);
            }
        }
        careerDb().exec("COMMIT");
    }
    catch (error) {
        careerDb().exec("ROLLBACK");
        throw error;
    }
    await audit(req, "career_application_permanent_delete", "career_application", current._id);
    return reply.code(204).send();
});
function buildIcs(invitation, application, uid) {
    const esc = (value) => String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/,/g, "\\,")
        .replace(/;/g, "\\;")
        .replace(/\r?\n/g, "\\n");
    const stamp = (value) => new Date(value)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\\.\\d{3}Z$/, "Z");
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//WB-Holding AG//Recruiting//DE",
        "CALSCALE:GREGORIAN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${stamp(new Date())}`,
        `DTSTART:${stamp(invitation.start)}`,
        `DTEND:${stamp(invitation.end)}`,
        `SUMMARY:${esc(`Vorstellungsgespräch – ${application.jobTitleSnapshot || application.jobTitle || "Bewerbung"}`)}`,
        `DESCRIPTION:${esc(invitation.message)}`,
        `LOCATION:${esc(invitation.location)}`,
        "STATUS:CONFIRMED",
        "SEQUENCE:0",
        `ORGANIZER;CN=WB-Holding Recruiting:mailto:bewerbung@wb-holding.ag`,
        `ATTENDEE;CN=${esc(`${application.firstName} ${application.lastName}`)};RSVP=TRUE:mailto:${application.email}`,
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ].join("\r\n");
}
async function sendInterview(application, communication) {
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"])
        if (!process.env[key])
            throw new Error("smtp_configuration_missing");
    const port = Number(process.env.SMTP_PORT || 587), transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465 ||
            String(process.env.SMTP_SECURE).toLowerCase() === "true",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
    const info = await transport.sendMail({
        from: "bewerbung@wb-holding.ag",
        to: application.email,
        replyTo: process.env.RECRUITING_REPLY_TO || "ingo.wissmann@wb-holding.ag",
        cc: communication.copyInternal ? "ingo.wissmann@wb-holding.ag" : undefined,
        subject: communication.subject,
        text: communication.message,
        html: communication.html,
        attachments: [
            {
                filename: "vorstellungsgespraech.ics",
                content: communication.ics,
                contentType: "text/calendar; charset=utf-8; method=REQUEST",
            },
        ],
        headers: { "X-WB-Communication-ID": communication.id },
        messageId: `<interview-${communication.id}@wb-holding.ag>`,
    });
    return String(info.messageId || "");
}
async function upsertRecruitingAppointment(req, application, communication) {
    const data = {
        appointmentId: communication.id,
        applicantId: application.candidateId || application.applicantId || application._id,
        applicantReferenceType: application.candidateId || application.applicantId ? "candidate" : "legacy_application_applicant",
        applicantName: `${application.firstName || ""} ${application.lastName || ""}`.trim(),
        applicantEmail: application.email,
        applicationId: application._id,
        jobId: application.jobId || null,
        jobTitle: application.jobTitleSnapshot || application.jobTitle || "Bewerbung",
        start: communication.start, end: communication.end,
        durationMinutes: communication.durationMinutes, timezone: "Europe/Berlin",
        appointmentType: "Vorstellungsgespräch", meetingType: "Microsoft Teams",
        teamsLink: communication.teamsLink, status: communication.displayStatus,
        createdBy: communication.createdBy, createdAt: communication.createdAt,
        sentAt: communication.sentAt || null, deliveryStatus: communication.status,
        error: communication.error || null, updatedAt: communication.updatedAt,
        messageId: communication.messageId || null,
        sentBy: communication.sentBy || null,
        smtpResult: communication.smtpResult || null,
        errorReference: communication.errorReference || null,
    };
    const result = await query(`INSERT INTO app.resources(domain,resource_type,title,status,data,owner_id,source_system,external_id)
     VALUES('recruiting','appointments',$1,$2,$3,$4,'career_interview',$5)
     ON CONFLICT(source_system,resource_type,external_id) DO UPDATE SET
       title=excluded.title,status=excluded.status,data=excluded.data,updated_at=now(),version=app.resources.version+1
     RETURNING id`, [`Vorstellungsgespräch – ${data.applicantName}`, communication.status === "sent" ? "published" : "draft", data, req.auth.userId, communication.id]);
    return result.rows[0].id;
}
app.post("/api/admin/v1/career/applications/by-id/:careerId/interviews", {
    preHandler: requireCareerMutation("recruiting"),
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
}, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const current = careerItem("applications", req.params.careerId);
    if (!current)
        return reply.code(404).send({ error: "not_found" });
    const input = req.body || {}, start = new Date(input.start), end = new Date(input.end);
    if (!current.email ||
        !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) ||
        end <= start)
        return reply
            .code(422)
            .send({
            error: "validation_failed",
            message: "Empfänger, Beginn und Ende sind erforderlich.",
        });
    const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (![30, 45, 60].includes(durationMinutes))
        return reply.code(422).send({ error: "validation_failed", field: "duration", message: "Die Dauer muss 30, 45 oder 60 Minuten betragen." });
    const now = new Date().toISOString(), id = String(input.id || "");
    if (!uuid.safeParse(id).success)
        return reply.code(422).send({ error: "idempotency_key_required", field: "id", message: "Für die Einladung ist eine eindeutige Termin-ID erforderlich." });
    const existing = (current.communications || []).find((x) => x.id === id);
    if (existing?.status === "sent")
        return reply.send({ application: current, communication: existing });
    if (["creating", "sending"].includes(existing?.status))
        return reply.code(409).send({ error: "operation_in_progress", message: "Diese Einladung wird bereits verarbeitet. Bitte laden Sie den Status neu." });
    const teamsLink = String(input.teamsLink || input.location || "").trim();
    if (!validTeamsUrl(teamsLink))
        return reply.code(422).send({ error: "validation_failed", field: "teamsLink", message: "Bitte tragen Sie einen gültigen Microsoft-Teams-Besprechungslink ein." });
    if (!["Frau", "Herr", "Divers", "keine Angabe"].includes(input.salutation))
        return reply.code(422).send({ error: "validation_failed", field: "salutation", message: "Bitte wählen Sie eine Anrede." });
    const base = {
        id,
        start: start.toISOString(),
        end: end.toISOString(),
        teamsLink,
        salutation: input.salutation,
        contact: String(input.contact || "WB-Holding Recruiting").slice(0, 500),
    };
    const values = invitationValues(current, base);
    let subject, message, html;
    try {
        subject = renderTemplate(input.subject || defaultInterviewSubject, values).slice(0, 300);
        message = renderTemplate(input.message || defaultInterviewText, values).slice(0, 20000);
        if (!message.includes(teamsLink))
            throw new Error("teams_link_missing");
        html = invitationHtml(message, teamsLink);
    }
    catch (error) {
        return reply.code(422).send({
            error: "validation_failed", field: "message",
            message: error.message === "teams_link_missing" ? "Der gültige Teams-Link muss im Einladungstext enthalten sein." : "Die Einladung enthält einen nicht aufgelösten Platzhalter.",
        });
    }
    const communication = {
        ...base,
        type: "interview",
        status: input.send === true ? "creating" : "draft",
        displayStatus: input.send === true ? "Termin wird erstellt" : "Entwurf",
        recipient: current.email,
        subject, message, html, durationMinutes,
        timezone: "Europe/Berlin",
        mode: "Microsoft Teams",
        location: teamsLink,
        contact: String(input.contact || "").slice(0, 500),
        copyInternal: Boolean(input.copyInternal),
        createdAt: existing?.createdAt || now,
        createdBy: existing?.createdBy || req.auth.email,
        updatedAt: now,
        updatedBy: req.auth.email,
        attempts: existing?.attempts || 0,
        messageId: null,
    };
    communication.ics = buildIcs(communication, current, `${id}@wb-holding.ag`);
    const communications = (current.communications || []).filter((x) => x.id !== id);
    const persist = () => careerUpsert("applications", current._id, { ...current, communications: [...communications, communication] }, "published");
    persist();
    communication.appointmentResourceId = await upsertRecruitingAppointment(req, current, communication);
    if (input.send === true) {
        communication.attempts++;
        communication.status = "sending";
        communication.displayStatus = "Einladung wird versendet";
        communication.updatedAt = new Date().toISOString();
        persist();
        await upsertRecruitingAppointment(req, current, communication);
        try {
            communication.messageId = await sendInterview(current, communication);
            communication.status = "sent";
            communication.displayStatus = "Versendet";
            communication.sentAt = new Date().toISOString();
            communication.sentBy = req.auth.email;
            communication.smtpResult = "accepted";
        }
        catch (error) {
            communication.status = "failed";
            communication.displayStatus = "Versand fehlgeschlagen";
            communication.error = "Der Versand ist fehlgeschlagen.";
            communication.errorReference = req.id;
            communication.retryAvailable = true;
        }
        communication.updatedAt = new Date().toISOString();
        await upsertRecruitingAppointment(req, current, communication);
    }
    const saved = careerUpsert("applications", current._id, {
        ...current,
        status: communication.status === "sent" && input.updateStatus !== false
            ? "Vorstellungsgespräch eingeladen"
            : current.status,
        communications: [...communications, communication],
        auditTrail: appendApplicationAudit(current, communication.status === "sent"
            ? "Intervieweinladung versendet"
            : communication.status === "draft"
                ? "Intervieweinladung als Entwurf gespeichert"
                : "Intervieweinladung fehlgeschlagen", req.auth.email, { communicationId: id }),
    }, "published");
    await audit(req, communication.status === "sent"
        ? existing
            ? "career_interview_resent"
            : "career_interview_sent"
        : communication.status === "failed"
            ? "career_interview_send_failed"
            : existing
                ? "career_interview_updated"
                : "career_interview_created", "career_application", current._id, ["communications"], { communicationId: id, appointmentResourceId: communication.appointmentResourceId });
    return reply
        .code(communication.status === "failed" ? 502 : 201)
        .send({ application: saved, communication });
});
app.get("/api/admin/v1/career/attachments/:assetId/download", { preHandler: careerPermission("recruiting") }, async (req, reply) => {
    const row = careerDb()
        .prepare("SELECT * FROM assets WHERE id=? AND is_public=0")
        .get(req.params.assetId);
    if (!row)
        return reply.code(404).send({ error: "not_found" });
    const application = careerItems("applications").find((item) => (item.attachments || []).some((file) => file.id === req.params.assetId));
    if (!application || !applicationAllowed(req, application, false))
        return reply.code(403).send({ error: "forbidden" });
    const target = path.resolve(careerUploadRoot, row.disk_name);
    if (!target.startsWith(careerUploadRoot + path.sep) ||
        !fs.existsSync(target))
        return reply.code(404).send({ error: "not_found" });
    await audit(req, "career_attachment_sector_download", "career_attachment", req.params.assetId, applicationSector(application) ? [applicationSector(application)] : []);
    return reply
        .header("content-type", row.mime_type)
        .header("content-disposition", disposition(row.filename))
        .header("cache-control", "private,no-store")
        .header("x-content-type-options", "nosniff")
        .send(fs.createReadStream(target));
});
await query(`CREATE TABLE IF NOT EXISTS iam.recovery_codes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
 code_hash text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),used_at timestamptz
)`);
await query(`CREATE TABLE IF NOT EXISTS iam.password_reset_tokens(
 token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,used_at timestamptz
)`);
const loginSchema = z.object({
    email: z.string().email().max(254),
    password: z.string().min(12).max(1024),
});
const mfaSchema = z.object({
    challenge: z.string().min(32).max(512),
    code: z.string().min(6).max(64),
});
async function createAdminSession(req, reply, user, networkHash) {
    const session = randomToken(), csrfToken = randomToken();
    await query("INSERT INTO iam.sessions(id_hash,user_id,csrf_hash,ip_prefix_hash,user_agent_hash,mfa_verified_at,expires_at) VALUES($1,$2,$3,$4,$5,now(),now()+interval '8 hours')", [
        hashToken(session),
        user.id,
        hashToken(csrfToken),
        networkHash,
        hashValue(req.headers["user-agent"] || ""),
    ]);
    const secure = (process.env.PUBLIC_ORIGIN || "").startsWith("https:");
    reply.setCookie("wb_session", session, {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        maxAge: 28800,
    });
    reply.setCookie("wb_csrf", csrfToken, {
        httpOnly: false,
        secure,
        sameSite: "strict",
        path: "/",
        maxAge: 28800,
    });
    const permissions = await query("SELECT DISTINCT p.code FROM iam.user_roles ur JOIN iam.role_permissions rp ON rp.role_id=ur.role_id JOIN iam.permissions p ON p.id=rp.permission_id WHERE ur.user_id=$1", [user.id]);
    await audit({ auth: { userId: user.id }, id: req.id }, "login", "session");
    return {
        email: user.email,
        permissions: permissions.rows.map((x) => x.code),
        csrf: csrfToken,
        mfaRequired: true,
    };
}
app.post("/api/admin/v1/iam/login", { config: { rateLimit: false } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
    const email = parsed.data.email.trim().toLowerCase(), accountHash = hashValue(email), networkHash = hashValue(ipPrefix(req.ip));
    const recentFailures = await query("SELECT count(*)::int AS count FROM iam.login_attempts WHERE account_hash=$1 AND network_hash=$2 AND success=false AND created_at>now()-interval '15 minutes'", [accountHash, networkHash]);
    if (Number(recentFailures.rows[0]?.count || 0) >= 8)
        return reply.code(429).send({ error: "rate_limit_exceeded" });
    const result = await query("SELECT * FROM iam.users WHERE lower(email)=lower($1)", [email]);
    let user, passwordOk = false;
    if (result.rowCount) {
        user = result.rows[0];
        passwordOk =
            user.active &&
                (!user.locked_until || new Date(user.locked_until) < new Date()) &&
                (await passwordVerify(user.password_hash, parsed.data.password));
    }
    if (!passwordOk) {
        await query("INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES($1,$2,false)", [accountHash, networkHash]);
        if (user)
            await query("UPDATE iam.users SET failed_attempts=failed_attempts+1,locked_until=CASE WHEN failed_attempts>=4 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1", [user.id]);
        return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (!user.mfa_required || !user.mfa_secret_encrypted)
        return reply.code(403).send({ error: "mfa_setup_required" });
    const challenge = randomToken();
    await redis.set(`iam:preauth:${hashToken(challenge)}`, JSON.stringify({
        userId: user.id,
        networkHash,
        userAgentHash: hashValue(req.headers["user-agent"] || ""),
    }), "EX", 300, "NX");
    return { mfaRequired: true, challenge };
});
app.post("/api/admin/v1/iam/mfa", { config: { rateLimit: false } }, async (req, reply) => {
    const parsed = mfaSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
    const mfaRateKey = `iam:mfa-rate:${hashToken(parsed.data.challenge)}`;
    const mfaAttempts = await redis.incr(mfaRateKey);
    if (mfaAttempts === 1)
        await redis.expire(mfaRateKey, 900);
    if (mfaAttempts > 8)
        return reply.code(429).send({ error: "rate_limit_exceeded" });
    const key = `iam:preauth:${hashToken(parsed.data.challenge)}`, raw = await redis.get(key);
    if (!raw)
        return reply.code(401).send({ error: "mfa_challenge_expired" });
    const preauth = JSON.parse(raw);
    // A TOTP challenge must survive legitimate network changes between the
    // password and MFA requests (for example Safari Private Relay or mobile
    // handoff). The random, short-lived, one-time challenge remains bound to
    // the initiating browser user agent and protected by MFA rate limits.
    if (preauth.userAgentHash !== hashValue(req.headers["user-agent"] || ""))
        return reply.code(401).send({ error: "invalid_mfa" });
    const result = await query("SELECT * FROM iam.users WHERE id=$1 AND active", [preauth.userId]);
    if (!result.rowCount)
        return reply.code(401).send({ error: "invalid_mfa" });
    const user = result.rows[0];
    let valid = false, recovery = false;
    if (/^\d{6}$/.test(parsed.data.code)) {
        valid = Boolean(user.mfa_secret_encrypted &&
            verifyTotp(decryptSecret(user.mfa_secret_encrypted), parsed.data.code));
        if (valid) {
            const replay = await redis.set(`iam:totp-used:${user.id}:${hashToken(parsed.data.code)}`, "1", "EX", 90, "NX");
            valid = replay === "OK";
        }
    }
    else {
        const codeHash = hashToken(parsed.data.code.trim().toUpperCase()), used = await query("UPDATE iam.recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id", [user.id, codeHash]);
        valid = Boolean(used.rowCount);
        recovery = valid;
    }
    if (!valid) {
        await query("INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES($1,$2,false)", [hashValue(user.email.toLowerCase()), preauth.networkHash]);
        return reply.code(401).send({ error: "invalid_mfa" });
    }
    await redis.del(key);
    await redis.del(mfaRateKey);
    await query("UPDATE iam.users SET failed_attempts=0,locked_until=NULL WHERE id=$1", [user.id]);
    await query("INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES($1,$2,true)", [hashValue(user.email.toLowerCase()), preauth.networkHash]);
    if (recovery)
        await audit({ auth: { userId: user.id }, id: req.id }, "mfa_recovery_code_used", "user", user.id);
    return createAdminSession(req, reply, user, preauth.networkHash);
});
app.post("/api/admin/v1/iam/reauthenticate", {
    preHandler: [authenticate, csrf],
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
}, async (req, reply) => {
    const parsed = z
        .object({
        password: z.string().min(12).max(1024),
        totp: z.string().regex(/^\d{6}$/),
    })
        .safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
    const result = await query("SELECT password_hash,mfa_required,mfa_secret_encrypted FROM iam.users WHERE id=$1 AND active", [req.auth.userId]);
    const user = result.rows[0];
    const passwordOk = Boolean(user && (await passwordVerify(user.password_hash, parsed.data.password)));
    const mfaOk = Boolean(passwordOk &&
        user.mfa_required &&
        user.mfa_secret_encrypted &&
        verifyTotp(decryptSecret(user.mfa_secret_encrypted), parsed.data.totp));
    const replay = mfaOk
        ? await redis.set(`iam:totp-used:${req.auth.userId}:${hashToken(parsed.data.totp)}`, "1", "EX", 90, "NX")
        : null;
    if (!passwordOk || !mfaOk || replay !== "OK") {
        await audit(req, "calculator_delete_reauthentication_failed", "session", undefined, [], { passwordOk, mfaOk: mfaOk && replay === "OK" });
        return reply.code(403).send({ error: "reauthentication_failed" });
    }
    await query("UPDATE iam.sessions SET mfa_verified_at=now(),last_seen_at=now() WHERE id_hash=$1", [req.auth.sessionHash]);
    await audit(req, "calculator_delete_reauthenticated", "session", undefined, ["mfa_verified_at"]);
    const reauthToken = randomToken();
    await redis.set(`iam:delete-reauth:${hashToken(reauthToken)}`, req.auth.sessionHash, "EX", 300, "NX");
    return { ok: true, reauthToken, validForSeconds: 300 };
});
const forgotSchema = z.object({ email: z.string().email().max(254) });
const resetSchema = z
    .object({
    token: z.string().min(32).max(512),
    password: z.string().min(12).max(1024),
    confirmation: z.string().min(12).max(1024),
})
    .refine((value) => value.password === value.confirmation);
function systemMailTransport() {
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"])
        if (!process.env[key])
            throw new Error("smtp_configuration_missing");
    const port = Number(process.env.SMTP_PORT || 587);
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465 || String(process.env.SMTP_SECURE).toLowerCase() === "true",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
}
app.post("/api/admin/v1/iam/password/forgot", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req) => {
    const parsed = forgotSchema.safeParse(req.body), neutral = {
        ok: true,
        message: "Falls ein berechtigtes Konto besteht, wurde eine E-Mail zum Zurücksetzen versendet.",
    };
    if (!parsed.success)
        return neutral;
    const email = parsed.data.email.trim().toLowerCase(), user = (await query("SELECT id,email FROM iam.users WHERE lower(email)=$1 AND active=true", [email])).rows[0];
    if (!user)
        return neutral;
    const raw = randomToken(), tokenHash = hashToken(raw);
    await query("UPDATE iam.password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [user.id]);
    await query("INSERT INTO iam.password_reset_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')", [tokenHash, user.id]);
    const origin = String(process.env.PUBLIC_ORIGIN || "https://admin.wb-holding.ag").replace(/\/+$/, ""), url = `${origin}/admin/?reset=${encodeURIComponent(raw)}`;
    try {
        await systemMailTransport().sendMail({
            from: process.env.SYSTEM_MAIL_FROM || "bewerbung@wb-holding.ag",
            to: user.email,
            subject: "Passwort für das WB Adminportal zurücksetzen",
            text: `Für Ihr WB-Adminportal wurde eine Passwortänderung angefordert.\n\n${url}\n\nDer Link ist 30 Minuten und nur einmal gültig. Falls Sie dies nicht angefordert haben, ignorieren Sie diese Nachricht.`,
        });
        await audit({ auth: { userId: user.id }, id: crypto.randomUUID() }, "password_reset_requested", "user", user.id);
    }
    catch {
        await query("UPDATE iam.password_reset_tokens SET used_at=now() WHERE token_hash=$1", [tokenHash]);
    }
    return neutral;
});
app.post("/api/admin/v1/iam/password/reset", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req, reply) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success)
        return reply
            .code(400)
            .send({
            error: "invalid_request",
            message: "Das Passwort muss mindestens 12 Zeichen lang sein und die Bestätigung muss übereinstimmen.",
        });
    const tokenHash = hashToken(parsed.data.token), client = await pool.connect();
    try {
        await client.query("BEGIN");
        const row = (await client.query("SELECT t.user_id,u.active FROM iam.password_reset_tokens t JOIN iam.users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.used_at IS NULL AND t.expires_at>now() FOR UPDATE", [tokenHash])).rows[0];
        if (!row?.active) {
            await client.query("ROLLBACK");
            return reply
                .code(400)
                .send({
                error: "invalid_request",
                message: "Der Link ist ungültig oder abgelaufen.",
            });
        }
        await client.query("UPDATE iam.users SET password_hash=$1,failed_attempts=0,locked_until=NULL,updated_at=now() WHERE id=$2", [await passwordHash(parsed.data.password), row.user_id]);
        await client.query("UPDATE iam.password_reset_tokens SET used_at=now() WHERE token_hash=$1", [tokenHash]);
        await client.query("UPDATE iam.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [row.user_id]);
        await client.query("INSERT INTO iam.password_reset_events(user_id,actor_id) VALUES($1,$1)", [row.user_id]);
        await client.query("COMMIT");
        await audit({ auth: { userId: row.user_id }, id: req.id }, "password_reset_self", "user", row.user_id);
        return { ok: true };
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
});
app.post("/api/admin/v1/iam/recovery-codes", {
    preHandler: requirePermission("iam.manage"),
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
}, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const parsed = z
        .object({
        password: z.string().min(12).max(1024),
        totp: z.string().regex(/^\d{6}$/),
    })
        .safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
    const user = (await query("SELECT id,password_hash,mfa_secret_encrypted FROM iam.users WHERE id=$1 AND active=true", [req.auth.userId])).rows[0];
    if (!user ||
        !(await passwordVerify(user.password_hash, parsed.data.password)) ||
        !user.mfa_secret_encrypted ||
        !verifyTotp(decryptSecret(user.mfa_secret_encrypted), parsed.data.totp))
        return reply.code(401).send({ error: "authentication_required" });
    const codes = Array.from({ length: 10 }, () => `${crypto.randomBytes(3).toString("hex")}-${crypto.randomBytes(3).toString("hex")}`);
    await query("DELETE FROM iam.recovery_codes WHERE user_id=$1", [user.id]);
    for (const code of codes)
        await query("INSERT INTO iam.recovery_codes(user_id,code_hash) VALUES($1,$2)", [user.id, hashToken(code.toUpperCase())]);
    await audit(req, "mfa_recovery_codes_regenerated", "user", user.id);
    return { codes };
});
app.get("/api/admin/v1/iam/me", { preHandler: authenticate }, async (req) => ({
    email: req.auth.email,
    permissions: req.auth.permissions,
    csrf: req.cookies.wb_csrf || "",
}));
app.post("/api/admin/v1/iam/logout", { preHandler: [authenticate, csrf] }, async (req, reply) => {
    await query("UPDATE iam.sessions SET revoked_at=now() WHERE id_hash=$1", [
        req.auth.sessionHash,
    ]);
    reply.clearCookie("wb_session", { path: "/" });
    reply.clearCookie("wb_csrf", { path: "/" });
    return { ok: true };
});
const categoryPermissions = {
    cms: ["cms.read"],
    recruiting: ["recruiting.read"],
    crm: ["crm.read", "calculator.read"],
    security: ["iam.manage", "sessions.manage", "audit.read"],
};
async function categoryAccess(req, reply) {
    await authenticate(req, reply);
    if (reply.sent)
        return false;
    const category = String(req.params.category || ""), allowed = categoryPermissions[category];
    if (!allowed)
        return (reply.code(404).send({ error: "not_found" }), false);
    if (!allowed.some((p) => req.auth.permissions.includes(p)))
        return (reply.code(403).send({ error: "forbidden" }), false);
    const slug = String(req.params["*"] || "").split("/")[0];
    if (category === "security" && slug) {
        const auditOnly = ["audit", "downloads", "login-attempts"].includes(slug);
        if (auditOnly && !req.auth.permissions.includes("audit.read"))
            return (reply.code(403).send({ error: "forbidden" }), false);
        if (!auditOnly &&
            !req.auth.permissions.includes("iam.manage") &&
            !(slug === "sessions" && req.auth.permissions.includes("sessions.manage")))
            return (reply.code(403).send({ error: "forbidden" }), false);
    }
    if (category === "crm" &&
        slug === "calculator" &&
        !req.auth.permissions.includes("calculator.read"))
        return (reply.code(403).send({ error: "forbidden" }), false);
    if (category === "crm" &&
        slug &&
        slug !== "calculator" &&
        !req.auth.permissions.includes("crm.read"))
        return (reply.code(403).send({ error: "forbidden" }), false);
    return true;
}
app.get("/admin/:category/", async (req, reply) => {
    if (!(await categoryAccess(req, reply)))
        return;
    return reply.sendFile("index.html");
});
app.get("/admin/:category/*", async (req, reply) => {
    if (!(await categoryAccess(req, reply)))
        return;
    return reply.sendFile("index.html");
});
app.get("/api/admin/v1/categories/:category/summary", async (req, reply) => {
    if (!(await categoryAccess(req, reply)))
        return;
    const category = String(req.params.category);
    if (category === "cms") {
        const r = await query(`SELECT count(*)::int total,count(*) FILTER(WHERE status='draft')::int drafts,count(*) FILTER(WHERE status='published')::int published,count(*) FILTER(WHERE deleted_at IS NOT NULL)::int trash FROM app.resources WHERE domain='cms'`);
        return r.rows[0];
    }
    if (category === "recruiting") {
        const r = await query(`SELECT count(*)::int total,count(*) FILTER(WHERE resource_type='applications')::int applications,(SELECT count(*)::int FROM recruiting.application_files) documents,count(*) FILTER(WHERE resource_type='appointments')::int appointments FROM app.resources WHERE domain='recruiting' AND deleted_at IS NULL`);
        return r.rows[0];
    }
    if (category === "crm") {
        const r = await query(`SELECT count(*)::int total,count(*) FILTER(WHERE resource_type='companies')::int companies,count(*) FILTER(WHERE resource_type='leads')::int leads,count(*) FILTER(WHERE resource_type='opportunities')::int opportunities,count(*) FILTER(WHERE resource_type='calculator_records')::int calculator FROM app.resources WHERE domain='crm' AND deleted_at IS NULL`);
        return r.rows[0];
    }
    const r = await query(`SELECT (SELECT count(*)::int FROM iam.users WHERE active) users,(SELECT count(*)::int FROM iam.sessions WHERE revoked_at IS NULL AND expires_at>now()) sessions,(SELECT count(*)::int FROM audit.events) audit_events,(SELECT count(*)::int FROM iam.login_attempts WHERE created_at>now()-interval '24 hours') login_attempts`);
    return r.rows[0];
});
const resourceDomain = {
    services: "cms",
    blogposts: "cms",
    jobs: "cms",
    team: "cms",
    locations: "cms",
    industries: "cms",
    media: "cms",
    seo: "cms",
    applications: "recruiting",
    candidates: "recruiting",
    appointments: "recruiting",
    recruiting_notes: "recruiting",
    companies: "crm",
    contacts: "crm",
    leads: "crm",
    opportunities: "crm",
    pipelines: "crm",
    tasks: "crm",
    reminders: "crm",
    documents: "crm",
    activities: "crm",
    calculator_records: "crm",
};
const cmsTypes = [
    "services",
    "blogposts",
    "jobs",
    "team",
    "locations",
    "industries",
    "seo",
];
const privateRoot = path.resolve(process.env.PRIVATE_FILE_ROOT || "/data/private");
const uuid = z.string().uuid();
const safeName = (value) => value
    .replace(/[\r\n"]/g, "_")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .slice(0, 180) || "download";
const disposition = (name) => `attachment; filename="${safeName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
function assertStoragePath(storageName) {
    if (path.basename(storageName) !== storageName)
        throw new Error("invalid_storage_name");
    const result = path.resolve(privateRoot, storageName);
    if (!result.startsWith(privateRoot + path.sep))
        throw new Error("path_traversal");
    return result;
}
function signature(bytes) {
    if (bytes.subarray(0, 3).toString("hex") === "ffd8ff")
        return "image/jpeg";
    if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a")
        return "image/png";
    if (bytes.subarray(0, 4).toString() === "%PDF")
        return "application/pdf";
    if (bytes.subarray(0, 4).toString() === "RIFF" &&
        bytes.subarray(8, 12).toString() === "WEBP")
        return "image/webp";
    const start = bytes.subarray(0, 512).toString("utf8").trimStart();
    if (start.startsWith("<svg") ||
        (start.startsWith("<?xml") && start.includes("<svg")))
        return "image/svg+xml";
    return null;
}
function rasterDimensions(bytes, mime) {
    if (mime === "image/png" && bytes.length >= 24)
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (mime === "image/jpeg") {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff)
                break;
            const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2);
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
                return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
            if (length < 2)
                break;
            offset += 2 + length;
        }
    }
    if (mime === "image/webp" && bytes.length >= 30) {
        const kind = bytes.subarray(12, 16).toString();
        if (kind === "VP8X")
            return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
        if (kind === "VP8 " && bytes.subarray(23, 26).toString("hex") === "9d012a")
            return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
        if (kind === "VP8L" && bytes[20] === 0x2f) {
            const bits = bytes.readUInt32LE(21);
            return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
        }
    }
    return null;
}
function htmlToPlainText(value) {
    const source = String(value || "").replace(/\r\n?/g, "\n");
    if (!/<\/?[a-z][\s\S]*?>/i.test(source))
        return source;
    const prepared = source
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "• ")
        .replace(/<\/li\s*>/gi, "\n")
        .replace(/<\/?(?:h[1-6]|p)\b[^>]*>/gi, "\n\n")
        .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, "\n");
    return sanitizeHtml(prepared, { allowedTags: [], allowedAttributes: {} })
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
const jobPlainTextFields = [
    "shortDescription", "description", "fullDescription", "tasks",
    "responsibilities", "requirements", "benefits", "contactPerson",
];
function normalizeJobPlainText(item) {
    const next = { ...item };
    for (const field of jobPlainTextFields)
        if (field in next)
            next[field] = htmlToPlainText(next[field]);
    return next;
}
function permissionForDomain(domain, write = false) {
    return `${domain}.${write ? "write" : "read"}`;
}
async function fileRows(resourceId) {
    return (await query(`SELECT f.id,f.original_name,f.mime_type,f.size_bytes,f.sha256,rf.kind,rf.metadata
 FROM app.resource_files rf JOIN files.objects f ON f.id=rf.file_id WHERE rf.resource_id=$1 AND f.deleted_at IS NULL
 UNION ALL SELECT f.id,f.original_name,f.mime_type,f.size_bytes,f.sha256,af.field_name AS kind,'{}'::jsonb
 FROM recruiting.application_files af JOIN files.objects f ON f.id=af.file_id WHERE af.application_id=$1 AND f.deleted_at IS NULL`, [resourceId])).rows;
}
function domainPermission(type, write = false) {
    if (type === "calculator_records")
        return `calculator.${write ? "write" : "read"}`;
    const d = resourceDomain[type] || (type === "notes" ? "crm" : "");
    return `${d}.${write ? "write" : "read"}`;
}
app.get("/api/admin/v1/resources/:type", async (req, reply) => {
    const type = req.params.type;
    if (["users", "roles", "sessions"].includes(type)) {
        await requirePermission("iam.manage")(req, reply);
        if (reply.sent)
            return;
        const sql = type === "users"
            ? `SELECT u.id,u.email,u.active,u.mfa_required,(u.mfa_secret_encrypted IS NOT NULL) AS mfa_configured,u.created_at,u.updated_at,
 array_remove(array_agg(r.code),NULL) roles FROM iam.users u LEFT JOIN iam.user_roles ur ON ur.user_id=u.id LEFT JOIN iam.roles r ON r.id=ur.role_id GROUP BY u.id ORDER BY u.email`
            : type === "roles"
                ? "SELECT id,code AS title,label FROM iam.roles ORDER BY code"
                : "SELECT id_hash AS id,user_id,created_at,last_seen_at AS updated_at,expires_at,revoked_at FROM iam.sessions ORDER BY created_at DESC";
        return { items: (await query(sql)).rows, total: null, page: 1 };
    }
    if (type === "audit") {
        await requirePermission("audit.read")(req, reply);
        if (reply.sent)
            return;
        return {
            items: (await query("SELECT id,action AS title,object_type AS status,occurred_at AS updated_at FROM audit.events ORDER BY id DESC LIMIT 500")).rows,
            total: null,
            page: 1,
        };
    }
    if (!resourceDomain[type] && type !== "notes")
        return reply.code(404).send({ error: "not_found" });
    await requirePermission(domainPermission(type))(req, reply);
    if (reply.sent)
        return;
    const q = String(req.query?.q || "").slice(0, 200), status = String(req.query?.status || ""), page = Math.max(1, Number(req.query?.page) || 1), limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
    const sort = ["title", "status", "created_at", "updated_at"].includes(req.query?.sort)
        ? req.query.sort
        : "updated_at", direction = req.query?.direction === "asc" ? "ASC" : "DESC", deleted = req.query?.deleted === "true";
    const values = [type];
    let where = "resource_type=$1";
    if (!deleted)
        where += " AND deleted_at IS NULL";
    else
        where += " AND deleted_at IS NOT NULL";
    if (q) {
        values.push(`%${q}%`);
        where += ` AND (title ILIKE $${values.length} OR data::text ILIKE $${values.length})`;
    }
    if (status) {
        values.push(status);
        where += ` AND status=$${values.length}`;
    }
    const count = await query(`SELECT count(*)::int total FROM app.resources WHERE ${where}`, values);
    values.push(limit, (page - 1) * limit);
    const result = await query(`SELECT id,external_id AS "sourceId",data->>'slug' AS slug,title,status,data,version,deleted_at,created_at,updated_at FROM app.resources WHERE ${where} ORDER BY ${sort} ${direction} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items: result.rows, total: count.rows[0].total, page, limit };
});
app.post("/api/admin/v1/resources/:type", async (req, reply) => {
    const type = req.params.type;
    if (!resourceDomain[type] && type !== "notes")
        return reply.code(404).send({ error: "not_found" });
    await requirePermission(domainPermission(type, true))(req, reply);
    if (reply.sent)
        return;
    await csrf(req, reply);
    if (reply.sent)
        return;
    const parsed = z
        .object({
        title: z.string().min(1).max(300),
        status: z
            .enum(["draft", "review", "approved", "published", "archived"])
            .default("draft"),
    })
        .passthrough()
        .safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
    const result = await query("INSERT INTO app.resources(domain,resource_type,title,status,data,owner_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", [
        resourceDomain[type] || (type === "notes" ? "crm" : ""),
        type,
        parsed.data.title,
        parsed.data.status,
        parsed.data,
        req.auth.userId,
    ]);
    await audit(req, "create", type, result.rows[0].id, Object.keys(parsed.data));
    return reply.code(201).send(result.rows[0]);
});
app.get("/api/admin/v1/resources/:type/:id", async (req, reply) => {
    const { type, id } = req.params;
    if (!uuid.safeParse(id).success)
        return reply
            .code(400)
            .send({
            error: "invalid_internal_id",
            message: "Die interne Datensatz-ID ist keine gültige UUID.",
            correlationId: req.id,
        });
    await requirePermission(domainPermission(type))(req, reply);
    if (reply.sent)
        return;
    const r = await query("SELECT * FROM app.resources WHERE id=$1 AND resource_type=$2", [id, type]);
    if (!r.rowCount)
        return reply.code(404).send({ error: "not_found" });
    return {
        ...r.rows[0],
        sourceId: r.rows[0].external_id || null,
        slug: r.rows[0].data?.slug || null,
        files: await fileRows(id),
        revisions: (await query("SELECT id,version,created_at FROM cms.content_revisions WHERE resource_id=$1 ORDER BY version DESC", [id])).rows,
    };
});
app.patch("/api/admin/v1/resources/:type/:id", async (req, reply) => {
    const type = req.params.type;
    await requirePermission(domainPermission(type, true))(req, reply);
    if (reply.sent)
        return;
    await csrf(req, reply);
    if (reply.sent)
        return;
    const version = Number(req.headers["if-match"]);
    if (!Number.isInteger(version))
        return reply.code(428).send({ error: "if_match_required" });
    const body = z.record(z.unknown()).parse(req.body);
    const before = await query("SELECT data,title,status,version FROM app.resources WHERE id=$1 AND resource_type=$2 AND version=$3", [req.params.id, type, version]);
    if (!before.rowCount)
        return reply.code(409).send({ error: "version_conflict" });
    if (cmsTypes.includes(type))
        await query("INSERT INTO cms.content_revisions(resource_id,version,snapshot,actor_id) VALUES($1,$2,$3,$4)", [req.params.id, version, before.rows[0], req.auth.userId]);
    const result = await query("UPDATE app.resources SET data=data||$1,title=COALESCE($2,title),status=COALESCE($3,status),version=version+1,updated_at=now() WHERE id=$4 AND resource_type=$5 AND version=$6 RETURNING *", [
        body,
        body.title || null,
        body.status || null,
        req.params.id,
        type,
        version,
    ]);
    await audit(req, "update", type, req.params.id, Object.keys(body));
    return result.rows[0];
});
app.delete("/api/admin/v1/resources/:type/:id", async (req, reply) => {
    const { type, id } = req.params;
    await requirePermission("trash.move")(req, reply);
    if (reply.sent)
        return;
    await requirePermission(domainPermission(type, true))(req, reply);
    if (reply.sent)
        return;
    await csrf(req, reply);
    if (reply.sent)
        return;
    if (req.headers["x-confirm-delete"] !== "DELETE")
        return reply.code(400).send({ error: "confirmation_required" });
    const r = await query(`UPDATE app.resources SET deleted_at=now(),deleted_by=$1,delete_reason=NULL,
      deletion_status='trash',previous_status=status,original_area=domain,
      scheduled_permanent_deletion_at=now()+interval '30 days',updated_at=now()
     WHERE id=$2 AND resource_type=$3 AND deleted_at IS NULL RETURNING id`, [req.auth.userId, id, type]);
    if (!r.rowCount)
        return reply.code(404).send({ error: "not_found" });
    await audit(req, "soft_delete", type, id);
    return { ok: true, recoverable: true };
});
app.post("/api/admin/v1/resources/:type/:id/restore", async (req, reply) => {
    const { type, id } = req.params;
    await requirePermission("trash.restore")(req, reply);
    if (reply.sent)
        return;
    await requirePermission(domainPermission(type, true))(req, reply);
    if (reply.sent)
        return;
    await csrf(req, reply);
    if (reply.sent)
        return;
    const r = await query(`UPDATE app.resources SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,
       deletion_status=CASE WHEN COALESCE(previous_status,status)='archived' THEN 'archived' ELSE 'active' END,
       status=COALESCE(previous_status,status),restored_at=now(),restored_by=$1,
       scheduled_permanent_deletion_at=NULL,updated_at=now()
       WHERE id=$2 AND resource_type=$3 AND deleted_at IS NOT NULL RETURNING *`, [req.auth.userId, id, type]);
    if (!r.rowCount)
        return reply.code(404).send({ error: "not_found" });
    await audit(req, "restore", type, id);
    return r.rows[0];
});
app.post("/api/admin/v1/resources/:type/:id/workflow", async (req, reply) => {
    const { type, id } = req.params;
    await requirePermission(type && cmsTypes.includes(type) && req.body?.status === "published"
        ? "cms.publish"
        : domainPermission(type, true))(req, reply);
    if (reply.sent)
        return;
    await csrf(req, reply);
    if (reply.sent)
        return;
    const status = z
        .enum(["draft", "review", "approved", "published", "archived"])
        .parse(req.body?.status);
    const r = await query("UPDATE app.resources SET status=$1,version=version+1,updated_at=now() WHERE id=$2 AND resource_type=$3 RETURNING *", [status, id, type]);
    if (!r.rowCount)
        return reply.code(404).send({ error: "not_found" });
    if (cmsTypes.includes(type))
        await query("INSERT INTO cms.publication_events(resource_id,action,actor_id) VALUES($1,$2,$3)", [id, status, req.auth.userId]);
    await audit(req, "workflow", type, id, ["status"]);
    return r.rows[0];
});
app.get("/api/admin/v1/resources/:type/:id/preview", async (req, reply) => {
    await requirePermission(domainPermission(req.params.type))(req, reply);
    if (reply.sent)
        return;
    const r = await query("SELECT title,data,status FROM app.resources WHERE id=$1 AND resource_type=$2", [req.params.id, req.params.type]);
    if (!r.rowCount)
        return reply.code(404).send({ error: "not_found" });
    reply.type("text/html; charset=utf-8");
    const d = r.rows[0];
    return `<!doctype html><meta charset=utf-8><title>${d.title}</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:20px}img{max-width:100%}</style><h1>${d.title}</h1>${d.data.contentHtml || d.data.description || ""}`;
});
app.get("/api/public/v1/:type", async (req, reply) => {
    const type = req.params.type;
    if (![
        "services",
        "blogposts",
        "jobs",
        "locations",
        "industries",
        "team",
    ].includes(type))
        return reply.code(404).send({ error: "not_found" });
    const r = await query("SELECT id,title,data,updated_at FROM app.resources WHERE resource_type=$1 AND status='published' AND deleted_at IS NULL ORDER BY CASE WHEN $1='blogposts' THEN created_at END DESC NULLS LAST, CASE WHEN $1<>'blogposts' THEN created_at END ASC, id", [type]);
    reply.header("cache-control", "public,max-age=60");
    return { items: r.rows };
});
app.get("/api/admin/v1/audit", { preHandler: requirePermission("audit.read") }, async () => ({
    items: (await query("SELECT id,occurred_at,actor_id,action,object_type,object_id,changed_fields,success FROM audit.events ORDER BY id DESC LIMIT 500")).rows,
}));
app.get("/api/admin/v1/recruiting/responsibilities", { preHandler: requirePermission("iam.manage") }, async () => {
    const users = (await query(`SELECT u.id,u.email,u.active,u.mfa_required,(u.mfa_secret_encrypted IS NOT NULL) mfa_configured,u.updated_at,array_remove(array_agg(DISTINCT r.code),NULL) roles FROM iam.users u LEFT JOIN iam.user_roles ur ON ur.user_id=u.id LEFT JOIN iam.roles r ON r.id=ur.role_id GROUP BY u.id ORDER BY u.email`)).rows;
    const profiles = careerDb()
        .prepare("SELECT * FROM recruiting_user_profiles")
        .all(), assignments = careerDb()
        .prepare(`SELECT us.*,s.name sector_name FROM recruiting_user_sectors us JOIN recruiting_sectors s ON s.id=us.sector_id ORDER BY us.priority,s.name`)
        .all();
    return {
        sectors: careerDb()
            .prepare("SELECT id,code,name FROM recruiting_sectors WHERE active=1 ORDER BY name")
            .all(),
        users: users.map((user) => ({
            ...user,
            ...profiles.find((profile) => profile.user_id === user.id),
            sectors: assignments.filter((assignment) => assignment.user_id === user.id),
        })),
        globals: careerDb()
            .prepare("SELECT id,user_id,recipient_email,active,updated_at FROM recruiting_global_notifications ORDER BY recipient_email")
            .all(),
    };
});
app.put("/api/admin/v1/recruiting/responsibilities/:id", { preHandler: requirePermission("iam.manage") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const user = (await query("SELECT id,email FROM iam.users WHERE id=$1", [req.params.id])).rows[0];
    if (!user)
        return reply.code(404).send({ error: "not_found" });
    const parsed = z
        .object({
        firstName: z.string().max(200).default(""),
        lastName: z.string().max(200).default(""),
        globalAccess: z.boolean().default(false),
        globalNotification: z.boolean().default(false),
        sectors: z
            .array(z.object({
            sectorId: z.string(),
            accessActive: z.boolean().default(true),
            canRead: z.boolean().default(true),
            canEdit: z.boolean().default(false),
            notificationActive: z.boolean().default(false),
            isPrimary: z.boolean().default(false),
            isDelegate: z.boolean().default(false),
            priority: z.number().int().min(0).max(10000).default(100),
        }))
            .default([]),
    })
        .safeParse(req.body);
    if (!parsed.success)
        return reply.code(400).send({ error: "invalid_request" });
    const now = new Date().toISOString(), before = careerDb()
        .prepare("SELECT * FROM recruiting_user_sectors WHERE user_id=?")
        .all(user.id);
    careerDb().exec("BEGIN");
    try {
        careerDb()
            .prepare("INSERT INTO recruiting_user_profiles(user_id,first_name,last_name,global_access,global_notification,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,global_access=excluded.global_access,global_notification=excluded.global_notification,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
            .run(user.id, parsed.data.firstName, parsed.data.lastName, parsed.data.globalAccess ? 1 : 0, parsed.data.globalNotification ? 1 : 0, now, req.auth.userId, now, req.auth.userId);
        careerDb()
            .prepare("DELETE FROM recruiting_user_sectors WHERE user_id=?")
            .run(user.id);
        careerDb()
            .prepare("DELETE FROM recruiting_notification_rules WHERE user_id=?")
            .run(user.id);
        for (const item of parsed.data.sectors) {
            if (!careerDb()
                .prepare("SELECT 1 FROM recruiting_sectors WHERE id=? AND active=1")
                .get(item.sectorId))
                throw new Error("invalid_sector");
            const assignmentId = crypto.randomUUID();
            careerDb()
                .prepare("INSERT INTO recruiting_user_sectors(id,user_id,sector_id,access_active,can_read,can_edit,notification_active,is_primary,is_delegate,priority,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
                .run(assignmentId, user.id, item.sectorId, item.accessActive ? 1 : 0, item.canRead ? 1 : 0, item.canEdit ? 1 : 0, item.notificationActive ? 1 : 0, item.isPrimary ? 1 : 0, item.isDelegate ? 1 : 0, item.priority, now, req.auth.userId, now, req.auth.userId);
            careerDb()
                .prepare("INSERT INTO recruiting_notification_rules(id,sector_id,user_id,recipient_email,email_enabled,is_primary,is_delegate,priority,active,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
                .run(crypto.randomUUID(), item.sectorId, user.id, user.email, item.notificationActive ? 1 : 0, item.isPrimary ? 1 : 0, item.isDelegate ? 1 : 0, item.priority, item.accessActive ? 1 : 0, now, req.auth.userId, now, req.auth.userId);
        }
        if (parsed.data.globalNotification)
            careerDb()
                .prepare("INSERT INTO recruiting_global_notifications(id,user_id,recipient_email,active,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(recipient_email) DO UPDATE SET user_id=excluded.user_id,active=excluded.active,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
                .run(`global-${user.id}`, user.id, user.email, 1, now, req.auth.userId, now, req.auth.userId);
        else
            careerDb()
                .prepare("UPDATE recruiting_global_notifications SET active=0,updated_at=?,updated_by=? WHERE user_id=?")
                .run(now, req.auth.userId, user.id);
        careerDb().exec("COMMIT");
    }
    catch (error) {
        careerDb().exec("ROLLBACK");
        throw error;
    }
    sectorAudit(req, "user_sector_responsibilities_changed", null, "user", user.id, before, parsed.data);
    await audit(req, "recruiting_responsibilities_update", "user", user.id, [
        "sectors",
        "read",
        "edit",
        "notifications",
        "global",
    ]);
    return { ok: true };
});
app.patch("/api/admin/v1/recruiting/global-notifications/:id", { preHandler: requirePermission("iam.manage") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const active = Boolean(req.body?.active), before = careerDb()
        .prepare("SELECT active FROM recruiting_global_notifications WHERE id=?")
        .get(req.params.id);
    const result = careerDb()
        .prepare("UPDATE recruiting_global_notifications SET active=?,updated_at=?,updated_by=? WHERE id=?")
        .run(active ? 1 : 0, new Date().toISOString(), req.auth.userId, req.params.id);
    if (!result.changes)
        return reply.code(404).send({ error: "not_found" });
    sectorAudit(req, "global_notification_changed", null, "global_notification", req.params.id, before?.active, active);
    await audit(req, "recruiting_global_notification_update", "global_notification", req.params.id, ["active"]);
    return { ok: true };
});
async function fileAuthorization(req, reply, fileId, write = false) {
    await authenticate(req, reply);
    if (reply.sent)
        return null;
    const link = await query(`SELECT r.id resource_id,r.domain,r.resource_type FROM app.resources r WHERE r.id IN (
 SELECT resource_id FROM app.resource_files WHERE file_id=$1 UNION SELECT application_id FROM recruiting.application_files WHERE file_id=$1
 ) LIMIT 1`, [fileId]);
    if (!link.rowCount)
        return reply.code(404).send({ error: "not_found" });
    const row = link.rows[0], permission = permissionForDomain(row.domain, write);
    if (row.resource_type === "calculator_records" &&
        !req.auth.permissions.includes(write ? "calculator.write" : "calculator.documents.read"))
        return reply.code(403).send({ error: "forbidden" });
    if (!req.auth.permissions.includes(permission) &&
        !(row.domain === "recruiting" &&
            req.auth.permissions.includes("files.private.read")) &&
        !(row.domain === "crm" &&
            req.auth.permissions.includes("files.private.read")))
        return reply.code(403).send({ error: "forbidden" });
    return row;
}
app.post("/api/admin/v1/files/upload", { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } }, async (req, reply) => {
    await authenticate(req, reply);
    if (reply.sent)
        return;
    await csrf(req, reply);
    if (reply.sent)
        return;
    const part = await req.file();
    if (!part)
        return reply.code(400).send({ error: "file_required" });
    const fields = part.fields || {}, domain = String(fields.domain?.value || req.query?.domain || ""), resourceId = String(fields.resourceId?.value || req.query?.resourceId || "");
    if (!["cms", "recruiting", "crm"].includes(domain) ||
        !req.auth.permissions.includes(permissionForDomain(domain, true)))
        return reply.code(403).send({ error: "forbidden" });
    const bytes = await part.toBuffer(), detected = signature(bytes), allowed = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
    ];
    if (!detected || !allowed.includes(detected))
        return reply.code(415).send({ error: "unsupported_file_signature" });
    const requestedKind = String(fields.kind?.value || "document");
    if (detected.startsWith("image/")) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(detected))
            return reply.code(415).send({ error: "raster_image_required" });
        if (String(part.mimetype || "").toLowerCase() !== detected)
            return reply.code(415).send({ error: "mime_signature_mismatch" });
        if (bytes.length > 10_000_000)
            return reply.code(413).send({ error: "image_too_large" });
        const extension = path.extname(String(part.filename || "")).toLowerCase();
        const validExtensions = {
            "image/jpeg": [".jpg", ".jpeg"],
            "image/png": [".png"],
            "image/webp": [".webp"],
        };
        if (!validExtensions[detected]?.includes(extension))
            return reply.code(415).send({ error: "extension_signature_mismatch" });
        const dimensions = rasterDimensions(bytes, detected);
        if (!dimensions || dimensions.width < 64 || dimensions.height < 64 ||
            dimensions.width > 12000 || dimensions.height > 12000)
            return reply.code(422).send({ error: "invalid_image_dimensions" });
        fields.width = { value: String(dimensions.width) };
        fields.height = { value: String(dimensions.height) };
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex"), protection = domain === "cms" ? "public" : "private";
    let fr = await query("SELECT * FROM files.objects WHERE sha256=$1 AND size_bytes=$2 AND protection_class=$3 AND deleted_at IS NULL", [digest, bytes.length, protection]);
    if (!fr.rowCount) {
        const storageName = `${digest}-${crypto.randomUUID()}`, target = assertStoragePath(storageName);
        await fsp.writeFile(target, bytes, { mode: 0o600 });
        fr = await query(`INSERT INTO files.objects(storage_name,original_name,mime_type,size_bytes,sha256,protection_class,verified)
  VALUES($1,$2,$3,$4,$5,$6,true) RETURNING *`, [
            storageName,
            safeName(part.filename),
            detected,
            bytes.length,
            digest,
            protection,
        ]);
    }
    let resolvedResource = resourceId;
    if (!resolvedResource && domain === "cms") {
        const rr = await query("INSERT INTO app.resources(domain,resource_type,title,status,data,owner_id) VALUES('cms','media',$1,'draft',$2,$3) RETURNING id", [
            part.filename,
            {
                altText: String(fields.altText?.value || ""),
                description: String(fields.description?.value || ""),
                fileId: fr.rows[0].id,
            },
            req.auth.userId,
        ]);
        resolvedResource = rr.rows[0].id;
    }
    if (resolvedResource) {
        const exists = await query("SELECT id FROM app.resources WHERE id=$1 AND domain=$2", [resolvedResource, domain]);
        if (!exists.rowCount)
            return reply.code(404).send({ error: "resource_not_found" });
        await query("INSERT INTO app.resource_files(resource_id,file_id,kind,metadata) VALUES($1,$2,$3,$4)", [
            resolvedResource,
            fr.rows[0].id,
            requestedKind,
            {
                altText: String(fields.altText?.value || ""),
                title: String(fields.title?.value || ""),
                description: String(fields.description?.value || ""),
                position: String(fields.position?.value || "inline"),
                width: Number(fields.width?.value || 0),
                height: Number(fields.height?.value || 0),
            },
        ]);
    }
    await audit(req, "file_upload", "file", fr.rows[0].id, [
        "mime_type",
        "size_bytes",
        "sha256",
    ]);
    return reply.code(201).send({ ...fr.rows[0], resourceId: resolvedResource });
});
app.get("/api/admin/v1/files", async (req, reply) => {
    await requirePermission("cms.read")(req, reply);
    if (reply.sent)
        return;
    const r = await query(`SELECT f.id,f.original_name,f.mime_type,f.size_bytes,f.sha256,f.created_at,
 COALESCE((SELECT rf.metadata FROM app.resource_files rf WHERE rf.file_id=f.id ORDER BY rf.created_at LIMIT 1),'{}') metadata,
 (SELECT count(*)::int FROM app.resource_files rf WHERE rf.file_id=f.id) usage_count
 FROM files.objects f
 WHERE f.protection_class='public' AND f.verified AND f.deleted_at IS NULL
 ORDER BY f.created_at DESC LIMIT 500`);
    return {
        items: r.rows.map((item) => ({
            ...item,
            width: Number(item.metadata?.width || 0),
            height: Number(item.metadata?.height || 0),
            url: `/cms-media/${item.id}`,
        })),
    };
});
app.get("/cms-media/:id", async (req, reply) => {
    const id = req.params.id;
    if (!uuid.safeParse(id).success)
        return reply.code(404).send({ error: "not_found" });
    const r = await query(`SELECT * FROM files.objects
     WHERE id=$1 AND protection_class='public' AND verified AND deleted_at IS NULL`, [id]);
    if (!r.rowCount)
        return reply.code(404).send({ error: "not_found" });
    const file = r.rows[0];
    return reply
        .header("content-type", file.mime_type)
        .header("content-length", file.size_bytes)
        .header("cache-control", "public,max-age=31536000,immutable")
        .header("content-disposition", `inline; filename="${safeName(file.original_name)}"`)
        .header("x-content-type-options", "nosniff")
        .send(fs.createReadStream(assertStoragePath(file.storage_name)));
});
app.get("/api/admin/v1/files/:id/download", async (req, reply) => {
    const id = req.params.id;
    if (!uuid.safeParse(id).success)
        return reply
            .code(400)
            .send({
            error: "invalid_internal_id",
            message: "Die interne Datei-ID ist keine gültige UUID.",
            correlationId: req.id,
        });
    const auth = await fileAuthorization(req, reply, id);
    if (reply.sent || !auth)
        return;
    const r = await query("SELECT * FROM files.objects WHERE id=$1 AND deleted_at IS NULL", [id]);
    if (!r.rowCount)
        return reply.code(404).send({ error: "not_found" });
    const f = r.rows[0];
    await audit(req, "file_download", "file", id);
    reply
        .header("content-type", f.mime_type)
        .header("content-disposition", disposition(f.original_name))
        .header("cache-control", "private,no-store")
        .header("x-content-type-options", "nosniff");
    return reply.send(fs.createReadStream(assertStoragePath(f.storage_name)));
});
app.post("/api/admin/v1/files/:id/replace", async (req, reply) => {
    const id = req.params.id;
    const auth = await fileAuthorization(req, reply, id, true);
    if (reply.sent || !auth)
        return;
    await csrf(req, reply);
    if (reply.sent)
        return;
    const part = await req.file();
    if (!part)
        return reply.code(400).send({ error: "file_required" });
    const bytes = await part.toBuffer(), detected = signature(bytes);
    if (!detected)
        return reply.code(415).send({ error: "unsupported_file_signature" });
    const digest = crypto.createHash("sha256").update(bytes).digest("hex"), storageName = `${digest}-${crypto.randomUUID()}`;
    await fsp.writeFile(assertStoragePath(storageName), bytes, { mode: 0o600 });
    const old = await query("SELECT * FROM files.objects WHERE id=$1", [id]);
    const nr = await query("INSERT INTO files.objects(storage_name,original_name,mime_type,size_bytes,sha256,protection_class,verified) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING *", [
        storageName,
        safeName(part.filename),
        detected,
        bytes.length,
        digest,
        old.rows[0].protection_class,
    ]);
    await query("UPDATE app.resource_files SET file_id=$1 WHERE file_id=$2", [
        nr.rows[0].id,
        id,
    ]);
    await query("UPDATE recruiting.application_files SET file_id=$1 WHERE file_id=$2", [nr.rows[0].id, id]);
    await query("UPDATE files.objects SET replaced_by=$1,deleted_at=now() WHERE id=$2", [nr.rows[0].id, id]);
    await audit(req, "file_replace", "file", id);
    return nr.rows[0];
});
app.delete("/api/admin/v1/files/:id", async (req, reply) => {
    const id = req.params.id;
    await authenticate(req, reply);
    if (reply.sent)
        return;
    await csrf(req, reply);
    if (reply.sent)
        return;
    if (req.headers["x-confirm-delete"] !== "DELETE")
        return reply.code(400).send({ error: "confirmation_required" });
    const refs = await query("SELECT (SELECT count(*) FROM app.resource_files WHERE file_id=$1)+(SELECT count(*) FROM recruiting.application_files WHERE file_id=$1) refs", [id]);
    if (Number(refs.rows[0].refs) > 0)
        return reply
            .code(409)
            .send({
            error: "file_is_referenced",
            references: Number(refs.rows[0].refs),
        });
    await query("UPDATE files.objects SET deleted_at=now() WHERE id=$1", [id]);
    await audit(req, "file_delete", "file", id);
    return { ok: true };
});
app.get("/api/admin/v1/resources/:type/:id/files.zip", async (req, reply) => {
    const { type, id } = req.params;
    await requirePermission(type === "calculator_records"
        ? "calculator.documents.read"
        : domainPermission(type))(req, reply);
    if (reply.sent)
        return;
    const files = await fileRows(id);
    if (!files.length)
        return reply.code(404).send({ error: "no_files" });
    reply
        .header("content-type", "application/zip")
        .header("content-disposition", disposition(`${type}-${id}.zip`))
        .header("cache-control", "private,no-store");
    const archive = new ArchiverModule.ZipArchive({
        zlib: { level: 9 },
    });
    for (const f of files) {
        const row = await query("SELECT storage_name FROM files.objects WHERE id=$1", [f.id]);
        archive.file(assertStoragePath(row.rows[0].storage_name), {
            name: safeName(f.original_name),
        });
    }
    archive.finalize();
    await audit(req, "files_zip_download", type, id);
    return reply.send(archive);
});
app.get("/api/admin/v1/resources/:type/:id/export.:format", async (req, reply) => {
    const { type, id, format } = req.params;
    await requirePermission(type === "calculator_records"
        ? "calculator.read"
        : domainPermission(type))(req, reply);
    if (reply.sent)
        return;
    const r = await query("SELECT title,status,data,created_at,updated_at FROM app.resources WHERE id=$1 AND resource_type=$2", [id, type]);
    if (!r.rowCount)
        return reply.code(404).send({ error: "not_found" });
    const row = r.rows[0], flat = {
        title: row.title,
        status: row.status,
        ...row.data,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    await audit(req, `export_${format}`, type, id);
    if (format === "csv") {
        const keys = Object.keys(flat), quote = (v) => `"${String(typeof v === "object" ? JSON.stringify(v) : (v ?? "")).replaceAll('"', '""')}"`;
        reply
            .header("content-type", "text/csv; charset=utf-8")
            .header("content-disposition", disposition(`${type}-${id}.csv`));
        return ("\ufeff" +
            keys.map(quote).join(",") +
            "\r\n" +
            keys.map((k) => quote(flat[k])).join(",") +
            "\r\n");
    }
    if (format === "pdf") {
        reply
            .header("content-type", "application/pdf")
            .header("content-disposition", disposition(`${type}-${id}.pdf`));
        const doc = new PDFDocument({
            size: "A4",
            margin: 50,
            info: { Title: row.title },
        });
        doc.fontSize(20).text(row.title).moveDown();
        for (const [k, v] of Object.entries(flat)) {
            doc.fontSize(10).fillColor("#555").text(k);
            doc
                .fontSize(11)
                .fillColor("#111")
                .text(typeof v === "object" ? JSON.stringify(v) : String(v ?? ""))
                .moveDown(0.5);
        }
        doc.end();
        return reply.send(doc);
    }
    return reply.code(404).send({ error: "format_not_found" });
});
app.post("/api/admin/v1/iam/users", { preHandler: requirePermission("iam.manage") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    return createIamUser(req, reply);
});
app.patch("/api/admin/v1/iam/users/:id", { preHandler: requirePermission("iam.manage") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const p = z
        .object({
        email: z.string().email().optional(),
        active: z.boolean().optional(),
        mfaRequired: z.boolean().optional(),
        roles: z.array(z.string()).optional(),
    })
        .safeParse(req.body);
    if (!p.success || p.data.mfaRequired === false)
        return reply
            .code(400)
            .send({
            error: "invalid_request",
            message: "MFA ist für alle Adminzugänge verpflichtend.",
        });
    const r = await query("UPDATE iam.users SET email=COALESCE($1,email),active=COALESCE($2,active),mfa_required=true,updated_at=now() WHERE id=$3 RETURNING id,email,active,mfa_required", [
        p.data.email?.trim().toLowerCase() || null,
        p.data.active ?? null,
        req.params.id,
    ]);
    if (!r.rowCount)
        return reply.code(404).send({ error: "not_found" });
    if (p.data.roles) {
        await query("DELETE FROM iam.user_roles WHERE user_id=$1", [
            req.params.id,
        ]);
        await query("INSERT INTO iam.user_roles(user_id,role_id) SELECT $1,id FROM iam.roles WHERE code=ANY($2)", [req.params.id, p.data.roles]);
    }
    await query("UPDATE iam.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [req.params.id]);
    await audit(req, "user_update", "user", req.params.id, Object.keys(p.data));
    return r.rows[0];
});
app.post("/api/admin/v1/iam/users/:id/reset-password", { preHandler: requirePermission("iam.manage") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const p = z
        .object({ password: z.string().min(12).max(1024) })
        .safeParse(req.body);
    if (!p.success)
        return reply.code(400).send({ error: "invalid_request" });
    await query("UPDATE iam.users SET password_hash=$1,updated_at=now() WHERE id=$2", [await passwordHash(p.data.password), req.params.id]);
    await query("UPDATE iam.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [req.params.id]);
    await query("INSERT INTO iam.password_reset_events(user_id,actor_id) VALUES($1,$2)", [req.params.id, req.auth.userId]);
    await audit(req, "password_reset", "user", req.params.id);
    return { ok: true };
});
app.post("/api/admin/v1/iam/users/:id/mfa/setup", { preHandler: requirePermission("iam.manage") }, async (req, reply) => {
    await csrf(req, reply);
    if (reply.sent)
        return;
    const user = await query("SELECT id,email FROM iam.users WHERE id=$1", [
        req.params.id,
    ]);
    if (!user.rowCount)
        return reply.code(404).send({ error: "not_found" });
    const secret = generateTotpSecret(), encrypted = encryptSecret(secret);
    await query("UPDATE iam.users SET mfa_required=true,mfa_secret_encrypted=$1,updated_at=now() WHERE id=$2", [encrypted, req.params.id]);
    await query("UPDATE iam.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [req.params.id]);
    await audit(req, "mfa_setup", "user", req.params.id, ["mfa_required"]);
    const label = encodeURIComponent(user.rows[0].email), issuer = encodeURIComponent("WB Holding Admin");
    return {
        secret,
        uri: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
    };
});
registerCalculatorRoutes(app, {
    authenticate,
    csrf,
    requirePermission,
    audit,
    consumeDeleteReauth,
    privateRoot,
    disposition,
    fileRows,
    assertStoragePath,
});
registerGlobalTrashRoutes(app, {
    requirePermission,
    csrf,
    audit,
    consumeDeleteReauth,
});
registerAutoSeoRoutes(app, { privateRoot, assertStoragePath });
app.setErrorHandler((error, req, reply) => {
    const status = Number(error.statusCode) || 400;
    req.log.error({ err: { name: error.name, code: error.code }, correlationId: req.id }, "request failed");
    const responseStatus = error.code === "22P02" ? 400 : status >= 400 && status < 500 ? status : 500;
    const code = responseStatus === 429
        ? "rate_limited"
        : responseStatus === 401
            ? "authentication_required"
            : responseStatus === 403
                ? "forbidden"
                : responseStatus === 404
                    ? "not_found"
                    : responseStatus < 500
                        ? "invalid_request"
                        : "internal_server_error";
    const message = responseStatus === 429
        ? "Zu viele Anfragen. Bitte versuchen Sie es später erneut."
        : responseStatus < 500
            ? "Die Anfrage enthält ungültige Angaben."
            : "Die Aktion konnte nicht abgeschlossen werden.";
    return reply
        .code(responseStatus)
        .send({ error: code, message, correlationId: req.id });
});
async function bootstrap() {
    const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || "").toLowerCase(), password = process.env.BOOTSTRAP_ADMIN_PASSWORD || "";
    if (!email || password.length < 16)
        throw new Error("secure bootstrap credentials required");
    const existing = await query("SELECT id FROM iam.users WHERE email=$1", [
        email,
    ]);
    let id;
    if (!existing.rowCount) {
        const r = await query("INSERT INTO iam.users(email,password_hash,mfa_required) VALUES($1,$2,false) RETURNING id", [email, await passwordHash(password)]);
        id = r.rows[0].id;
    }
    else
        id = existing.rows[0].id;
    await query("INSERT INTO iam.user_roles(user_id,role_id) SELECT $1,id FROM iam.roles ON CONFLICT DO NOTHING", [id]);
}
await validateAutoSeoConfiguration();
await bootstrap();
await app.listen({
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 3400),
});
