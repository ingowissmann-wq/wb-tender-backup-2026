import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import rawBody from "fastify-raw-body";
import pg from "pg";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hashSession, loadIdentity, mayView } from "./auth.mjs";
import { registerAutopilotRoutes } from "./autopilot-routes.mjs";
import { registerConfigurationAdmin } from "./configuration-admin.mjs";
import { startRegionRecalculationWorker } from "./region-recalculation-worker.mjs";
import { registerLocalPdfJsAssets } from "./pdfjs-assets.mjs";
import { requireRegisteredTenderPortalScope } from "./registered-portal-scope.mjs";
import { SAAS_PERMISSION_FEATURES, loadSaasContext, registerSaasRoutes } from "./saas-platform.mjs";
import { registerTenantPortalRoutes } from "./tenant-portal.mjs";
import { SmtpEmailAdapter, StripeBillingAdapter, UnconfiguredBillingAdapter, UnconfiguredEmailAdapter } from "./saas-adapters.mjs";
import { TenantFilesystemStorage, UnconfiguredTenantStorage } from "./tenant-storage.mjs";
import { PostgresLoginStateStore, PostgresSaasSessionStore, SAAS_LOGIN_PATH, SaasOidcClient, registerSaasIamRoutes } from "./saas-iam.mjs";
import { decoratePortalNavigation } from "./portal-navigation.mjs";
import { loadTenderLinkEvidence } from "./tender-link-evidence.mjs";
import { registerLiveSubmissionRoutes } from "./submission-live-routes.mjs";
import {
  favoriteContext,
  favoriteMetadata,
  saveFavorite,
  validFavoriteId,
} from "./favorites.mjs";

const TENDER_RELEASE=process.env.TENDER_RELEASE||"tender-lifecycle-participation-20260820.1";

const enabled =
  process.env.TENDER_ENABLED === "true" ||
  process.env.TENDER_PILOT_ENABLED === "true";
const saasRequested = process.env.WB_TENDER_SAAS_ENABLED === "true";
const stripeProviderConfigured = process.env.SAAS_BILLING_ADAPTER === "stripe"
  && Boolean(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_FILE)
  && Boolean(process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET_FILE)
  && /^https:\/\//.test(String(process.env.WB_TENDER_PUBLIC_BASE_URL || ""));
// The commercial surface remains entirely dark unless the selected billing
// provider has all configuration required for checkout and verified webhooks.
const saasEnabled = saasRequested && stripeProviderConfigured;
const uiBase = process.env.TENDER_UI_BASE || "/admin/ausschreibungen";
const apiBase = process.env.TENDER_API_BASE || "/api/tender";
const asset = (name) => readFileSync(new URL(`./assets/${name}`, import.meta.url));
const inboxRegionsJs = asset("inbox-regions.js");
const inboxRegionsCss = asset("inbox-regions.css");
const autopilotNavigationJs = asset("autopilot-navigation.js");
const autopilotNavigationCss = asset("autopilot-navigation.css");
const uiJs = asset("ui.js");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const assetMeta = new Map([
  ["inbox-regions.js", { body: inboxRegionsJs, sha256: sha256(inboxRegionsJs) }],
  ["inbox-regions.css", { body: inboxRegionsCss, sha256: sha256(inboxRegionsCss) }],
  ["autopilot-navigation.js", { body: autopilotNavigationJs, sha256: sha256(autopilotNavigationJs) }],
  ["autopilot-navigation.css", { body: autopilotNavigationCss, sha256: sha256(autopilotNavigationCss) }],
  ["ui.js", { body: uiJs, sha256: sha256(uiJs) }],
]);
const version = (name) => assetMeta.get(name).sha256.slice(0, 16);
const sendAsset = (reply, name, type, { immutable = false } = {}) => {
  const current = assetMeta.get(name);
  return reply
    .header(
      "Cache-Control",
      immutable
        ? "private, max-age=31536000, immutable"
        : "no-store, max-age=0, must-revalidate",
    )
    .header("X-WB-Asset-SHA256", current.sha256)
    .type(type)
    .send(current.body);
};
const secret = (name) =>
  process.env[name] || readFileSync(process.env[`${name}_FILE`], "utf8").trim();
const optionalSecret = (name) => process.env[name] || (process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], "utf8").trim() : "");
const fileOnlySecret = (name) => {
  if (process.env[name]) throw new Error(`inline_secret_forbidden_${name.toLowerCase()}`);
  const path = process.env[`${name}_FILE`];
  return path ? readFileSync(path, "utf8").replace(/\r?\n$/, "") : "";
};
const readOnlyCandidate = process.env.WB_TENDER_READ_ONLY_CANDIDATE === "true";
const pool = new pg.Pool({
  connectionString: secret("DATABASE_URL"),
  ...(readOnlyCandidate ? { options: "-c default_transaction_read_only=on" } : {}),
});
const sectors = enabled ? new DatabaseSync(process.env.CAREER_DATABASE_PATH, {
  readOnly: true,
}) : null;
const app = Fastify({
  logger: { redact: ["req.headers.cookie", "req.body"] },
  trustProxy: true,
});
await app.register(cookie);
await app.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
});
const rateLimitMax = Number(process.env.TENDER_RATE_LIMIT_MAX || 300);
if (!Number.isInteger(rateLimitMax) || rateLimitMax < 120 || rateLimitMax > 600)
  throw new Error("TENDER_RATE_LIMIT_MAX_OUT_OF_RANGE");
await app.register(rateLimit, { max: rateLimitMax, timeWindow: "1 minute" });
app.addHook("onSend", async (_, reply, payload) => {
  reply.header("x-robots-tag", "noindex, nofollow");
  reply.header("x-wb-tender-release",TENDER_RELEASE);
  if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  if (reply.request.url === "/" && typeof payload === "string" && payload.includes("</head>"))
    return payload.replace("</head>", `<script src="${uiBase}/configuration-nav.js" defer></script></head>`);
  return payload;
});

async function auth(req, reply) {
  if (!enabled) return reply.code(404).send({ error: "pilot_disabled" });
  const identity = await loadIdentity(
    pool,
    req.cookies.wb_session,
    secret("SESSION_PEPPER"),
  );
  if (!identity) {
    const browserRequest = String(req.headers.accept || "").includes("text/html");
    if (browserRequest) {
      const target = req.url.startsWith("/admin/ausschreibungen") ? req.url : `${uiBase}/`;
      return reply.redirect(`/admin/login?returnTo=${encodeURIComponent(target)}`, 303);
    }
    return reply.code(401).send({ error: "authentication_required" });
  }
  if (saasEnabled) {
    identity.saas = await loadSaasContext(pool, identity.userId);
    if (identity.saas) {
      // A SaaS identity receives only company bindings owned by its tenant.
      // Internal IAM scopes and admin permissions never bleed into this context.
      identity.companyIds = identity.saas.companyIds;
      identity.sectorIds = [];
      identity.sectorSlugs = [];
      identity.permissions = identity.permissions.filter((permission) => Object.hasOwn(SAAS_PERMISSION_FEATURES, permission));
      identity.roles = identity.roles.filter((role) => !/admin/i.test(role));
    }
  }
  if (!identity.saas) {
    const careerSectorIds = sectors
      .prepare("SELECT sector_id FROM recruiting_user_sectors WHERE user_id=? AND access_active=1 AND can_read=1")
      .all(identity.userId)
      .map((row) => row.sector_id);
    identity.sectorIds = [...new Set([...identity.sectorIds, ...careerSectorIds])];
  }
  req.identity = identity;
}
const requirePermission = (permission) => async (req, reply) => {
  await auth(req, reply);
  if (reply.sent) return;
  if (req.identity.saas) {
    // Legacy Tender routes query the WB internal schema. They stay unavailable
    // until each route is migrated to the tenant data plane and RLS-tested.
    return reply.code(403).send({ error: "saas_legacy_data_plane_forbidden" });
  }
  if (
    !(Array.isArray(permission)?permission.some(p=>req.identity.permissions.includes(p)):req.identity.permissions.includes(permission)) &&
    !req.identity.permissions.includes("tender.admin")
  )
    return reply.code(403).send({ error: "forbidden" });
};
const csrf = async (req, reply) => {
  const supplied = String(req.headers["x-csrf-token"] || "");
  if (
    !supplied ||
    hashSession(supplied, secret("SESSION_PEPPER")) !== req.identity.csrfHash
  )
    return reply.code(403).send({ error: "csrf_rejected" });
};
const health = async () => ({ status: "ok", enabled, component: "tender-platform", release:TENDER_RELEASE });
app.get("/healthz", health);
// The production reverse proxy intentionally strips /api/tender to /api.
// Keep all three forms healthy so container, canary and productive probes
// exercise the same application instance instead of accepting a proxy 404.
app.get("/api/healthz", health);
app.get("/api/tender/healthz", health);
app.get("/robots.txt", async (_, r) =>
  r.type("text/plain").send("User-agent: *\nDisallow: /\n"),
);
app.get(
  "/api/tenders",
  { preHandler: requirePermission("tender.view_assigned") },
  async (req) => {
    const q = String(req.query.q || "").slice(0, 200),
      source = String(req.query.source || "").slice(0, 40),
      page = Math.max(1, Math.min(10000, Number.parseInt(String(req.query.page || "1"), 10) || 1)),
      pageSize = Math.max(1, Math.min(200, Number.parseInt(String(req.query.pageSize || "100"), 10) || 100)),
      companyIds = req.identity.companyIds || [],
      sectorIds = req.identity.sectorIds || [],
      unrestricted = req.identity.permissions.includes("tender.admin") || req.identity.permissions.includes("tender.view");
    const visibility = `($3::boolean OR tender.assigned_user_id=$5::uuid OR tender.sector_id=ANY($6::uuid[]) OR tender.company_id=ANY($4::uuid[]))`;
    const parameters = [q, source, unrestricted, companyIds, req.identity.userId, sectorIds];
    const total = Number((await pool.query(
      `SELECT count(*) count FROM tender.tenders tender WHERE data_class='PUBLIC_REAL'
       AND source_lifecycle_status='ACTIVE'
       AND participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
       AND EXISTS(SELECT 1 FROM tender.current_participation_eligible_lots eligible WHERE eligible.tender_id=tender.id)
       AND wb_relevance_status='RELEVANT'
       AND classification_confidence='HIGH'
       AND assigned_service_line IS NOT NULL
       AND ($1='' OR search_document @@ plainto_tsquery('german',$1))
       AND ($2='' OR source_code=$2) AND ${visibility}`,
      parameters,
    )).rows[0].count);
    const result = await pool.query(
      `SELECT tender.*,tender.assigned_service_line service_line,
        tender.wb_relevance_status relevance_status,
        tender.classification_reason,
        coalesce(tender.company_id,navigation_company.company_id) portal_navigation_company_id,
        EXISTS(SELECT 1 FROM tender.current_registered_tender_company_portals registered
          WHERE registered.tender_id=tender.id AND ($3::boolean OR registered.company_id=ANY($4::uuid[]))) portal_access_connected
       FROM tender.tenders tender
       LEFT JOIN LATERAL(
         SELECT relevance.company_id
         FROM tender.current_service_relevance relevance
         WHERE relevance.tender_id=tender.id
           AND ($3::boolean OR relevance.company_id=ANY($4::uuid[]))
         ORDER BY relevance.primary_company DESC,relevance.evaluation_version DESC,relevance.company_id
         LIMIT 1
       ) navigation_company ON true
       WHERE data_class='PUBLIC_REAL'
       AND source_lifecycle_status='ACTIVE'
       AND participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE')
       AND EXISTS(SELECT 1 FROM tender.current_participation_eligible_lots eligible WHERE eligible.tender_id=tender.id)
       AND wb_relevance_status='RELEVANT'
       AND classification_confidence='HIGH'
       AND assigned_service_line IS NOT NULL
       AND ($1='' OR search_document @@ plainto_tsquery('german',$1))
       AND ($2='' OR source_code=$2) AND ${visibility}
       ORDER BY (source_lifecycle_status='ACTIVE') DESC,publication_date DESC NULLS LAST,updated_at DESC,id
       LIMIT $7 OFFSET $8`,
      [...parameters, pageSize, (page - 1) * pageSize],
    );
    return {
      items: await decoratePortalNavigation(pool, result.rows, { uiBase }),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    };
  },
);
app.get(
  "/api/tenders/:id",
  { preHandler: requirePermission("tender.view_assigned") },
  async (req, reply) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(req.params.id || "")))
      return reply.code(400).send({ error: "tender_id_invalid", message: "Bitte eine gültige Ausschreibung auswählen." });
    const result = await pool.query(
      "SELECT * FROM tender.tenders tender WHERE id=$1 AND data_class='PUBLIC_REAL' AND source_lifecycle_status='ACTIVE' AND participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE') AND EXISTS(SELECT 1 FROM tender.current_participation_eligible_lots eligible WHERE eligible.tender_id=tender.id) AND wb_relevance_status='RELEVANT' AND classification_confidence='HIGH' AND assigned_service_line IS NOT NULL",
      [req.params.id],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found" });
    if (!mayView(req.identity, result.rows[0]))
      return reply.code(403).send({ error: "forbidden" });
    const tender = result.rows[0];
    const [lots, version, evidence] = await Promise.all([
      pool.query(`SELECT life.lot_key source_lot_id,coalesce(l.id,enriched.id,life.id) lot_id,
                         coalesce(l.title,enriched.title,life.lot_key) title,
                         life.offer_deadline,life.lifecycle_status,life.participation_status,
                         life.deadline_quality,life.participation_block_reason
                    FROM tender.tender_lot_lifecycles life
                    LEFT JOIN tender.lots l ON l.tender_id=life.tender_id AND l.external_id=life.lot_key
                    LEFT JOIN LATERAL(
                      SELECT el.id,el.title FROM tender.enrichment_lots el
                      JOIN tender.enrichment_versions ev ON ev.id=el.enrichment_version_id
                      WHERE ev.tender_id=life.tender_id AND el.lot_key=life.lot_key
                      ORDER BY ev.version DESC LIMIT 1
                    ) enriched ON true
                   WHERE life.tender_id=$1 AND life.is_current
                   ORDER BY life.lot_key`, [tender.id]),
      pool.query("SELECT id,version FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1", [tender.id]),
      loadTenderLinkEvidence(pool, [tender.id]),
    ]);
    return {
      ...tender,
      tender_version_id: version.rows[0]?.id || null,
      tender_version: version.rows[0]?.version || null,
      lots: lots.rows,
      sourceEvidence: evidence.get(String(tender.id)) || null,
    };
  },
);
async function visibleTender(req, reply, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ""))) {
    reply.code(400).send({ error: "tender_id_invalid", message: "Bitte zuerst eine gültige Ausschreibung auswählen." });
    return null;
  }
  const result = await pool.query(
    "SELECT * FROM tender.tenders WHERE id=$1 AND data_class='PUBLIC_REAL'",
    [id],
  );
  if (!result.rowCount) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  if (!mayView(req.identity, result.rows[0])) {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return result.rows[0];
}
async function requireActionCompanyScope(req, reply, tenderId) {
  const companyId = String(req.query?.company || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId)) {
    reply.code(400).send({
      error: "company_scope_required",
      message: "Bitte zuerst eine Gesellschaft auswählen.",
    });
    return null;
  }
  if (
    !req.identity.permissions.includes("tender.admin") &&
    !req.identity.companyIds.includes(companyId)
  ) {
    reply.code(403).send({ error: "company_scope_forbidden" });
    return null;
  }
  return requireRegisteredTenderPortalScope(pool, reply, { tenderId, companyId });
}
app.get(
  "/api/favorites",
  { preHandler: requirePermission("tender.favorite") },
  async (req) => {
    const rows = (
      await pool.query(
        `SELECT f.id favorite_id,f.tender_id,f.company_id favorite_company_id,f.lot_key,
                f.name favorite_name,f.note favorite_note,f.priority,f.created_at favorite_created_at,
                f.updated_at favorite_updated_at,c.legal_name company_name,el.title lot_title,t.*
           FROM tender.favorites f
           JOIN tender.tenders t ON t.id=f.tender_id
           LEFT JOIN tender.enterprise_company_links c ON c.company_id=f.company_id
           LEFT JOIN LATERAL(
             SELECT l.title FROM tender.enrichment_lots l
             JOIN tender.enrichment_versions v ON v.id=l.enrichment_version_id
             WHERE v.tender_id=f.tender_id AND l.lot_key=f.lot_key
             ORDER BY v.version DESC LIMIT 1
           ) el ON true
          WHERE f.user_id=$1 AND t.data_class='PUBLIC_REAL'
          ORDER BY f.priority,f.updated_at DESC,f.id`,
        [req.identity.userId],
      )
    ).rows;
    const admin = req.identity.permissions.includes("tender.admin");
    return {
      items: rows.filter((item) =>
        mayView(req.identity, item) &&
        (admin || !item.favorite_company_id || req.identity.companyIds.includes(String(item.favorite_company_id))),
      ),
      transmitted: false,
    };
  },
);
app.get(
  "/api/tasks",
  { preHandler: requirePermission("tender.task.manage") },
  async (req) => ({
    items: (
      await pool.query(
        "SELECT x.*,t.title tender_title FROM tender.tasks x JOIN tender.tenders t ON t.id=x.tender_id WHERE x.assignee_id=$1 ORDER BY x.due_at NULLS LAST",
        [req.identity.userId],
      )
    ).rows.filter((item) => mayView(req.identity, item)),
  }),
);
app.get(
  "/api/reminders",
  { preHandler: requirePermission("tender.deadline.manage") },
  async (req) => ({
    items: (
      await pool.query(
        "SELECT x.*,t.title tender_title FROM tender.reminders x JOIN tender.tenders t ON t.id=x.tender_id WHERE x.user_id=$1 ORDER BY x.remind_at",
        [req.identity.userId],
      )
    ).rows.filter((item) => mayView(req.identity, item)),
  }),
);
app.post(
  "/api/tenders/:id/favorites",
  { preHandler: [requirePermission("tender.favorite"), csrf] },
  async (req, reply) => {
    const tender = await visibleTender(req, reply, req.params.id);
    if (!tender) return;
    let context, metadata;
    try {
      context = favoriteContext(req.body);
      metadata = favoriteMetadata(req.body);
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: error.message });
    }
    if (context.companyId) {
      const admin = req.identity.permissions.includes("tender.admin");
      if (!admin && !req.identity.companyIds.includes(context.companyId))
        return reply.code(403).send({ error: "company_scope_forbidden" });
      const bound = (await pool.query(
        `SELECT EXISTS(
           SELECT 1 FROM tender.relevant_tender_read_model
            WHERE tender_id=$1 AND company_id=$2
              AND COALESCE(lot_key,'')=COALESCE($3::text,'')
         ) bound`,
        [req.params.id, context.companyId, context.lotKey],
      )).rows[0]?.bound;
      if (!bound)
        return reply.code(409).send({ error: "favorite_context_mismatch", message: "Gesellschaft oder Los gehört nicht zu diesem Ausschreibungskontext." });
    }
    const saved = await saveFavorite(pool, {
      userId: req.identity.userId,
      tenderId: req.params.id,
      ...context,
      ...metadata,
    });
    if (!saved.idempotent)
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'favorite',$2,$3)",
        [req.identity.userId, req.params.id, { company_id: context.companyId, lot_key: context.lotKey, favorite_id: saved.item.id, externalWrite: false, transmitted: false }],
      );
    return reply.code(saved.idempotent ? 200 : 201).send({ ok: true, ...saved, transmitted: false });
  },
);
app.patch(
  "/api/favorites/:id",
  { preHandler: [requirePermission("tender.favorite"), csrf] },
  async (req, reply) => {
    if (!validFavoriteId(req.params.id)) return reply.code(404).send({ error: "favorite_not_found" });
    if (["tender_id", "tenderId", "company_id", "companyId", "lot_key", "lotKey"].some((key) => Object.hasOwn(req.body || {}, key)))
      return reply.code(400).send({ error: "favorite_context_immutable" });
    let metadata;
    try { metadata = favoriteMetadata(req.body, { partial: true }); }
    catch (error) { return reply.code(error.statusCode || 400).send({ error: error.message }); }
    if (!Object.keys(metadata).length) return reply.code(400).send({ error: "favorite_metadata_required" });
    const current = (await pool.query(
      `SELECT f.*,to_jsonb(t) tender
         FROM tender.favorites f JOIN tender.tenders t ON t.id=f.tender_id
        WHERE f.id=$1 AND f.user_id=$2`,
      [req.params.id, req.identity.userId],
    )).rows[0];
    const admin = req.identity.permissions.includes("tender.admin");
    if (!current || !mayView(req.identity, current.tender) || (!admin && current.company_id && !req.identity.companyIds.includes(String(current.company_id))))
      return reply.code(404).send({ error: "favorite_not_found" });
    const item = (await pool.query(
      `UPDATE tender.favorites SET
         name=CASE WHEN $3 THEN $4 ELSE name END,
         note=CASE WHEN $5 THEN $6 ELSE note END,
         priority=CASE WHEN $7 THEN $8 ELSE priority END,
         updated_at=now()
       WHERE id=$1 AND user_id=$2
       RETURNING id,tender_id,company_id,lot_key,name,note,priority,created_at,updated_at`,
      [req.params.id, req.identity.userId, Object.hasOwn(metadata, "name"), metadata.name, Object.hasOwn(metadata, "note"), metadata.note, Object.hasOwn(metadata, "priority"), metadata.priority],
    )).rows[0];
    await pool.query(
      "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'favorite_updated',$2,$3)",
      [req.identity.userId, item.tender_id, { favorite_id: item.id, company_id: item.company_id, lot_key: item.lot_key, externalWrite: false, transmitted: false }],
    );
    return { ok: true, item, transmitted: false };
  },
);
app.delete(
  "/api/favorites/:id",
  { preHandler: [requirePermission("tender.favorite"), csrf] },
  async (req) => {
    if (!validFavoriteId(req.params.id)) return { ok: true, removed: false, idempotent: true, transmitted: false };
    const admin = req.identity.permissions.includes("tender.admin");
    const item = (await pool.query(
      `DELETE FROM tender.favorites
        WHERE id=$1 AND user_id=$2
          AND ($3::boolean OR company_id IS NULL OR company_id=ANY($4::uuid[]))
        RETURNING id,tender_id,company_id,lot_key`,
      [req.params.id, req.identity.userId, admin, req.identity.companyIds],
    )).rows[0];
    if (item)
      await pool.query(
        "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'favorite_removed',$2,$3)",
        [req.identity.userId, item.tender_id, { favorite_id: item.id, company_id: item.company_id, lot_key: item.lot_key, externalWrite: false, transmitted: false }],
      );
    return { ok: true, removed: Boolean(item), idempotent: !item, transmitted: false };
  },
);
app.post(
  "/api/tenders/:id/tasks",
  { preHandler: [requirePermission("tender.task.manage"), csrf] },
  async (req) => {
    const title = String(req.body?.title || "")
      .trim()
      .slice(0, 300);
    if (!title) return { ok: false, error: "title_required" };
    await pool.query(
      "INSERT INTO tender.tasks(tender_id,assignee_id,due_at,title) VALUES($1,$2,$3,$4)",
      [req.params.id, req.identity.userId, req.body?.dueAt || null, title],
    );
    await pool.query(
      "INSERT INTO tender.audit_events(actor_id,action,tender_id) VALUES($1,'task_created',$2)",
      [req.identity.userId, req.params.id],
    );
    return { ok: true };
  },
);
app.post(
  "/api/tenders/:id/notes",
  { preHandler: [requirePermission("tender.note.manage"), csrf] },
  async (req) => {
    const body = String(req.body?.body || "")
      .trim()
      .slice(0, 10000);
    if (!body) return { ok: false, error: "body_required" };
    await pool.query(
      "INSERT INTO tender.notes(tender_id,author_id,body) VALUES($1,$2,$3)",
      [req.params.id, req.identity.userId, body],
    );
    await pool.query(
      "INSERT INTO tender.audit_events(actor_id,action,tender_id) VALUES($1,'note_created',$2)",
      [req.identity.userId, req.params.id],
    );
    return { ok: true };
  },
);
app.post(
  "/api/tenders/:id/reminders",
  { preHandler: [requirePermission("tender.deadline.manage"), csrf] },
  async (req) => {
    await pool.query(
      "INSERT INTO tender.reminders(tender_id,user_id,remind_at) VALUES($1,$2,$3)",
      [req.params.id, req.identity.userId, req.body?.remindAt],
    );
    return { ok: true };
  },
);
app.post(
  "/api/tenders/:id/evaluations",
  { preHandler: [requirePermission("tender.evaluate"), csrf] },
  async (req) => {
    await pool.query(
      "INSERT INTO tender.evaluations(tender_id,actor_id,score,explanation) VALUES($1,$2,$3,$4)",
      [
        req.params.id,
        req.identity.userId,
        req.body?.score ?? null,
        req.body?.explanation || {},
      ],
    );
    return { ok: true };
  },
);
app.patch(
  "/api/tenders/:id/assignment",
  { preHandler: [requirePermission("tender.assign"), csrf] },
  async (req, reply) => {
    if (!(await visibleTender(req, reply, req.params.id))) return;
    const assignee = String(req.body?.assignedUserId || req.identity.userId);
    await pool.query(
      "UPDATE tender.tenders SET assigned_user_id=$1,updated_at=now() WHERE id=$2",
      [assignee, req.params.id],
    );
    await pool.query(
      "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'assignment_changed',$2,$3)",
      [req.identity.userId, req.params.id, { assignedUserId: assignee }],
    );
    return { ok: true, assignedUserId: assignee };
  },
);
app.get(
  "/api/tenders/:id/documents",
  { preHandler: requirePermission("tender.document.view") },
  async (req, reply) => {
    if (!(await visibleTender(req, reply, req.params.id))) return;
    if (!(await requireActionCompanyScope(req, reply, req.params.id))) return;
    return {
      items: (
        await pool.query(
          "SELECT id,display_name,source_url,sha256 FROM tender.documents WHERE tender_id=$1",
          [req.params.id],
        )
      ).rows,
    };
  },
);
app.get(
  "/api/documents/:id",
  { preHandler: requirePermission("tender.document.view") },
  async (req, reply) => {
    const result = await pool.query(
      "SELECT d.*,t.id tender_scope_id,t.data_class,t.assigned_user_id,t.company_id,t.sector_id FROM tender.documents d JOIN tender.tenders t ON t.id=d.tender_id WHERE d.id=$1 AND t.data_class='PUBLIC_REAL'",
      [req.params.id],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "not_found" });
    if (!mayView(req.identity, result.rows[0]))
      return reply.code(403).send({ error: "forbidden" });
    if (!(await requireActionCompanyScope(req, reply, result.rows[0].tender_scope_id))) return;
    return reply.redirect(result.rows[0].source_url);
  },
);
app.get(
  "/api/export",
  { preHandler: requirePermission("tender.export") },
  async (req) => {
    const rows = (
      await pool.query(
        "SELECT external_id,title,buyer,publication_date,offer_deadline,source_url FROM tender.tenders tender WHERE data_class='PUBLIC_REAL' AND source_lifecycle_status='ACTIVE' AND participation_status IN('ELIGIBLE','PARTIALLY_ELIGIBLE') AND EXISTS(SELECT 1 FROM tender.current_participation_eligible_lots eligible WHERE eligible.tender_id=tender.id) AND wb_relevance_status='RELEVANT' AND classification_confidence='HIGH' AND assigned_service_line IS NOT NULL ORDER BY publication_date DESC LIMIT 1000",
      )
    ).rows;
    return { dataClass: "PUBLIC_REAL", items: rows };
  },
);
app.get(
  "/api/sources",
  { preHandler: requirePermission("tender.source.view") },
  async () => ({
    items: (
      await pool.query(
        `SELECT source.code,source.name,
          coalesce(scheduler.last_success_at,source.last_success_at) last_success_at,
          coalesce(scheduler.last_run_status,source.last_status) last_status
        FROM tender.sources source
        LEFT JOIN tender.scheduler_worker_status scheduler ON scheduler.source_code=source.code
        ORDER BY source.code`,
      )
    ).rows,
  }),
);
app.get(
  "/api/imports",
  { preHandler: requirePermission("tender.connector.view") },
  async () => ({
    items: (
      await pool.query(
        "SELECT * FROM tender.import_runs ORDER BY started_at DESC LIMIT 100",
      )
    ).rows,
  }),
);
app.get(
  "/api/deadletters",
  { preHandler: requirePermission("tender.deadletter.view") },
  async () => ({
    items: (
      await pool.query(
        "SELECT * FROM tender.dead_letters WHERE resolved_at IS NULL ORDER BY created_at DESC",
      )
    ).rows,
  }),
);
registerAutopilotRoutes(app, {
  pool,
  requirePermission,
  csrf,
  invitationPepper: optionalSecret("SAAS_INVITATION_PEPPER"),
  visibleTender,
});
const submissionContinuationSecret = optionalSecret("SUBMISSION_CONTINUATION_SECRET") || secret("SESSION_PEPPER");
registerLiveSubmissionRoutes(app, {
  pool, requirePermission, csrf,
  continuationSecret: submissionContinuationSecret,
  envExternalEnabled: process.env.EXTERNAL_SUBMISSION_ENABLED === "true",
  envAllowExternal: process.env.WB_TENDER_ALLOW_EXTERNAL_SUBMISSION === "true",
  isFreshWbMfa: async (req) => {
    const token = req.cookies.wb_session;
    if (!token) return false;
    const row = (await pool.query("SELECT mfa_verified_at FROM iam.sessions WHERE id_hash=$1 AND revoked_at IS NULL AND expires_at>now()", [hashSession(token, secret("SESSION_PEPPER"))])).rows[0];
    return Boolean(row?.mfa_verified_at && new Date(row.mfa_verified_at).getTime() >= Date.now() - 5 * 60_000);
  },
});
registerConfigurationAdmin(app, { pool, requirePermission, csrf });
const regionRecalculationWorker=readOnlyCandidate?null:startRegionRecalculationWorker(pool,{logger:app.log,batchSize:Number(process.env.REGION_RECALCULATION_BATCH_SIZE||100)});
app.addHook("onClose",async()=>{regionRecalculationWorker?.stop()});
const emailAdapter = saasEnabled && process.env.SAAS_EMAIL_ADAPTER === "smtp"
  ? new SmtpEmailAdapter({ host: fileOnlySecret("SAAS_SMTP_HOST"), port: fileOnlySecret("SAAS_SMTP_PORT") || 587, secure: fileOnlySecret("SAAS_SMTP_SECURE") === "true", user: fileOnlySecret("SAAS_SMTP_USER"), password: fileOnlySecret("SAAS_SMTP_PASSWORD"), from: fileOnlySecret("SAAS_SMTP_FROM"), verificationBaseUrl: process.env.SAAS_PUBLIC_BASE_URL || process.env.WB_TENDER_PUBLIC_BASE_URL })
  : new UnconfiguredEmailAdapter();
const stripeSecretKey = saasEnabled && process.env.SAAS_BILLING_ADAPTER === "stripe" ? optionalSecret("STRIPE_SECRET_KEY") : "";
const stripeWebhookSecret = saasEnabled && process.env.SAAS_BILLING_ADAPTER === "stripe" ? optionalSecret("STRIPE_WEBHOOK_SECRET") : "";
const stripePublicBaseUrl = process.env.WB_TENDER_PUBLIC_BASE_URL || "";
const stripeConfigurationComplete = Boolean(stripeSecretKey && stripeWebhookSecret && stripePublicBaseUrl);
const billingAdapter = saasEnabled && process.env.SAAS_BILLING_ADAPTER === "stripe" && stripeConfigurationComplete
  ? new StripeBillingAdapter({ secretKey: stripeSecretKey, webhookSecret: stripeWebhookSecret, publicBaseUrl: stripePublicBaseUrl, priceIds: { CORE: process.env.STRIPE_PRICE_CORE, NORMAL: process.env.STRIPE_PRICE_NORMAL, PROFESSIONAL: process.env.STRIPE_PRICE_PROFESSIONAL, ENTERPRISE: process.env.STRIPE_PRICE_ENTERPRISE } })
  : new UnconfiguredBillingAdapter();
const tenantStorage = saasEnabled && process.env.WB_TENDER_TENANT_STORAGE_ADAPTER === "filesystem"
  ? new TenantFilesystemStorage({ root: process.env.WB_TENDER_TENANT_STORAGE_ROOT })
  : new UnconfiguredTenantStorage();
const saasIamConfigured = saasEnabled && process.env.SAAS_IAM_ADAPTER === "oidc"
  && Boolean(process.env.SAAS_IAM_ISSUER && process.env.SAAS_IAM_AUTHORIZATION_ENDPOINT && process.env.SAAS_IAM_TOKEN_ENDPOINT && process.env.SAAS_IAM_JWKS_URI && process.env.SAAS_IAM_CLIENT_ID)
  && Boolean(process.env.SAAS_IAM_CLIENT_SECRET_FILE && process.env.SAAS_IAM_SESSION_PEPPER_FILE);
const saasIamClient = saasIamConfigured ? new SaasOidcClient({
  issuer: process.env.SAAS_IAM_ISSUER,
  authorizationEndpoint: process.env.SAAS_IAM_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: process.env.SAAS_IAM_TOKEN_ENDPOINT,
  jwksUri: process.env.SAAS_IAM_JWKS_URI,
  clientId: process.env.SAAS_IAM_CLIENT_ID,
  clientSecret: fileOnlySecret("SAAS_IAM_CLIENT_SECRET"),
  sessionPepper: fileOnlySecret("SAAS_IAM_SESSION_PEPPER"),
  stateStore: new PostgresLoginStateStore(pool),
  sessionStore: new PostgresSaasSessionStore(pool),
  resolveIdentity: async ({issuer,subject,email}) => {
    const binding = (await pool.query("SELECT * FROM saas.resolve_iam_subject_binding($1,$2,$3)",[issuer,subject,email])).rows;
    if (binding.length !== 1) return null;
    const saas = await loadSaasContext(pool,binding[0].user_id);
    if (!saas || saas.tenant_id !== String(binding[0].tenant_id)) return null;
    return {userId:binding[0].user_id,tenantId:binding[0].tenant_id,email,emailVerified:true,mfaRequired:true,saas};
  },
}) : null;
const unavailableSaasAuth = async (_,reply) => reply.code(503).send({error:"saas_iam_not_configured"});
const unavailableSaasCsrf = async (_,reply) => reply.code(403).send({error:"csrf_invalid"});
const saasIamRoutes = saasIamClient ? registerSaasIamRoutes(app,{client:saasIamClient,enabled:saasEnabled}) : null;
const saasAuthenticate = saasIamRoutes?.authenticate || unavailableSaasAuth;
const saasCsrf = saasIamRoutes?.csrf || unavailableSaasCsrf;
registerSaasRoutes(app, {
  pool,
  enabled: saasEnabled,
  verificationPepper: saasEnabled ? secret("SAAS_VERIFICATION_PEPPER") : "disabled-not-used-disabled-not-used",
  invitationPepper: saasEnabled ? optionalSecret("SAAS_INVITATION_PEPPER") : "",
  loadInternalIdentity: saasAuthenticate,
  requireInternalAdmin: requirePermission("tender.admin"),
  csrf,
  saasCsrf,
  emailAdapter,
  billingAdapter,
  loginUrl: saasIamConfigured ? SAAS_LOGIN_PATH : "",
  upgradeUrl: /^https:\/\//.test(String(process.env.SAAS_UPGRADE_URL || "")) ? process.env.SAAS_UPGRADE_URL : "",
});
registerTenantPortalRoutes(app, { pool, authenticate: saasAuthenticate, csrf: saasCsrf, storage: tenantStorage, invitationPepper: optionalSecret("SAAS_INVITATION_PEPPER"), emailAdapter });
const uiAuth = { preHandler: requirePermission("tender.view_assigned") };
app.get("/wb-holding-logo.png", uiAuth, async (_, r) =>
  r
    .type("image/png")
    .send(
      readFileSync(new URL("./assets/wb-holding-logo.png", import.meta.url)),
    ),
);
app.get("/roboto-latin-variable.woff2", uiAuth, async (_, r) =>
  r
    .type("font/woff2")
    .send(
      readFileSync(
        new URL("./assets/roboto-latin-variable.woff2", import.meta.url),
      ),
    ),
);
app.get("/contrast.css", uiAuth, async (_, r) =>
  r
    .type("text/css")
    .send(".tabs button.active{background:#087173;border-color:#087173}"),
);
app.get("/configuration.js", uiAuth, async (_, r) =>
  r.type("text/javascript").send(readFileSync(new URL("./assets/configuration.js", import.meta.url))),
);
app.get("/status-blockers.css", uiAuth, async (_, r) =>
  r.type("text/css").send(".status-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,390px),1fr))}.status-card{display:block}.status-stage{width:100%;padding:.65rem 0;border-top:1px solid var(--wb-border)}.status-stage h3{margin:.25rem 0}.status-stage ul,.status-stage ol{padding-left:1.35rem}.status-stage details{width:100%;margin-top:.65rem}.status-stage summary{cursor:pointer;font-weight:600;color:#086f72}.status-stage details li{padding:.55rem 0;border-bottom:1px solid #e5e9ef}.status-stage details button{margin:.4rem 0}.status-badge{display:inline-block;border-radius:999px;background:#edf7f7;color:#075f61;padding:.15rem .45rem;font-size:.75rem}.success-note{color:#087173}"),
);
app.get("/configuration-race-guard.js", uiAuth, async (_, r) =>
  r.type("text/javascript").send(readFileSync(new URL("./assets/configuration-race-guard.js", import.meta.url))),
);
app.get("/configuration-nav.js", uiAuth, async (_, r) =>
  r.type("text/javascript").send(readFileSync(new URL("./assets/configuration-nav.js", import.meta.url))),
);
app.get("/autopilot-navigation.js", uiAuth, async (_, r) =>
  sendAsset(r, "autopilot-navigation.js", "text/javascript"),
);
app.get("/autopilot-navigation.css", uiAuth, async (_, r) =>
  sendAsset(r, "autopilot-navigation.css", "text/css"),
);
// PDF.js is immutable public vendor code. Keeping it independent of the UI
// session prevents a page opened before session rotation from failing its
// later dynamic import; no tender or user data is served by these routes.
registerLocalPdfJsAssets(app);
app.get("/assets/:digest/:name", uiAuth, async (req, reply) => {
  const current = assetMeta.get(req.params.name);
  if (!current || req.params.digest !== version(req.params.name))
    return reply.code(404).send({ error: "asset_not_found" });
  const type = req.params.name.endsWith(".css")
    ? "text/css"
    : "text/javascript";
  return sendAsset(reply, req.params.name, type, { immutable: true });
});
app.get("/ui.css", uiAuth, async (_, r) =>
  r
    .type("text/css")
    .send(
      `@font-face{font-family:Roboto;src:url("${uiBase}/roboto-latin-variable.woff2") format("woff2");font-style:normal;font-weight:100 900;font-display:swap}:root{--wb-navy:#0f1729;--wb-blue:#1d3557;--wb-turquoise:#0f8f91;--wb-orange:#d97706;--wb-surface:#fff;--wb-background:#f6f7f9;--wb-border:#d8dee7;--wb-text-primary:#172033;--wb-text-secondary:#5d6878;--wb-danger:#b42318;--wb-focus:#0f8f91;--wb-radius-sm:6px;--wb-radius-md:10px;--wb-radius-lg:14px;--wb-shadow-sm:0 1px 2px rgb(15 23 41/.06)}*,*::before,*::after{box-sizing:border-box}html{font-family:Roboto,Arial,sans-serif;color-scheme:light}body{font:400 15px/1.5 Roboto,Arial,sans-serif;margin:0;background:var(--wb-background);color:var(--wb-text-primary)}header{min-height:76px;background:var(--wb-navy);color:#fff;padding:.75rem clamp(1rem,3vw,2.5rem);display:flex;align-items:center;justify-content:space-between;gap:1.5rem;border-bottom:3px solid var(--wb-turquoise)}.brand{display:flex;align-items:center;gap:1rem;min-width:0}.brand img{display:block;width:148px;height:44px;object-fit:contain;background:#fff;border-radius:var(--wb-radius-sm);padding:5px}.brand strong{font-size:1rem;font-weight:600;white-space:nowrap}header a{color:#fff;text-underline-offset:4px}header a:hover{text-decoration-thickness:2px}main{width:min(100%,1280px);margin:auto;padding:clamp(1rem,3vw,2.25rem)}h1{font-size:clamp(1.7rem,3vw,2.2rem);line-height:1.15;letter-spacing:-.02em;margin:.1rem 0 .45rem}h2{line-height:1.3}.tabs{display:flex;gap:.5rem;flex-wrap:wrap;margin:1.5rem 0 1rem;padding-bottom:.9rem;border-bottom:1px solid var(--wb-border)}button,.tabs button{min-height:44px;padding:.65rem .95rem;border:1px solid #b8c2d0;border-radius:var(--wb-radius-sm);background:#fff;color:var(--wb-text-primary);font:600 .92rem/1.2 Roboto,Arial,sans-serif;cursor:pointer;transition:border-color .12s ease,background-color .12s ease,color .12s ease}button:hover,.tabs button:hover{border-color:var(--wb-turquoise);background:#f2fbfb}.tabs button.active{background:var(--wb-turquoise);border-color:var(--wb-turquoise);color:#fff}.toolbar{display:flex;align-items:end;gap:1rem;flex-wrap:wrap;padding:1rem;background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:var(--wb-radius-md);box-shadow:var(--wb-shadow-sm)}.toolbar label{display:grid;gap:.35rem;font-weight:600;color:#344054}.toolbar input,.toolbar select{min-height:44px;padding:.65rem .75rem;min-width:220px;border:1px solid #b8c2d0;border-radius:var(--wb-radius-sm);background:#fff;color:var(--wb-text-primary);font:inherit}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:1rem;margin-top:1rem}.card,.panel{background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:var(--wb-radius-md);padding:1.15rem;min-width:0;box-shadow:var(--wb-shadow-sm)}.card{display:flex;flex-direction:column;align-items:flex-start}.card h2{font-size:1.03rem;margin:.1rem 0 .4rem}.card p{overflow-wrap:anywhere}.card button{margin-top:auto}.favorite-actions{display:flex;flex-wrap:wrap;gap:.6rem;width:100%;margin-top:auto}.favorite-actions button{margin-top:0;min-width:44px}.favorite-form{display:grid;gap:.75rem;width:100%;margin-top:1rem}.favorite-form label{display:grid;gap:.35rem;font-weight:600}.favorite-form input,.favorite-form textarea,.favorite-form select{width:100%;min-height:44px;padding:.65rem;border:1px solid #b8c2d0;border-radius:var(--wb-radius-sm);font:inherit}.favorite-form textarea{min-height:7rem;resize:vertical}.muted{color:var(--wb-text-secondary)}.error{color:var(--wb-danger);border-left:4px solid var(--wb-danger);padding:.75rem 1rem;background:#fff5f4;border-radius:0 var(--wb-radius-sm) var(--wb-radius-sm) 0}.hidden{display:none}.panel{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.75rem;border-bottom:1px solid #e5e9ef;overflow-wrap:anywhere}th{background:#f2f4f7;color:#344054;font-weight:600}tr:hover td{background:#f8fbfb}a{color:#086f72}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid color-mix(in srgb,var(--wb-focus) 38%,transparent);outline-offset:2px;border-color:var(--wb-focus)}dl{display:grid;grid-template-columns:minmax(8rem,auto) 1fr;gap:.55rem 1rem}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}@media(max-width:720px){header{align-items:flex-start;flex-direction:column;gap:.6rem}.brand{width:100%}.brand strong{white-space:normal}.brand img{width:128px;height:40px}main{padding:1rem}.grid{display:block}.card{margin-bottom:.8rem}.toolbar>*{width:100%}.toolbar input,.toolbar select{width:100%;min-width:0}.tabs{flex-wrap:nowrap;overflow-x:auto;padding-bottom:.75rem}.tabs button{flex:0 0 auto}table{display:block;overflow:auto}dl{grid-template-columns:1fr;gap:.15rem}dd{margin-bottom:.65rem}.favorite-actions>*{flex:1 1 8rem}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}`,
    ),
);
app.get("/ui.js", uiAuth, async (_, r) =>
  r
    .type("text/javascript")
    .send(
      `const API=${JSON.stringify(apiBase)},tabs=[["overview","Übersicht"],["tenders","Ausschreibungen"],["management-inbox","Management-Inbox"],["scheduler","Schedulerstatus"],["favorites","Favoriten"],["deadlines","Fristen"],["tasks","Aufgaben"],["reminders","Wiedervorlagen"],["sources","Quellen"],["imports","Importprotokolle"],["deadletters","Dead Letters"]],nav=document.querySelector("#tabs"),out=document.querySelector("#content"),q=document.querySelector("#q"),source=document.querySelector("#source");let current="overview";const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));async function get(path){const r=await fetch(API+path,{credentials:"same-origin"});if(!r.ok)throw new Error(r.status===403?"Keine Berechtigung":r.status===401?"Anmeldung erforderlich":"Abruf fehlgeschlagen ("+r.status+")");return r.json()}function cards(rows){return '<div class="grid">'+rows.map(x=>'<article class="card"><h2>'+esc(x.title||x.tender_title||x.name||x.code||"Eintrag")+'</h2><p>'+esc(x.buyer||x.interface||x.company_name||"")+'</p><p class="muted">Quelle: '+esc(x.source_code||x.code||"–")+' · Veröffentlicht: '+esc(x.publication_date||"–")+' · Frist: '+esc(x.offer_deadline||x.due_at||x.remind_at||"–")+'</p><p>Gewerk: '+esc(x.service_line||"Prüfgruppe")+'</p><p>'+esc(x.decision||x.workflow_status||x.relevance_status||"")+'</p>'+(x.tender_id||x.id&&x.source_code?'<button data-detail="'+esc(x.tender_id||x.id)+'">Details</button>':"")+'</article>').join("")+'</div>'}async function load(){out.innerHTML='<p>Wird geladen …</p>';try{let d;if(["overview","tenders","deadlines"].includes(current)){d=await get("/tenders?q="+encodeURIComponent(q.value)+"&source="+encodeURIComponent(source.value));out.innerHTML=cards(current==="deadlines"?d.items.filter(x=>x.offer_deadline):d.items)}else if(current==="management-inbox"){d=await get("/management-inbox?source="+encodeURIComponent(source.value)+"&sort=relevance");out.innerHTML=cards(d.items)}else if(current==="scheduler"){d=await get("/scheduler/status");out.innerHTML='<div class="panel"><table><tbody>'+d.sources.map(x=>'<tr><td>'+esc(x.source_code)+'</td><td>'+esc(x.kill_switch?"GESPERRT":x.enabled?"AKTIV":"INAKTIV")+'</td><td>'+esc(x.next_run_at||"Nicht geplant")+'</td></tr>').join("")+'</tbody></table></div>'}else if(current==="favorites")d=await get("/favorites"),out.innerHTML=cards(d.items);else if(current==="tasks")d=await get("/tasks"),out.innerHTML=cards(d.items);else if(current==="reminders")d=await get("/reminders"),out.innerHTML=cards(d.items);else{d=await get("/"+current);out.innerHTML='<div class="panel"><table><tbody>'+d.items.map(x=>'<tr><td>'+esc(x.code||x.source_code||x.external_id||x.id)+'</td><td>'+esc(x.name||x.status||x.error_code||"")+'</td><td>'+esc(x.last_success_at||x.started_at||x.created_at||"")+'</td></tr>').join("")+'</tbody></table></div>'}}catch(e){out.innerHTML='<p class="error" role="alert">'+esc(e.message)+'</p>'}}async function detail(id){try{const x=await get("/tenders/"+encodeURIComponent(id));out.innerHTML='<article class="panel"><button id="back">← Zurück</button><h1>'+esc(x.title)+'</h1><p>'+esc(x.buyer)+'</p><p>'+esc(x.description||"Keine Beschreibung vorhanden.")+'</p><dl><dt>Quelle</dt><dd><a rel="noopener noreferrer" target="_blank" href="'+esc(x.source_url)+'">'+esc(x.source_code)+'</a></dd><dt>Frist</dt><dd>'+esc(x.offer_deadline||"Nicht angegeben")+'</dd><dt>CPV</dt><dd>'+esc((x.cpv_codes||[]).join(", ")||"Nicht angegeben")+'</dd></dl></article>';document.querySelector("#back").onclick=load}catch(e){out.innerHTML='<p class="error">'+esc(e.message)+'</p>'}}tabs.forEach(([id,label])=>{const b=document.createElement("button");b.textContent=label;b.onclick=()=>{current=id;[...nav.children].forEach(x=>x.classList.remove("active"));b.classList.add("active");load()};nav.append(b)});nav.firstChild.classList.add("active");out.addEventListener("click",e=>{const id=e.target.dataset.detail;if(id)detail(id)});q.oninput=load;source.onchange=load;load();`,
    ),
);
app.get("/inbox-regions.js", uiAuth, async (_, r) =>
  sendAsset(r, "inbox-regions.js", "text/javascript"),
);
app.get("/inbox-regions.css", uiAuth, async (_, r) =>
  sendAsset(r, "inbox-regions.css", "text/css"),
);
app.addHook("onSend",async(req,reply,payload)=>{
  if(req.url==="/"||req.url===uiBase||req.url===`${uiBase}/`){const type=reply.getHeader("content-type");reply.header("Cache-Control","no-store, max-age=0, must-revalidate");reply.header("Pragma","no-cache");if(String(type||"").startsWith("text/html"))return String(payload).replace("</head>",`<link rel="stylesheet" href="${uiBase}/assets/${version("inbox-regions.css")}/inbox-regions.css"><script src="${uiBase}/assets/${version("inbox-regions.js")}/inbox-regions.js" defer></script></head>`)}
  return payload;
});
const tenderPage = async (_, r) =>
  r
    .type("text/html")
    .send(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="wb-tender-release" content="${TENDER_RELEASE}"><title>Ausschreibungen · WB Plattform</title><link rel="stylesheet" href="${uiBase}/ui.css"><link rel="stylesheet" href="${uiBase}/contrast.css"><script src="${uiBase}/assets/${version("ui.js")}/ui.js" defer></script></head><body data-api="${apiBase}"><header><span class="brand"><img src="${uiBase}/wb-holding-logo.png" alt="WB-Holding AG"><strong>WB Plattform · Ausschreibungen</strong></span><a href="/admin/">Adminportal</a></header><main><h1>Ausschreibungen</h1><p class="muted">Internes, geschütztes Enterprise-Modul mit geprüften öffentlichen Vergabedaten.</p><nav id="tabs" class="tabs" aria-label="Ausschreibungsbereiche"></nav><section class="toolbar"><label>Suche <input id="q" autocomplete="off"></label><label>Quelle <select id="source"><option value="">Alle</option><option>TED</option><option>DOE</option></select></label></section><section id="content" aria-live="polite"></section></main></body></html>`,
    );
app.get("/", uiAuth, tenderPage);
// Keep the browser contract correct even when a reverse proxy accidentally
// forwards the public prefix without stripping it. APIs continue to use their
// normal JSON authentication contract.
app.get("/admin/ausschreibungen", async (_, reply) =>
  reply.redirect("/admin/ausschreibungen/", 308),
);
app.get("/admin/ausschreibungen/", uiAuth, tenderPage);
const autopilotPage=async (_, r) =>
  r
    .type("text/html")
    .send(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="wb-tender-release" content="${TENDER_RELEASE}"><title>Tender-Autopilot · WB Plattform</title><link rel="stylesheet" href="${uiBase}/ui.css"><link rel="stylesheet" href="${uiBase}/contrast.css"><link rel="stylesheet" href="${uiBase}/assets/${version("autopilot-navigation.css")}/autopilot-navigation.css"><script src="${uiBase}/assets/${version("autopilot-navigation.js")}/autopilot-navigation.js" defer></script></head><body data-base="${uiBase}" data-api="${apiBase}"><header><span class="brand"><img src="${uiBase}/wb-holding-logo.png" alt="WB-Holding AG"><strong>WB Plattform · Tender-Autopilot</strong></span><a href="${uiBase}/">Ausschreibungen</a></header><main><h1>Tender-Autopilot</h1><p class="muted">Interne Vorbereitung. Externe Portal- und Abgabefunktionen sind durch HTTP 423 gesperrt.</p><nav id="autopilot-nav" class="tabs" aria-label="Autopilot-Bereiche"></nav><section id="autopilot-content" aria-live="polite"><p>Ansicht wird geladen …</p></section></main></body></html>`,
    );
app.get("/favicon.ico", async (_, reply) => reply.code(204).send());
app.get("/autopilot", uiAuth, autopilotPage);
app.get("/autopilot/*", uiAuth, autopilotPage);
app.get("/configuration", { preHandler: requirePermission("tender.config.read") }, async (_, r) =>
  r.type("text/html").send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Konfiguration · Ausschreibungen</title><link rel="stylesheet" href="${uiBase}/ui.css"><script src="${uiBase}/configuration.js" defer></script><script src="${uiBase}/configuration-race-guard.js" defer></script></head><body><header><span class="brand"><img src="${uiBase}/wb-holding-logo.png" alt="WB-Holding AG"><strong>WB Plattform · Ausschreibungen</strong></span><a href="${uiBase}/">Ausschreibungen</a></header><main><h1>Konfiguration</h1><section class="toolbar"><label for="company">Gesellschaft</label><select id="company" aria-describedby="error-company"><option value="">Alle berechtigten Gesellschaften</option></select><p class="error field-error" id="error-company" role="alert" hidden></p><label for="service-line">Leistungsbereich</label><select id="service-line" aria-describedby="error-serviceLine"><option value="">Bitte wählen</option></select><p class="error field-error" id="error-serviceLine" role="alert" hidden></p><label>Priorität <select><option>Alle Prioritäten</option></select></label></section><nav id="subtabs" class="tabs" aria-label="Konfigurationsbereiche"></nav><section id="config-content" aria-live="polite"></section></main></body></html>`),
);
await app.listen({
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 4240),
});
