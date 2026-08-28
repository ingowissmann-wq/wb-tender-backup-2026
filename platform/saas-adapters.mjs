import crypto from "node:crypto";
import nodemailer from "nodemailer";

export class UnconfiguredEmailAdapter {
  get configured() { return false; }
  async sendVerification() { throw new Error("email_provider_not_configured"); }
  async sendInvitation() { throw new Error("email_provider_not_configured"); }
}

export class UnconfiguredBillingAdapter {
  get configured() { return false; }
  async createCheckout() { throw new Error("payment_provider_not_configured"); }
  verifyWebhook() { throw new Error("payment_provider_not_configured"); }
}

const safeEqual = (left, right) => {
  if (!/^[a-f0-9]{64}$/i.test(String(left || "")) || !/^[a-f0-9]{64}$/i.test(String(right || ""))) return false;
  const a = Buffer.from(String(left), "hex"), b = Buffer.from(String(right), "hex");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Provider-neutral signed JSON contract. A concrete provider adapter must map
// its verified webhook to this shape; no route may infer payment from checkout.
export class SignedBillingAdapter {
  constructor({ webhookSecret, checkoutFactory = null, provider = "configured" }) {
    if (!webhookSecret || webhookSecret.length < 32) throw new Error("billing_webhook_secret_invalid");
    this.webhookSecret = webhookSecret;
    this.checkoutFactory = checkoutFactory;
    this.provider = provider;
  }
  get configured() { return true; }
  async createCheckout(input) {
    if (!this.checkoutFactory) throw new Error("payment_checkout_not_configured");
    return this.checkoutFactory(input);
  }
  verifyWebhook(rawBody, signature) {
    const expected = crypto.createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    if (!safeEqual(expected, signature)) throw new Error("billing_webhook_signature_invalid");
    const event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    if (!event.id || !event.type || !event.tenantId) throw new Error("billing_webhook_payload_invalid");
    return { ...event, provider: this.provider };
  }
}

function stripeSignatureParts(header) {
  const parts = String(header || "").split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  return { timestamp: Number(timestampPart?.slice(2)), signatures: parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3)) };
}

const stripeInvoiceSubscription = (invoice) =>
  invoice?.parent?.type === "subscription_details"
    ? invoice.parent.subscription_details?.subscription
    : invoice?.subscription;

const stripeTenantId = (stripeType, object) => {
  if (stripeType === "checkout.session.completed") return object?.metadata?.tenant_id || object?.client_reference_id;
  return object?.metadata?.tenant_id
    || object?.parent?.subscription_details?.metadata?.tenant_id
    || object?.subscription_details?.metadata?.tenant_id;
};

export class StripeBillingAdapter {
  constructor({ secretKey, webhookSecret, publicBaseUrl, priceIds = {}, apiBase = "https://api.stripe.com", now = () => Date.now() }) {
    if (!String(secretKey || "").startsWith("sk_")) throw new Error("stripe_secret_key_invalid");
    if (!String(webhookSecret || "").startsWith("whsec_") || webhookSecret.length < 24) throw new Error("stripe_webhook_secret_invalid");
    if (!/^https:\/\//.test(String(publicBaseUrl || ""))) throw new Error("stripe_public_base_url_invalid");
    this.secretKey = secretKey; this.webhookSecret = webhookSecret; this.publicBaseUrl = publicBaseUrl.replace(/\/$/, ""); this.priceIds = priceIds; this.apiBase = apiBase; this.now = now;
  }
  get provider() { return "stripe"; }
  get configured() { return true; }
  async createCheckout({ tenantId, plan, successUrl = `${this.publicBaseUrl}/saas/payment-complete`, cancelUrl = `${this.publicBaseUrl}/saas/pricing` }) {
    const price = this.priceIds[String(plan || "").toUpperCase()];
    if (!price || !/^price_[A-Za-z0-9]+$/.test(price)) throw new Error("stripe_plan_price_not_configured");
    const body = new URLSearchParams({ mode: "subscription", "line_items[0][price]": price, "line_items[0][quantity]": "1", success_url: successUrl, cancel_url: cancelUrl, client_reference_id: tenantId, "metadata[tenant_id]": tenantId, "subscription_data[metadata][tenant_id]": tenantId });
    const response = await fetch(`${this.apiBase}/v1/checkout/sessions`, { method: "POST", headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": `wb-trial-${tenantId}` }, body });
    const payload = await response.json();
    if (!response.ok || !payload.id || !payload.url) throw new Error(`stripe_checkout_failed_${response.status}`);
    return { id: payload.id, url: payload.url };
  }
  verifyWebhook(rawBody, signatureHeader) {
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) throw new Error("billing_webhook_raw_body_required");
    const raw = rawBody;
    const { timestamp, signatures } = stripeSignatureParts(signatureHeader);
    if (!Number.isInteger(timestamp) || Math.abs(this.now() / 1000 - timestamp) > 300) throw new Error("billing_webhook_timestamp_invalid");
    const expected = crypto.createHmac("sha256", this.webhookSecret).update(`${timestamp}.`).update(raw).digest("hex");
    if (!signatures.some((signature) => safeEqual(expected, signature))) throw new Error("billing_webhook_signature_invalid");
    let stripe;
    try { stripe = JSON.parse(raw.toString("utf8")); }
    catch { throw new Error("billing_webhook_payload_invalid"); }
    if (!/^evt_[A-Za-z0-9_]+$/.test(String(stripe?.id || "")) || typeof stripe?.type !== "string") throw new Error("billing_webhook_payload_invalid");
    const object = stripe?.data?.object;
    if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error("billing_webhook_payload_invalid");
    const supported = new Set(["checkout.session.completed", "invoice.paid", "invoice.payment_failed"]);
    if (!supported.has(stripe.type)) return { id: stripe.id, provider: "stripe", stripeType: stripe.type, ignored: true };
    const tenantId = stripeTenantId(stripe.type, object);
    let type;
    if (stripe.type === "checkout.session.completed" && object.payment_status === "paid" && object.mode === "subscription" && object.id) type = "payment.confirmed";
    else if (stripe.type === "invoice.paid" && object.status === "paid" && object.paid === true) type = "invoice.paid";
    else if (stripe.type === "invoice.payment_failed" && object.paid !== true) type = "payment.failed";
    else throw new Error("billing_event_unsupported_or_unpaid");
    if (!stripe.id || !tenantId) throw new Error("billing_webhook_payload_invalid");
    return {
      id: stripe.id, type, tenantId, provider: "stripe", stripeType: stripe.type,
      checkoutRef: stripe.type === "checkout.session.completed" ? object.id : null,
      customerRef: object.customer || null,
      subscriptionRef: stripe.type === "checkout.session.completed" ? object.subscription : stripeInvoiceSubscription(object),
      billingReason: stripe.type === "invoice.paid" ? object.billing_reason || null : null,
    };
  }
}

export class SmtpEmailAdapter {
  constructor({ host, port = 587, secure = false, user, password, from, verificationBaseUrl }) {
    if (!host || !from || !verificationBaseUrl) throw new Error("smtp_configuration_incomplete");
    if (/[\r\n]/.test(`${host}${from}${user||""}${password||""}`)) throw new Error("smtp_configuration_invalid");
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error("smtp_port_invalid");
    if (Boolean(user) !== Boolean(password)) throw new Error("smtp_authentication_incomplete");
    if (!/^https:\/\//.test(verificationBaseUrl)) throw new Error("verification_base_url_must_be_https");
    this.from = from; this.verificationBaseUrl = verificationBaseUrl.replace(/\/$/, "");
    this.transport = nodemailer.createTransport({ host, port: Number(port), secure: Boolean(secure), ...(user && password ? { auth: { user, pass: password } } : {}), pool: true, disableFileAccess: true, disableUrlAccess: true });
  }
  get configured() { return true; }
  verificationUrl(token) {
    return `${this.verificationBaseUrl}/saas/verify#${encodeURIComponent(token)}`;
  }
  invitationUrl({ tenantId, token }) {
    const fragment = new URLSearchParams({ tenantId: String(tenantId || ""), token: String(token || "") });
    return `${this.verificationBaseUrl}/saas/invitation#${fragment}`;
  }
  async verifyTransport() { return this.transport.verify(); }
  async sendVerification({ to, email, token }) {
    to = String(to || email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || /[\r\n]/.test(to)) throw new Error("smtp_recipient_invalid");
    const url = this.verificationUrl(token);
    const result = await this.transport.sendMail({ from: this.from, to, subject: "WB Business Suite – E-Mail bestätigen", text: `Bestätigen Sie Ihre E-Mail-Adresse: ${url}\n\nDie 14-Tage-Testphase beginnt erst nach bestätigter Zahlung.`, html: `<p>Bestätigen Sie Ihre E-Mail-Adresse:</p><p><a href="${url}">E-Mail bestätigen</a></p><p>Die 14-Tage-Testphase beginnt erst nach bestätigter Zahlung.</p>` });
    if (!result.accepted?.length) throw new Error("smtp_recipient_rejected");
    return { accepted: true, messageId: result.messageId };
  }
  async sendInvitation({ to, email, tenantId, token, role = "MEMBER" }) {
    to = String(to || email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || /[\r\n]/.test(to)) throw new Error("smtp_recipient_invalid");
    const url = this.invitationUrl({ tenantId, token });
    const result = await this.transport.sendMail({ from: this.from, to, subject: "WB Business Suite – Einladung", text: `Sie wurden mit der Rolle ${role} eingeladen: ${url}\n\nMelden Sie sich mit Ihrer geschäftlichen Identität und MFA an.`, html: `<p>Sie wurden mit der Rolle <strong>${role}</strong> zur WB Business Suite eingeladen.</p><p><a href="${url}">Einladung annehmen</a></p><p>Melden Sie sich mit Ihrer geschäftlichen Identität und MFA an.</p>` });
    if (!result.accepted?.length) throw new Error("smtp_recipient_rejected");
    return { accepted: true, messageId: result.messageId };
  }
}

export const verificationToken = () => crypto.randomBytes(32).toString("base64url");
export const hashVerificationToken = (token, pepper) => {
  if (!pepper || pepper.length < 32) throw new Error("verification_pepper_invalid");
  return crypto.createHmac("sha256", pepper).update(String(token)).digest("hex");
};
export const customerIdentityHash = (email, pepper) =>
  hashVerificationToken(String(email || "").trim().toLowerCase(), pepper);
