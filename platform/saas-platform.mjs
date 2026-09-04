import crypto from "node:crypto";
import { customerIdentityHash, hashVerificationToken, verificationToken, UnconfiguredBillingAdapter, UnconfiguredEmailAdapter } from "./saas-adapters.mjs";
import {
  MODULE_CATALOG, MODULE_KEYS, SUITE_PRODUCT_KEY, assessPlanChange, effectiveAccess,
  moduleAccess, navigationCatalog, normalizeModuleKey, normalizePlanCode,
  resolveModuleEntitlements, technicalCapabilities, transitionSubscription, APPROVED_TENDER_PLAN_PRICES,
} from "./saas-catalog.mjs";
import { withTenantContext } from "./tenant-context.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const digest = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex");

export const SAAS_PERMISSION_FEATURES = Object.freeze({
  "tender.view_assigned": MODULE_KEYS.TENDER_SCOUT, "tender.view": MODULE_KEYS.TENDER_SCOUT,
  "tender.favorite": MODULE_KEYS.TENDER_SCOUT, "tender.deadline.manage": MODULE_KEYS.TENDER_SCOUT,
  "tender.task.manage": MODULE_KEYS.TENDER_AUTOPILOT, "tender.document.view": MODULE_KEYS.TENDER_AUTOPILOT,
  "tender.document.analyze": MODULE_KEYS.TENDER_AUTOPILOT, "tender.requirement.manage": MODULE_KEYS.TENDER_AUTOPILOT,
  "tender.portal.manage": MODULE_KEYS.TENDER_AUTOPILOT, "tender.offer.generate": MODULE_KEYS.TENDER_AUTOPILOT,
  "tender.audit.view": MODULE_KEYS.CONTROL,
});

export async function loadSaasContext(pool, userId) {
  const bootstrap = await pool.connect();
  let tenantId;
  try {
    await bootstrap.query("BEGIN");
    await bootstrap.query("SELECT set_config('app.actor_user_id',$1,true)", [String(userId)]);
    const memberships = await bootstrap.query("SELECT tenant_id FROM saas.tenant_memberships WHERE user_id=$1 AND status='ACTIVE' ORDER BY tenant_id LIMIT 2", [userId]);
    if (memberships.rowCount > 1) throw new Error("saas_tenant_selection_required");
    tenantId = memberships.rows[0]?.tenant_id;
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { bootstrap.release(); }
  if (!tenantId) return null;
  const loaded = await withTenantContext(pool, { tenantId, actorUserId: userId }, async (db) => {
    const result = await db.query(`
    SELECT m.tenant_id,m.role,m.status membership_status,t.slug,t.display_name,t.status tenant_status,t.tenant_kind,
      s.id subscription_id,s.plan_code,s.commercial_scope,s.status,s.trial_started_at,s.trial_ends_at,s.trial_claimed_at,
      s.current_period_ends_at,p.seat_limit,p.company_limit,
      coalesce(array_agg(DISTINCT c.tender_company_id) FILTER(WHERE c.status='ACTIVE' AND c.tender_company_id IS NOT NULL),'{}'::uuid[]) company_ids
    FROM saas.tenant_memberships m JOIN saas.tenants t ON t.id=m.tenant_id
    JOIN saas.subscriptions s ON s.tenant_id=t.id JOIN saas.plans p ON p.code=s.plan_code
    LEFT JOIN saas.tenant_companies c ON c.tenant_id=t.id
    WHERE m.user_id=$1 AND m.status='ACTIVE'
    GROUP BY m.tenant_id,m.role,m.status,t.slug,t.display_name,t.status,t.tenant_kind,s.id,s.plan_code,s.commercial_scope,s.status,s.trial_started_at,s.trial_ends_at,s.trial_claimed_at,s.current_period_ends_at,p.seat_limit,p.company_limit
    ORDER BY m.tenant_id LIMIT 2`, [userId]);
    if (!result.rowCount) return null;
    const grants = (await db.query("SELECT module_key,enabled,source,starts_at,ends_at FROM saas.tenant_module_entitlements WHERE tenant_id=$1 AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())", [tenantId])).rows;
    const suiteEnabled = Boolean((await db.query("SELECT 1 FROM saas.tenant_product_entitlements WHERE tenant_id=$1 AND product_key=$2 AND enabled AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())", [tenantId, SUITE_PRODUCT_KEY])).rowCount);
    return { row: result.rows[0], grants, suiteEnabled };
  });
  if (!loaded) return null;
  const access = effectiveAccess(loaded.row);
  const modules = resolveModuleEntitlements({ planCode: loaded.row.plan_code, commercialScope: loaded.row.commercial_scope, suiteEnabled: loaded.suiteEnabled, grants: loaded.grants });
  const context = { ...loaded.row, access, modules, suiteEnabled: loaded.suiteEnabled, companyIds: loaded.row.tenant_kind === "INTERNAL" ? (loaded.row.company_ids || []).map(String) : [] };
  return { ...context, capabilities: technicalCapabilities(context) };
}

export function requireSaasModule(moduleKey) {
  return async (req, reply) => {
    if (!req.identity?.saas?.tenant_id) return reply.code(403).send({ error: "tenant_context_required" });
    const decision = moduleAccess(req.identity.saas, moduleKey);
    if (!decision.allowed) return reply.code(403).send({ error: decision.reason, module: decision.module, plan: req.identity.saas.plan_code || null });
  };
}

// Compatibility export for candidate code; canonical module keys are required.
export const requireSaasEntitlement = requireSaasModule;

export function enforceSaasPermission(identity, permission) {
  if (!identity?.saas) return { allowed: true };
  const module = SAAS_PERMISSION_FEATURES[permission];
  if (!module) return { allowed: false, statusCode: 403, error: "saas_permission_not_available" };
  const decision = moduleAccess(identity.saas, module);
  return decision.allowed ? { allowed: true } : { allowed: false, statusCode: 403, error: decision.reason, module };
}

export function requireSaasJobModule(identity, moduleKey) {
  if (!identity?.saas?.tenant_id) return { allowed: false, statusCode: 403, error: "tenant_context_required" };
  const decision = moduleAccess(identity.saas, moduleKey);
  return decision.allowed ? { allowed: true } : { allowed: false, statusCode: 403, error: decision.reason, module: decision.module };
}

export async function registerPendingTenant(client, input, { verificationPepper, now = new Date(), requestIp = "", userAgent = "" }) {
  const email = String(input.email || "").trim().toLowerCase();
  const company = String(input.company || "").trim().slice(0, 160);
  const plan = normalizePlanCode(input.plan);
  if (!emailPattern.test(email) || email.length > 254) throw Object.assign(new Error("email_invalid"), { statusCode: 400 });
  if (company.length < 2) throw Object.assign(new Error("company_name_invalid"), { statusCode: 400 });
  const identityHash = customerIdentityHash(email, verificationPepper);
  const token = verificationToken(), tokenHash = hashVerificationToken(token, verificationPepper);
  const tenantId = crypto.randomUUID(), slug = `account-${tenantId.slice(0, 12)}`;
  await client.query("BEGIN");
  try {
    const expectedPrice = APPROVED_TENDER_PLAN_PRICES[plan];
    if (!expectedPrice) throw Object.assign(new Error("plan_not_available"), { statusCode: 409 });
    const availablePlan = await client.query("SELECT 1 FROM saas.plans WHERE code=$1 AND active AND price_status='APPROVED' AND recommended_monthly_price_minor=$2", [plan, expectedPrice]);
    if (!availablePlan.rowCount) throw Object.assign(new Error("plan_not_available"), { statusCode: 409 });
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await client.query("INSERT INTO saas.tenants(id,slug,display_name,customer_identity_hash) VALUES($1,$2,$3,$4)", [tenantId, slug, company, identityHash]);
    await client.query(`INSERT INTO saas.pending_registrations(tenant_id,email,requested_plan_code,verification_token_hash,verification_expires_at,request_ip_hash,request_user_agent_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [tenantId, email, plan, tokenHash, new Date(now.getTime() + 24 * 60 * 60 * 1000), digest(requestIp), digest(userAgent)]);
    await client.query("INSERT INTO saas.subscriptions(tenant_id,plan_code,status) VALUES($1,$2,'PENDING_PAYMENT')", [tenantId, plan]);
    await client.query("SELECT tenant_portal.provision_empty_tenant($1,$2)", [tenantId, company]);
    await client.query("INSERT INTO saas.audit_events(tenant_id,action,target_type,target_id,metadata) VALUES($1,'REGISTRATION_CREATED','tenant',$1::uuid::text,$2)", [tenantId, { plan, externalWrite: false, productionAccessGranted: false }]);
    await client.query("COMMIT");
    return { tenantId, email, plan, token };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function verifyPendingRegistration(pool, token, verificationPepper, now = new Date()) {
  const tokenHash = hashVerificationToken(token, verificationPepper);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.verification_token_hash',$1,true)", [tokenHash]);
    const lookup = await client.query("SELECT tenant_id FROM saas.pending_registrations WHERE verification_token_hash=$1 AND verification_expires_at>$2 AND status='EMAIL_VERIFICATION_PENDING'", [tokenHash, now]);
    if (!lookup.rowCount) throw Object.assign(new Error("verification_token_invalid_or_expired"), { statusCode: 400 });
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [String(lookup.rows[0].tenant_id)]);
    const result = await client.query(`UPDATE saas.pending_registrations SET status='PAYMENT_PENDING',email_verified_at=coalesce(email_verified_at,$2),verification_token_hash=NULL,updated_at=$2
      WHERE verification_token_hash=$1 AND verification_expires_at>$2 AND status='EMAIL_VERIFICATION_PENDING'
      RETURNING tenant_id,requested_plan_code`, [tokenHash, now]);
    await client.query("INSERT INTO saas.audit_events(tenant_id,action,metadata) VALUES($1,'EMAIL_VERIFIED',$2)", [result.rows[0].tenant_id, { productionAccessGranted: false }]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function applyBillingEvent(client, event, rawPayload, now = new Date()) {
  if (!uuid.test(String(event.tenantId || ""))) throw new Error("billing_tenant_invalid");
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [String(event.tenantId)]);
    const inserted = await client.query(`INSERT INTO saas.billing_events(provider,provider_event_id,tenant_id,event_type,payload_sha256)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING provider_event_id`, [event.provider, event.id, event.tenantId, event.type, digest(rawPayload)]);
    if (!inserted.rowCount) { await client.query("COMMIT"); return { idempotent: true }; }
    const current = (await client.query("SELECT * FROM saas.subscriptions WHERE tenant_id=$1 FOR UPDATE", [event.tenantId])).rows[0];
    if (!current) throw new Error("subscription_missing");
    const mapped = event.type === "payment.confirmed" ? "PAYMENT_CONFIRMED" : event.type === "invoice.paid" ? "INVOICE_PAID" : event.type === "subscription.active" ? "SUBSCRIPTION_ACTIVATED" : event.type === "payment.failed" ? "PAYMENT_FAILED" : event.type === "subscription.plan_changed" ? "PLAN_CHANGED" : null;
    if (!mapped) throw new Error("billing_event_unsupported");
    if (mapped !== "PAYMENT_CONFIRMED") {
      if (current.provider !== event.provider || !current.provider_customer_ref || !current.provider_subscription_ref
        || current.provider_customer_ref !== event.customerRef || current.provider_subscription_ref !== event.subscriptionRef)
        throw new Error("billing_provider_binding_mismatch");
    }
    let update = mapped === "PLAN_CHANGED" || (mapped === "INVOICE_PAID" && event.billingReason === "subscription_create")
      ? { status: current.status }
      : transitionSubscription(current, { type: mapped === "INVOICE_PAID" ? "SUBSCRIPTION_ACTIVATED" : mapped }, now);
    let planCode = current.plan_code;
    if (mapped === "PLAN_CHANGED") {
      planCode = normalizePlanCode(event.plan);
      const catalog = (await client.query("SELECT code,position,seat_limit,company_limit FROM saas.plans WHERE code=ANY($1::text[])", [[current.plan_code, planCode]])).rows;
      const usage = (await client.query(`SELECT (SELECT count(*)::int FROM saas.tenant_memberships WHERE tenant_id=$1 AND status='ACTIVE') seats,(SELECT count(*)::int FROM saas.tenant_companies WHERE tenant_id=$1 AND status='ACTIVE') companies`, [event.tenantId])).rows[0];
      const decision = assessPlanChange(catalog.find((p) => p.code === current.plan_code), catalog.find((p) => p.code === planCode), usage);
      if (!decision.allowed) throw Object.assign(new Error("plan_change_limit_conflict"), { decision });
    }
    if (mapped === "PAYMENT_CONFIRMED") {
      if (!event.checkoutRef) throw new Error("checkout_session_reference_missing");
      const checkout = await client.query("UPDATE saas.checkout_sessions SET status='PAYMENT_CONFIRMED',confirmed_at=$4 WHERE provider=$1 AND provider_checkout_ref=$2 AND tenant_id=$3 AND status='CREATED' RETURNING plan_code", [event.provider,event.checkoutRef,event.tenantId,now]);
      if (!checkout.rowCount || checkout.rows[0].plan_code !== current.plan_code) throw new Error("checkout_session_not_bound");
      const registration = (await client.query("SELECT email_verified_at,iam_provisioned_at FROM saas.pending_registrations WHERE tenant_id=$1 FOR UPDATE", [event.tenantId])).rows[0];
      if (!registration?.email_verified_at || !registration?.iam_provisioned_at) throw new Error("activation_prerequisites_missing");
      const tenant = (await client.query("SELECT customer_identity_hash FROM saas.tenants WHERE id=$1", [event.tenantId])).rows[0];
      const claim = await client.query("INSERT INTO saas.trial_claims(customer_identity_hash,tenant_id,claimed_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING tenant_id", [tenant.customer_identity_hash, event.tenantId, now]);
      if (!claim.rowCount) throw new Error("trial_already_claimed");
    }
    await client.query(`UPDATE saas.subscriptions SET status=$2,plan_code=$10,trial_started_at=coalesce($3,trial_started_at),trial_ends_at=coalesce($4,trial_ends_at),trial_claimed_at=coalesce($5,trial_claimed_at),provider=$6,provider_customer_ref=coalesce($7,provider_customer_ref),provider_subscription_ref=coalesce($8,provider_subscription_ref),version=version+1,updated_at=$9 WHERE tenant_id=$1`, [event.tenantId, update.status, update.trialStartedAt || null, update.trialEndsAt || null, update.trialClaimedAt || null, event.provider, event.customerRef || null, event.subscriptionRef || null, now, planCode]);
    if (mapped === "PAYMENT_CONFIRMED") {
      await client.query("UPDATE saas.tenants SET status='ACTIVE',updated_at=$2 WHERE id=$1", [event.tenantId, now]);
      await client.query("UPDATE saas.pending_registrations SET status='ACTIVATED',updated_at=$2 WHERE tenant_id=$1", [event.tenantId, now]);
    }
    await client.query("INSERT INTO saas.audit_events(tenant_id,action,metadata) VALUES($1,$2,$3)", [event.tenantId, `BILLING_${mapped}`, { provider: event.provider, providerEventId: event.id }]);
    await client.query("COMMIT"); return { idempotent: false, status: update.status };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

const commercialCss = `:root{font-family:Inter,Roboto,Arial,sans-serif;color:#172033;background:#f5f8f8}*{box-sizing:border-box}body{margin:0}header,main,footer{width:min(1120px,calc(100% - 2rem));margin:auto}header{display:flex;justify-content:space-between;align-items:center;padding:1.2rem 0}a{color:#087173}.hero{text-align:center;padding:4rem 1rem 2rem}.hero h1{font-size:clamp(2rem,6vw,4rem);margin:.2rem}.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1rem}.plan,.panel{background:white;border:1px solid #d8dee7;border-radius:14px;padding:1.3rem}.price{font-size:1.5rem;font-weight:700}.notice{border-left:4px solid #d97706;padding:.8rem;background:#fff8eb}.button,button{display:inline-block;background:#087173;color:white;border:0;border-radius:7px;padding:.8rem 1rem;font-weight:700;text-decoration:none}label{display:grid;gap:.35rem;margin:1rem 0}input,select{padding:.8rem;border:1px solid #aab5c3;border-radius:6px;font:inherit}footer{padding:3rem 0;color:#5d6878}@media(max-width:600px){header{align-items:flex-start;gap:1rem;flex-direction:column}}`;
const registrationJs = `document.querySelector("form")?.addEventListener("submit",async(event)=>{event.preventDefault();const form=event.currentTarget,status=document.querySelector("#registration-status"),button=form.querySelector("button");button.disabled=true;status.textContent="Registrierung wird angelegt …";try{const body=Object.fromEntries(new FormData(form));const response=await fetch(form.action,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||"Registrierung fehlgeschlagen");form.hidden=true;status.textContent=result.delivery==="QUEUED"?"Bitte prüfen Sie Ihr E-Mail-Postfach.":"Das Konto wurde sicher vorgemerkt. Der E-Mail-Versand ist vor dem Start noch zu konfigurieren; es wurden keine Zugriffsrechte erteilt."}catch(error){status.textContent=error.message;button.disabled=false}});`;
const verificationJs = `const status=document.querySelector("#verification-status"),token=location.hash.slice(1);history.replaceState(null,"",location.pathname);if(!token){status.textContent="Verifizierungslink unvollständig."}else fetch("/api/saas/verify-email",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error||"Verifizierung fehlgeschlagen");status.textContent="E-Mail bestätigt. Das Konto wartet auf sichere IAM-Bereitstellung und Zahlung; die Testphase ist noch nicht gestartet."}).catch(error=>status.textContent=error.message);`;
const invitationJs = `const status=document.querySelector("#invitation-status"),params=new URLSearchParams(location.hash.slice(1)),tenantId=params.get("tenantId"),token=params.get("token"),csrf=()=>decodeURIComponent(document.cookie.split("; ").find(x=>x.startsWith("wb_csrf="))?.split("=").slice(1).join("=")||"");history.replaceState(null,"",location.pathname);if(!tenantId||!token){status.textContent="Einladungslink unvollständig."}else fetch("/api/saas/invitations/accept",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrf()},body:JSON.stringify({tenantId,token})}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error||"Einladung konnte nicht angenommen werden");status.textContent="Einladung angenommen."}).catch(error=>status.textContent=error.message);`;

export function registerBillingWebhookRoute(app, { pool, enabled, billingAdapter = new UnconfiguredBillingAdapter(), applyEvent = applyBillingEvent }) {
  const guard = async (_, reply) => { if (!enabled) return reply.code(404).send({ error: "saas_disabled" }); };
  app.post("/api/saas/billing/webhook", {
    preHandler: guard,
    bodyLimit: 1024 * 1024,
    config: { rawBody: true, rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!billingAdapter.configured) return reply.code(503).send({ error: "payment_provider_not_configured" });
    if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0) return reply.code(400).send({ error: "billing_webhook_raw_body_required" });
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return reply.code(415).send({ error: "billing_webhook_content_type_invalid" });
    try {
      const event = billingAdapter.verifyWebhook(req.rawBody, req.headers["stripe-signature"]);
      if (event.ignored) return reply.code(200).send({ received: true, ignored: true });
      const client = await pool.connect();
      try {
        const result = await applyEvent(client, event, req.rawBody);
        return reply.code(200).send({ received: true, idempotent: Boolean(result?.idempotent) });
      } finally { client.release(); }
    } catch (error) {
      const code = String(error?.message || "");
      if (/^billing_webhook_/.test(code) || code === "billing_event_unsupported_or_unpaid") return reply.code(400).send({ error: code });
      if (/^(billing_|activation_|checkout_|subscription_|trial_|plan_change_)/.test(code)) return reply.code(409).send({ error: "billing_event_rejected" });
      req.log.error({ code: "billing_webhook_processing_failed" }, "Stripe webhook processing failed");
      return reply.code(500).send({ error: "billing_webhook_processing_failed" });
    }
  });
}

export function registerSaasRoutes(app, { pool, enabled, verificationPepper, invitationPepper = "", loadInternalIdentity, requireInternalAdmin, csrf, saasCsrf = csrf, emailAdapter = new UnconfiguredEmailAdapter(), billingAdapter = new UnconfiguredBillingAdapter(), loginUrl = "" }) {
  const guard = async (_, reply) => { if (!enabled) return reply.code(404).send({ error: "saas_disabled" }); };
  registerBillingWebhookRoute(app, { pool, enabled, billingAdapter });
  app.get("/saas/assets/commercial.css", { preHandler: guard }, async (_, r) => r.type("text/css").send(commercialCss));
  app.get("/saas/assets/register.js", { preHandler: guard }, async (_, r) => r.type("text/javascript").send(registrationJs));
  app.get("/saas/assets/verify.js", { preHandler: guard }, async (_, r) => r.type("text/javascript").send(verificationJs));
  app.get("/saas/assets/invitation.js", { preHandler: guard }, async (_, r) => r.type("text/javascript").send(invitationJs));
  app.get("/api/saas/catalog", { preHandler: guard }, async () => ({
    product: { key: SUITE_PRODUCT_KEY, slug: "wb-business-suite", name: "WB Business Suite", pricing: "CONFIGURABLE" },
    modules: MODULE_CATALOG,
    plans: Object.fromEntries(["CORE", "NORMAL", "PROFESSIONAL", "ENTERPRISE"].map((plan) => [plan, MODULE_CATALOG.filter((module) => module.availableInPlans.includes(plan)).map((module) => module.key)])),
  }));
  app.get("/api/saas/plans", { preHandler: guard }, async () => ({ items: (await pool.query(`SELECT p.*,coalesce(jsonb_agg(jsonb_build_object('moduleKey',b.module_key) ORDER BY b.module_key) FILTER(WHERE b.module_key IS NOT NULL),'[]') modules FROM saas.plans p LEFT JOIN saas.bundle_modules b ON b.plan_code=p.code WHERE p.active GROUP BY p.code ORDER BY p.position`)).rows }));
  app.get("/saas/pricing", { preHandler: guard }, async (_, r) => {
    const plans = (await pool.query("SELECT * FROM saas.plans WHERE active ORDER BY position")).rows;
    const cards = plans.map((p) => `<article class="plan"><h2>${esc(p.display_name)}</h2><p>${esc(p.description)}</p><p class="price">${p.recommended_monthly_price_minor == null ? "Individuelles Angebot" : `${(p.recommended_monthly_price_minor / 100).toFixed(2)} ${esc(p.currency)} / Monat*`}</p><p>${p.seat_limit || "Individuelle"} Sitze · ${p.company_limit || "Individuelle"} Unternehmen</p><a class="button" href="/saas/register?plan=${encodeURIComponent(p.code)}">Plan wählen</a></article>`).join("");
    return r.type("text/html").send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(process.env.WB_TENDER_COMMERCIAL_PRODUCT_NAME || "Tender Autopilot")} – Pläne</title><link rel="stylesheet" href="/saas/assets/commercial.css"></head><body><header><strong>${esc(process.env.WB_TENDER_COMMERCIAL_BRAND || "Tender Autopilot")}</strong><a href="/saas/login">Anmelden</a></header><main><section class="hero"><h1>Tender finden, prüfen und sicher vorbereiten</h1><p>Vier Pläne für strukturierte Tender-Workflows.</p></section><p class="notice"><strong>Bezahlte 14-Tage-Testphase:</strong> Eine Zahlung ist vor Aktivierung erforderlich. Ohne bestätigte Provider-Zahlung startet keine Testphase.</p><section class="plans">${cards}</section><p>*Empfohlene, noch nicht freigegebene Platzhalterpreise. Verbindliche Preise, Steuern und Vertragsbedingungen werden vor dem öffentlichen Start ergänzt.</p></main><footer>Externe Angebotsabgabe ist nicht Bestandteil der aktivierten Plattform.</footer></body></html>`);
  });
  app.get("/saas/register", { preHandler: guard }, async (req, r) => r.type("text/html").send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Konto anlegen</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/register.js" defer></script></head><body><header><strong>${esc(process.env.WB_TENDER_COMMERCIAL_BRAND || "Tender Autopilot")}</strong><a href="/saas/pricing">Pläne</a></header><main class="panel"><h1>Konto anlegen</h1><p class="notice">Die 14-Tage-Testphase ist kostenpflichtig und beginnt erst nach E-Mail-Verifikation, sicherer Kontobereitstellung und bestätigter Zahlung.</p><form method="post" action="/api/saas/register"><label>Geschäftliche E-Mail<input type="email" name="email" required autocomplete="email"></label><label>Unternehmen<input name="company" required maxlength="160" autocomplete="organization"></label><label>Plan<select name="plan">${["CORE","NORMAL","PROFESSIONAL","ENTERPRISE"].map((p) => `<option${req.query?.plan === p ? " selected" : ""}>${p}</option>`).join("")}</select></label><button type="submit">Verifizierung anfordern</button></form><p id="registration-status" role="status" aria-live="polite"></p></main></body></html>`));
  app.post("/api/saas/register", { preHandler: guard, config: { rateLimit: { max: 8, timeWindow: "1 hour" } } }, async (req, reply) => {
    const client = await pool.connect();
    try {
      const created = await registerPendingTenant(client, req.body || {}, { verificationPepper, requestIp: req.ip, userAgent: req.headers["user-agent"] });
      let delivery = "PENDING_PROVIDER_CONFIGURATION";
      if (emailAdapter.configured) {
        try { await emailAdapter.sendVerification({ email: created.email, token: created.token, tenantId: created.tenantId }); delivery = "QUEUED"; }
        catch { delivery = "PROVIDER_DELIVERY_FAILED"; }
      }
      return reply.code(202).send({ status: "EMAIL_VERIFICATION_PENDING", delivery, productionAccessGranted: false, paymentStatus: "PENDING_PAYMENT" });
    } catch (error) {
      if (error.message === "registration_already_exists" || error.code === "23505")
        return reply.code(202).send({ status: "REGISTRATION_RECEIVED", productionAccessGranted: false, paymentStatus: "PENDING_PAYMENT" });
      return reply.code(error.statusCode || 400).send({ error: error.message });
    }
    finally { client.release(); }
  });
  app.get("/saas/verify", { preHandler: guard }, async (_, r) => r.type("text/html").send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>E-Mail bestätigen</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/verify.js" defer></script></head><body><main class="panel"><h1>E-Mail bestätigen</h1><p id="verification-status" role="status" aria-live="polite">Verifizierung läuft …</p></main></body></html>`));
  app.get("/saas/invitation", { preHandler: guard }, async (_, r) => r.type("text/html").send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Einladung annehmen</title><link rel="stylesheet" href="/saas/assets/commercial.css"><script src="/saas/assets/invitation.js" defer></script></head><body><main class="panel"><h1>Einladung annehmen</h1><p id="invitation-status" role="status" aria-live="polite">Einladung wird geprüft …</p></main></body></html>`));
  app.post("/api/saas/verify-email", { preHandler: guard }, async (req, reply) => {
    try { await verifyPendingRegistration(pool, String(req.body?.token || ""), verificationPepper); return { status: "PAYMENT_PENDING", productionAccessGranted: false }; }
    catch (error) { return reply.code(error.statusCode || 400).send({ error: error.message }); }
  });
  app.post("/api/saas/checkout", { preHandler: [guard, loadInternalIdentity, saasCsrf] }, async (req, reply) => {
    if (!req.identity?.saas) return reply.code(403).send({ error: "saas_membership_required" });
    if (!billingAdapter.configured) return reply.code(503).send({ error: "payment_provider_not_configured", trialActivated: false });
    if (req.identity.saas.status !== "PENDING_PAYMENT") return reply.code(409).send({ error: "checkout_not_available_for_state" });
    const checkout = await billingAdapter.createCheckout({ tenantId: req.identity.saas.tenant_id, plan: req.identity.saas.plan_code, trialDays: 14, paymentRequired: true });
    await withTenantContext(pool,{tenantId:req.identity.saas.tenant_id,actorUserId:req.identity.userId},(db)=>db.query("INSERT INTO saas.checkout_sessions(provider,provider_checkout_ref,tenant_id,plan_code) VALUES($1,$2,$3,$4) ON CONFLICT(provider,provider_checkout_ref) DO NOTHING",[billingAdapter.provider,checkout.id,req.identity.saas.tenant_id,req.identity.saas.plan_code]));
    return reply.code(201).send({ checkoutUrl: checkout.url, trialActivated: false });
  });
  app.get("/saas/login", { preHandler: guard }, async (_, reply) => loginUrl ? reply.redirect(loginUrl) : reply.code(503).type("text/html").send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/saas/assets/commercial.css"><title>Anmeldung</title></head><body><main class="panel"><h1>Anmeldung noch nicht freigeschaltet</h1><p>Die sichere IAM-Anbindung muss vor dem kommerziellen Start konfiguriert werden. Es wurde kein Ersatzpasswortsystem angelegt.</p></main></body></html>`));
  app.get("/api/saas/me", { preHandler: [guard, loadInternalIdentity] }, async (req, reply) => req.identity?.saas ? { tenant: req.identity.saas } : reply.code(403).send({ error: "saas_membership_required" }));
  app.post("/api/saas/invitations/accept", { preHandler: [guard, loadInternalIdentity, saasCsrf] }, async (req, reply) => {
    const tenantId=String(req.body?.tenantId||""),token=String(req.body?.token||"");
    if(!uuid.test(tenantId)||!invitationPepper||invitationPepper.length<32||token.length<32)return reply.code(400).send({error:"invitation_invalid"});
    const tokenHash=crypto.createHmac('sha256',invitationPepper).update(token).digest('hex');
    try{return await withTenantContext(pool,{tenantId,actorUserId:req.identity.userId},async(db)=>{
      const invitation=(await db.query("SELECT * FROM saas.tenant_invitations WHERE tenant_id=$1 AND token_hash=$2 AND status='PENDING' AND expires_at>now() FOR UPDATE",[tenantId,tokenHash])).rows[0];
      const user=(await db.query("SELECT id,email,active FROM iam.users WHERE id=$1",[req.identity.userId])).rows[0];
      const memberships=await db.query("SELECT tenant_id FROM saas.tenant_memberships WHERE user_id=$1 AND status='ACTIVE'",[req.identity.userId]);
      if(!invitation||!user?.active||user.email.toLowerCase()!==invitation.email.toLowerCase())return reply.code(409).send({error:'invitation_not_eligible'});
      if(memberships.rows.some((row)=>String(row.tenant_id)!==tenantId))return reply.code(409).send({error:'multi_tenant_identity_not_enabled'});
      await db.query("INSERT INTO saas.tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,$3,'ACTIVE') ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=excluded.role,status='ACTIVE'",[tenantId,user.id,invitation.role]);
      await db.query("UPDATE saas.tenant_invitations SET status='ACCEPTED',accepted_user_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,invitation.id,user.id]);
      await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'MEMBERSHIP_ACCEPTED','iam_user',$2)",[tenantId,user.id]);return{ok:true,tenantId,role:invitation.role};
    });}catch(error){if(error.message.includes('saas_plan_limit_exceeded'))return reply.code(409).send({error:'seat_limit_exceeded'});throw error;}
  });
  app.get("/api/saas/navigation", { preHandler: [guard, loadInternalIdentity] }, async (req, reply) => {
    if (!req.identity?.saas?.tenant_id) return reply.code(403).send({ error: "tenant_context_required" });
    if (!req.identity.saas.access.allowed) return reply.code(403).send({ error: req.identity.saas.access.reason });
    return { product: "WB Business Suite", tenantId: req.identity.saas.tenant_id, modules: navigationCatalog(req.identity.saas) };
  });
  app.get("/api/saas/admin/tenants", { preHandler: [guard, requireInternalAdmin] }, async (_, reply) =>
    reply.code(503).send({ error: "privileged_admin_data_plane_not_configured" }));
  app.get("/saas/admin", { preHandler: [guard, requireInternalAdmin] }, async (_, r) => r.type("text/html").send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SaaS-Mandanten</title><link rel="stylesheet" href="/saas/assets/commercial.css"></head><body><main><h1>SaaS-Mandanten</h1><p>Interne Verwaltung. Statusänderungen sind CSRF-geschützt über die Admin-API verfügbar.</p><p><a href="/api/saas/admin/tenants">Mandantenstatus als JSON anzeigen</a></p></main></body></html>`));
  app.post("/api/saas/admin/tenants/:id/status", { preHandler: [guard, requireInternalAdmin, csrf] }, async (req, reply) => {
    if (!uuid.test(req.params.id)) return reply.code(400).send({ error: "tenant_id_invalid" });
    const action = String(req.body?.action || "").toUpperCase(); if (!['SUSPEND','REACTIVATE'].includes(action)) return reply.code(400).send({ error: "admin_action_invalid" });
    return withTenantContext(pool, { tenantId: req.params.id, actorUserId: req.identity.userId }, async (db) => {
      const current = (await db.query("SELECT * FROM saas.subscriptions WHERE tenant_id=$1 FOR UPDATE", [req.params.id])).rows[0];
      if (!current) return reply.code(404).send({ error: "tenant_not_found" });
      let next; try { next = transitionSubscription(current, { type: action }); } catch (error) { return reply.code(409).send({ error: error.message }); }
      await db.query("UPDATE saas.subscriptions SET status=$2,suspended_at=CASE WHEN $2='SUSPENDED' THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE tenant_id=$1", [req.params.id, next.status]);
      await db.query("UPDATE saas.tenants SET status=CASE WHEN $2='SUSPENDED' THEN 'SUSPENDED' ELSE 'ACTIVE' END,updated_at=now() WHERE id=$1", [req.params.id, next.status]);
      await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,metadata) VALUES($1,$2,$3,$4)", [req.params.id, req.identity.userId, `ADMIN_${action}`, { previousStatus: current.status, newStatus: next.status }]);
      return { ok: true, status: next.status };
    });
  });
  app.post("/api/saas/admin/tenants/:id/entitlements", { preHandler: [guard, requireInternalAdmin, csrf] }, async (req, reply) => {
    if (!uuid.test(req.params.id)) return reply.code(400).send({ error: "tenant_id_invalid" });
    const scope = String(req.body?.scope || "").toUpperCase();
    let modules;
    try { modules = [...new Set((req.body?.modules || []).map(normalizeModuleKey))]; }
    catch (error) { return reply.code(error.statusCode || 400).send({ error: error.message }); }
    if (!["BUNDLE", "MODULES", "SUITE"].includes(scope)) return reply.code(400).send({ error: "commercial_scope_invalid" });
    if (scope === "MODULES" && modules.length === 0) return reply.code(422).send({ error: "individual_module_selection_required" });
    await withTenantContext(pool, { tenantId: req.params.id, actorUserId: req.identity.userId }, (db) =>
      db.query("SELECT saas.configure_commercial_entitlements($1,$2,$3::text[])", [req.params.id, scope, modules]));
    return { tenantId: req.params.id, scope, modules, externalSubmissionEnabled: false };
  });
  app.post("/api/saas/admin/tenants/:id/iam-provisioned", { preHandler: [guard, requireInternalAdmin, csrf] }, async (req, reply) => {
    if (!uuid.test(req.params.id) || !uuid.test(String(req.body?.userId || ""))) return reply.code(400).send({ error: "identity_binding_invalid" });
    return withTenantContext(pool, { tenantId: req.params.id, actorUserId: req.identity.userId }, async (db) => {
      const candidate = (await db.query(`SELECT u.id,u.email,u.active,EXISTS(SELECT 1 FROM iam.user_roles ur JOIN iam.role_permissions rp ON rp.role_id=ur.role_id JOIN iam.permissions p ON p.id=rp.permission_id WHERE ur.user_id=u.id AND p.code='tender.admin') internal_admin FROM iam.users u WHERE u.id=$1`, [req.body.userId])).rows[0];
      const registration = (await db.query("SELECT email,status FROM saas.pending_registrations WHERE tenant_id=$1", [req.params.id])).rows[0];
      if (!candidate?.active || candidate.internal_admin || !registration || registration.status !== "PAYMENT_PENDING" || candidate.email.toLowerCase() !== registration.email.toLowerCase())
        return reply.code(409).send({ error: "saas_iam_identity_not_eligible" });
      await db.query("INSERT INTO saas.tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'OWNER','ACTIVE') ON CONFLICT(tenant_id,user_id) DO UPDATE SET status='ACTIVE'", [req.params.id, candidate.id]);
      await db.query("UPDATE saas.pending_registrations SET iam_provisioned_at=now(),status='PAYMENT_PENDING',updated_at=now() WHERE tenant_id=$1", [req.params.id]);
      await db.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'IAM_PROVISIONING_CONFIRMED','iam_user',$3,$4)", [req.params.id, req.identity.userId, candidate.id, { internalAdmin: false, productionAccessGranted: false }]);
      return { ok: true, paymentStatus: "PENDING_PAYMENT", productionAccessGranted: false };
    });
  });
}
