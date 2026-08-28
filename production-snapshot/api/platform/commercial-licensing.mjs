import crypto from "node:crypto";
import { MODULE_KEYS } from "./saas-catalog.mjs";

export const COMMERCIAL_PRODUCT_TYPES = Object.freeze(["STANDALONE", "BUNDLE", "SUITE", "ADD_ON", "LEGACY"]);
export const LICENSE_ACCESS_STATES = Object.freeze(["ACTIVE", "TRIAL_ACTIVE"]);

const allModules = Object.freeze(Object.values(MODULE_KEYS));
const product = (key, name, type, modules, options = {}) => Object.freeze({
  key, name, type, modules: Object.freeze([...modules]),
  hiddenCapabilities: Object.freeze([...(options.hiddenCapabilities || [])]),
  limits: Object.freeze({ ...(options.limits || {}) }), active: options.active !== false,
});

// This catalog is a bootstrap/default contract. The database tables created by
// migration 100 are authoritative and allow future products without code edits.
export const INITIAL_COMMERCIAL_PRODUCTS = Object.freeze([
  product("wb_tender_scout", "WB Tender Scout", "STANDALONE", [MODULE_KEYS.TENDER_SCOUT, MODULE_KEYS.CONTROL]),
  product("wb_tender_autopilot", "WB Tender Autopilot", "STANDALONE", [MODULE_KEYS.TENDER_AUTOPILOT, MODULE_KEYS.CONTROL], { hiddenCapabilities: ["tender.public_discovery", "docs.object_storage"] }),
  product("wb_tender_professional", "WB Tender Professional", "BUNDLE", [MODULE_KEYS.TENDER_SCOUT, MODULE_KEYS.TENDER_AUTOPILOT, MODULE_KEYS.DOCS, MODULE_KEYS.FLOW, MODULE_KEYS.INSIGHTS, MODULE_KEYS.CONTROL]),
  product("wb_tender_enterprise", "WB Tender Enterprise", "BUNDLE", [MODULE_KEYS.TENDER_SCOUT, MODULE_KEYS.TENDER_AUTOPILOT, MODULE_KEYS.DOCS, MODULE_KEYS.FLOW, MODULE_KEYS.INSIGHTS, MODULE_KEYS.CONNECT, MODULE_KEYS.CONTROL], { limits: { configurable: true, enterprise: true } }),
  product("wb_crm", "WB CRM", "STANDALONE", [MODULE_KEYS.CRM, MODULE_KEYS.CONTROL]),
  product("wb_csm", "WB CSM", "STANDALONE", [MODULE_KEYS.CSM, MODULE_KEYS.CONTROL]),
  product("wb_flow", "WB Flow", "STANDALONE", [MODULE_KEYS.FLOW, MODULE_KEYS.CONTROL]),
  product("wb_people", "WB People", "STANDALONE", [MODULE_KEYS.PEOPLE, MODULE_KEYS.CONTROL]),
  product("wb_docs", "WB Docs", "STANDALONE", [MODULE_KEYS.DOCS, MODULE_KEYS.CONTROL]),
  product("wb_insights", "WB Insights", "STANDALONE", [MODULE_KEYS.INSIGHTS, MODULE_KEYS.CONTROL]),
  product("wb_business_suite", "WB Business Suite", "SUITE", allModules),
]);

const validAt = (row, now) => {
  const start = row.starts_at || row.started_at;
  const end = row.ends_at || row.current_period_ends_at || row.expires_at;
  return (!start || new Date(start) <= now) && (!end || new Date(end) > now);
};

export function licenseAllowsAccess(license, now = new Date()) {
  if (!license || !LICENSE_ACCESS_STATES.includes(String(license.status || "").toUpperCase()) || !validAt(license, now)) return false;
  if (String(license.status).toUpperCase() === "TRIAL_ACTIVE" && (!license.trial_ends_at || new Date(license.trial_ends_at) <= now)) return false;
  return true;
}

// Product modules are unions. Explicit enabled grants add to that union and an
// explicit disabled row wins last, including over another overlapping product.
export function resolveCommercialEntitlements({ licenses = [], productModules = [], explicitModules = [], tenantActive = true, now = new Date() } = {}) {
  if (!tenantActive) return Object.freeze({ modules: Object.freeze([]), sourceProducts: Object.freeze({}), capabilities: Object.freeze([]) });
  const activeLicenseIds = new Set(licenses.filter((row) => licenseAllowsAccess(row, now)).map((row) => String(row.id)));
  const products = new Map(licenses.filter((row) => activeLicenseIds.has(String(row.id))).map((row) => [String(row.id), row.product_key]));
  const modules = new Set(), sources = {};
  for (const row of productModules) {
    if (!activeLicenseIds.has(String(row.license_id)) || row.exposure === "CAPABILITY_ONLY") continue;
    modules.add(row.module_key);
    sources[row.module_key] ||= [];
    const key = products.get(String(row.license_id));
    if (key && !sources[row.module_key].includes(key)) sources[row.module_key].push(key);
  }
  for (const row of explicitModules.filter((item) => validAt(item, now) && item.enabled)) modules.add(row.module_key);
  for (const row of explicitModules.filter((item) => validAt(item, now) && !item.enabled)) modules.delete(row.module_key);
  const capabilities = new Set();
  for (const row of productModules) if (activeLicenseIds.has(String(row.license_id)) && row.capability_key) capabilities.add(row.capability_key);
  return Object.freeze({ modules: Object.freeze([...modules]), sourceProducts: Object.freeze(sources), capabilities: Object.freeze([...capabilities]) });
}

export function explainCommercialEntitlements({ licenses = [], productModules = [], explicitModules = [], tenantActive = true, now = new Date() } = {}) {
  const effective = resolveCommercialEntitlements({ licenses, productModules, explicitModules, tenantActive, now });
  const activeLicenseIds = new Set(licenses.filter((row) => licenseAllowsAccess(row, now)).map((row) => String(row.id)));
  const productByLicense = new Map(licenses.map((row) => [String(row.id), row.product_key || row.commercial_product_key]));
  const explicitByModule = new Map(explicitModules.filter((row) => validAt(row, now)).map((row) => [row.module_key, row]));
  return Object.freeze(allModules.map((moduleKey) => {
    const inheritedProducts = [...new Set(productModules
      .filter((row) => row.module_key === moduleKey && row.exposure !== "CAPABILITY_ONLY" && activeLicenseIds.has(String(row.license_id)))
      .map((row) => productByLicense.get(String(row.license_id))).filter(Boolean))].sort();
    const explicit = explicitByModule.get(moduleKey);
    const entitled = effective.modules.includes(moduleKey);
    const source = explicit ? (explicit.enabled ? "EXPLICIT_GRANT" : "EXPLICIT_REVOKE") : inheritedProducts.length ? "PRODUCT" : "NONE";
    return Object.freeze({
      moduleKey, entitled, source, inheritedProducts: Object.freeze(inheritedProducts),
      overlappingLicense: inheritedProducts.length > 1,
      explicitOverride: explicit ? Object.freeze({ enabled: Boolean(explicit.enabled), action: explicit.action || (explicit.enabled ? "GRANT" : "REVOKE"),
        source: explicit.source || "DIRECT", reason: explicit.reason || explicit.metadata?.reason || null,
        startsAt: explicit.starts_at || null, endsAt: explicit.ends_at || null }) : null,
      explanation: !tenantActive ? "tenant_inactive" : explicit && !explicit.enabled ? "explicit_revoke_overrides_products"
        : explicit?.enabled ? "explicit_grant" : inheritedProducts.length > 1 ? "provided_by_overlapping_products"
        : inheritedProducts.length === 1 ? "provided_by_product" : "not_entitled",
    });
  }));
}

export function assessLicenseRemoval({ licenseId, licenses = [], productModules = [], explicitModules = [], tenantActive = true, now = new Date() } = {}) {
  const target = licenses.find((row) => String(row.id) === String(licenseId));
  if (!target) throw new Error("license_not_found");
  const before = resolveCommercialEntitlements({ licenses, productModules, explicitModules, tenantActive, now });
  const afterLicenses = licenses.map((row) => String(row.id) === String(licenseId) ? { ...row, status: "CANCELED" } : row);
  const after = resolveCommercialEntitlements({ licenses: afterLicenses, productModules, explicitModules, tenantActive, now });
  return Object.freeze({
    licenseId: String(licenseId), productKey: target.product_key || target.commercial_product_key,
    lostModules: Object.freeze(before.modules.filter((key) => !after.modules.includes(key))),
    retainedModules: Object.freeze(before.modules.filter((key) => after.modules.includes(key))),
    remainingModules: after.modules,
    dataRetained: true, dataDeleted: false,
  });
}

export function resolveStripePriceOffer(offers, priceId) {
  const matches = (offers || []).filter((offer) => offer.provider === "stripe" && offer.stripe_price_id === priceId && offer.status === "ACTIVE");
  if (matches.length !== 1) throw new Error(matches.length ? "stripe_price_mapping_ambiguous" : "stripe_price_unknown_or_inactive");
  return matches[0];
}

export function validatePriceProductMatch(offer, requestedProductKey) {
  if (requestedProductKey && requestedProductKey !== offer.commercial_product_key) throw new Error("stripe_price_product_metadata_mismatch");
  return offer;
}

export function selectCommercialOffer(offers, { productKey, priceId } = {}) {
  const candidates = (offers || []).filter((offer) => offer.status === "ACTIVE" && offer.commercial_product_key === productKey
    && (!priceId || offer.stripe_price_id === priceId));
  if (!candidates.length) throw new Error("commercial_offer_not_available");
  if (candidates.length !== 1) throw new Error("commercial_offer_selection_required");
  return candidates[0];
}

export async function loadCommercialEntitlements(db, tenantId, now = new Date()) {
  const result = await db.query("SELECT * FROM saas.effective_tenant_modules($1,$2)", [tenantId, now]);
  return {
    modules: [...new Set(result.rows.filter((row) => row.exposed).map((row) => row.module_key))],
    capabilities: [...new Set(result.rows.flatMap((row) => row.capabilities || []))],
    sources: Object.fromEntries(result.rows.filter((row) => row.exposed).map((row) => [row.module_key, row.source_products || []])),
  };
}

export async function applyCommercialBillingEvent(client, event, rawPayload, now = new Date()) {
  if (!/^[0-9a-f-]{36}$/i.test(String(event.tenantId || ""))) throw new Error("billing_tenant_invalid");
  if (event.type !== "payment.confirmed" && (!event.priceId || !/^price_[A-Za-z0-9_]+$/.test(event.priceId))) throw new Error("stripe_price_missing");
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [event.tenantId]);
    const inserted = await client.query(`INSERT INTO saas.billing_events(provider,provider_event_id,tenant_id,event_type,payload_sha256)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING provider_event_id`, [event.provider, event.id, event.tenantId, event.type, crypto.createHash("sha256").update(rawPayload).digest("hex")]);
    if (!inserted.rowCount) { await client.query("COMMIT"); return { idempotent: true }; }
    const offerResult = event.type === "payment.confirmed"
      ? await client.query(`SELECT o.id offer_id,o.stripe_price_id,o.commercial_product_key,o.status,o.currency,o.billing_interval,o.amount_minor,
          p.active product_active,p.past_due_access,p.offer_class,p.paid_trial_days,p.expected_currency,p.expected_amount_minor,c.status checkout_status
        FROM saas.checkout_sessions c JOIN saas.stripe_price_offers o ON o.id=c.offer_id
        JOIN saas.products p ON p.product_key=o.commercial_product_key
        WHERE c.provider='stripe' AND c.provider_checkout_ref=$1 AND c.tenant_id=$2 AND c.status='CREATED'
          AND c.stripe_price_id=o.stripe_price_id AND c.commercial_product_key=o.commercial_product_key
          AND o.status='ACTIVE' FOR UPDATE OF c,o`, [event.checkoutRef, event.tenantId])
      : await client.query(`SELECT o.id offer_id,o.stripe_price_id,o.commercial_product_key,o.status,o.currency,o.billing_interval,o.amount_minor,
          p.active product_active,p.past_due_access,p.offer_class,p.paid_trial_days,p.expected_currency,p.expected_amount_minor
        FROM saas.stripe_price_offers o JOIN saas.products p ON p.product_key=o.commercial_product_key
        WHERE o.provider='stripe' AND o.stripe_price_id=$1 AND o.status='ACTIVE' FOR SHARE`, [event.priceId]);
    if (offerResult.rowCount !== 1 || !offerResult.rows[0].product_active) {
      await client.query("INSERT INTO saas.license_events(tenant_id,event_type,provider_event_id,metadata) VALUES($1,'PRICE_REJECTED',$2,$3)", [event.tenantId, event.id, { priceId: event.priceId }]);
      await client.query("COMMIT");
      throw Object.assign(new Error("stripe_price_unknown_or_inactive"), { transactionCommitted: true });
    }
    const offer = offerResult.rows[0];
    if (event.priceId && event.priceId !== offer.stripe_price_id) {
      await client.query("INSERT INTO saas.license_events(tenant_id,event_type,provider_event_id,metadata) VALUES($1,'PRICE_REJECTED',$2,$3)", [event.tenantId, event.id, { priceId: event.priceId }]);
      await client.query("COMMIT");
      throw Object.assign(new Error("stripe_price_checkout_binding_mismatch"), { transactionCommitted: true });
    }
    if (event.requestedProductKey && event.requestedProductKey !== offer.commercial_product_key) {
      await client.query("INSERT INTO saas.license_events(tenant_id,event_type,provider_event_id,metadata) VALUES($1,'PRICE_PRODUCT_MISMATCH',$2,$3)", [event.tenantId, event.id, { priceId: event.priceId, requestedProductKey: event.requestedProductKey, mappedProductKey: offer.commercial_product_key }]);
      await client.query("COMMIT");
      throw Object.assign(new Error("stripe_price_product_metadata_mismatch"), { transactionCommitted: true });
    }
    let license;
    if (event.type === "payment.confirmed") {
      if (!event.checkoutRef || !event.customerRef) throw new Error("billing_provider_binding_missing");
      const isPaidTrial = offer.offer_class === "PAID_TRIAL";
      if (isPaidTrial && (offer.paid_trial_days !== 14 || offer.billing_interval !== "ONE_TIME" || offer.currency !== "EUR"
        || Number(offer.amount_minor) !== 19900 || offer.expected_currency !== "EUR" || Number(offer.expected_amount_minor) !== 19900))
        throw new Error("paid_trial_offer_contract_invalid");
      if (isPaidTrial ? (!event.paymentRef || event.subscriptionRef) : !event.subscriptionRef) throw new Error("billing_provider_binding_missing");
      const checkout = await client.query(`UPDATE saas.checkout_sessions SET status='PAYMENT_CONFIRMED',confirmed_at=$4
        WHERE provider='stripe' AND provider_checkout_ref=$1 AND tenant_id=$2 AND stripe_price_id=$3 AND status='CREATED'
        RETURNING commercial_product_key`, [event.checkoutRef, event.tenantId, offer.stripe_price_id, now]);
      if (checkout.rowCount !== 1 || checkout.rows[0].commercial_product_key !== offer.commercial_product_key) throw new Error("checkout_session_not_bound");
      const registration = (await client.query("SELECT email_verified_at,iam_provisioned_at FROM saas.pending_registrations WHERE tenant_id=$1 FOR UPDATE", [event.tenantId])).rows[0];
      if (!registration?.email_verified_at || !registration?.iam_provisioned_at) throw new Error("activation_prerequisites_missing");
      const tenant = (await client.query("SELECT customer_identity_hash,company_identity_hash FROM saas.tenants WHERE id=$1 FOR UPDATE", [event.tenantId])).rows[0];
      if (!tenant?.customer_identity_hash || (isPaidTrial && !tenant.company_identity_hash)) throw new Error("trial_identity_incomplete");
      if (isPaidTrial) {
        const claim = await client.query(`INSERT INTO saas.trial_claims(customer_identity_hash,company_identity_hash,tenant_id,claimed_at)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING tenant_id`, [tenant.customer_identity_hash, tenant.company_identity_hash, event.tenantId, now]);
        if (!claim.rowCount) {
          await client.query("INSERT INTO saas.audit_events(tenant_id,action,metadata) VALUES($1,'PAID_TRIAL_REPLAY_REJECTED',$2)", [event.tenantId, { productKey: offer.commercial_product_key }]);
          await client.query("COMMIT");
          throw Object.assign(new Error("trial_already_claimed"), { transactionCommitted: true });
        }
      }
      const status = isPaidTrial ? "TRIAL_ACTIVE" : "ACTIVE";
      license = (await client.query(`INSERT INTO saas.tenant_product_licenses(tenant_id,commercial_product_key,offer_id,source,status,provider,provider_customer_ref,
          provider_subscription_ref,provider_payment_ref,started_at,trial_started_at,trial_ends_at,current_period_ends_at)
        VALUES($1,$2,$3,'STRIPE',$4,'stripe',$5,$6,$7,$8,CASE WHEN $4='TRIAL_ACTIVE' THEN $8 END,
          CASE WHEN $4='TRIAL_ACTIVE' THEN $8+interval '14 days' END,$9) RETURNING *`,
      [event.tenantId, offer.commercial_product_key, offer.offer_id, status, event.customerRef,
        isPaidTrial ? null : event.subscriptionRef, isPaidTrial ? event.paymentRef : null, now, isPaidTrial ? null : event.periodEnd || null])).rows[0];
      if (isPaidTrial) await client.query("UPDATE saas.trial_claims SET license_id=$3 WHERE customer_identity_hash=$1 AND tenant_id=$2", [tenant.customer_identity_hash, event.tenantId, license.id]);
      await client.query("UPDATE saas.tenants SET status='ACTIVE',updated_at=$2 WHERE id=$1", [event.tenantId, now]);
      await client.query("UPDATE saas.pending_registrations SET status='ACTIVATED',updated_at=$2 WHERE tenant_id=$1", [event.tenantId, now]);
    } else {
      if (offer.offer_class === "PAID_TRIAL") throw new Error("paid_trial_non_checkout_event_rejected");
      license = (await client.query("SELECT * FROM saas.tenant_product_licenses WHERE tenant_id=$1 AND provider=$2 AND provider_subscription_ref=$3 FOR UPDATE", [event.tenantId, event.provider, event.subscriptionRef])).rows[0];
      if (!license || license.offer_id !== offer.offer_id || license.provider_customer_ref !== event.customerRef) throw new Error("billing_provider_binding_mismatch");
      const nextStatus = event.type === "invoice.paid" ? "ACTIVE" : event.type === "subscription.canceled" ? "CANCELED" : "PAST_DUE";
      license = (await client.query("UPDATE saas.tenant_product_licenses SET status=$2,current_period_ends_at=coalesce($3,current_period_ends_at),updated_at=$4 WHERE id=$1 RETURNING *", [license.id, nextStatus, event.periodEnd || null, now])).rows[0];
    }
    await client.query("INSERT INTO saas.license_events(tenant_id,license_id,event_type,provider_event_id,metadata) VALUES($1,$2,$3,$4,$5)", [event.tenantId, license.id, event.type === "payment.failed" ? "PAYMENT_FAILED" : event.type === "subscription.canceled" ? "SUBSCRIPTION_CANCELED" : "PAYMENT_CONFIRMED", event.id, { priceId: event.priceId, productKey: offer.commercial_product_key }]);
    await client.query("COMMIT");
    return { idempotent: false, licenseId: license.id, productKey: offer.commercial_product_key, status: license.status };
  } catch (error) { if (!error.transactionCommitted) await client.query("ROLLBACK").catch(() => {}); throw error; }
}
