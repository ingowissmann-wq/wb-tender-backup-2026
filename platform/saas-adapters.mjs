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
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(stripeType)) return object?.metadata?.tenant_id || object?.client_reference_id;
  return object?.metadata?.tenant_id
    || object?.parent?.subscription_details?.metadata?.tenant_id
    || object?.subscription_details?.metadata?.tenant_id;
};

export class StripeBillingAdapter {
  constructor({ secretKey, webhookSecret, publicBaseUrl, priceIds = {}, activationPriceId, setupPriceIds = {}, apiBase = "https://api.stripe.com", now = () => Date.now() }) {
    if (!String(secretKey || "").startsWith("sk_")) throw new Error("stripe_secret_key_invalid");
    if (!String(webhookSecret || "").startsWith("whsec_") || webhookSecret.length < 24) throw new Error("stripe_webhook_secret_invalid");
    if (!/^https:\/\//.test(String(publicBaseUrl || ""))) throw new Error("stripe_public_base_url_invalid");
    this.secretKey = secretKey; this.webhookSecret = webhookSecret; this.publicBaseUrl = publicBaseUrl.replace(/\/$/, ""); this.priceIds = priceIds; this.activationPriceId = activationPriceId; this.setupPriceIds = setupPriceIds; this.apiBase = apiBase; this.now = now;
  }
  get provider() { return "stripe"; }
  get configured() { return true; }
  async createCheckout({ tenantId, plan, purchaseKind, billingPath, bookingId, consentVersion, renewal = false }) {
    const trial = purchaseKind === "TRIAL";
    if (!["TRIAL", "PACKAGE"].includes(purchaseKind)) throw new Error("billing_purchase_kind_invalid");
    if (!["AUTO_CARD", "INVOICE_BILLIE"].includes(billingPath)) throw new Error("stripe_billing_path_invalid");
    if (!bookingId || consentVersion !== "standalone-2026-09-07") throw new Error("billing_explicit_booking_required");
    if (trial && (plan !== "TRIAL" || renewal)) throw new Error("billing_trial_contract_invalid");
    if (!trial && !["NORMAL", "PROFESSIONAL", "ENTERPRISE"].includes(plan)) throw new Error("stripe_plan_price_not_configured");
    if (renewal && billingPath === "AUTO_CARD") throw new Error("billing_manual_renewal_required");
    const automatic = !trial && billingPath === "AUTO_CARD";
    const method = billingPath === "AUTO_CARD" ? "card" : "billie";
    const body = new URLSearchParams({
      mode: automatic ? "subscription" : "payment",
      "payment_method_types[0]": method,
      "automatic_tax[enabled]": "true",
      "tax_id_collection[enabled]": "true",
      "billing_address_collection": "required",
      "consent_collection[terms_of_service]": "required",
      success_url: `${this.publicBaseUrl}/saas/${trial ? "trial" : "package"}-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.publicBaseUrl}/saas/pricing`,
      client_reference_id: tenantId,
      "metadata[tenant_id]": tenantId,
      "metadata[plan_code]": plan,
      "metadata[purchase_kind]": purchaseKind,
      "metadata[billing_path]": billingPath,
      "metadata[booking_id]": bookingId,
      "metadata[consent_version]": consentVersion,
      "metadata[renewal]": String(renewal),
      "line_items[0][quantity]": "1",
    });
    const priceId = trial ? this.activationPriceId : this.priceIds[plan];
    if (!/^price_[A-Za-z0-9]+$/.test(String(priceId || ""))) throw new Error("stripe_plan_price_not_configured");
    if (trial || automatic) body.set("line_items[0][price]", priceId);
    else {
      // A recurring Price cannot be used in payment mode. A separate one-time
      // price is derived from the approved product for each expressly booked month.
      const response = await fetch(`${this.apiBase}/v1/prices/${priceId}`, { headers: { authorization: `Bearer ${this.secretKey}` } });
      const price = await response.json();
      const expected = { NORMAL: 99000, PROFESSIONAL: 149000, ENTERPRISE: 249000 }[plan];
      if (!response.ok || !price.active || price.currency !== "eur" || price.unit_amount !== expected || price.recurring?.interval !== "month" || price.recurring?.interval_count !== 1 || price.tax_behavior !== "exclusive") throw new Error("stripe_catalog_mismatch");
      body.set("line_items[0][price_data][currency]", "eur");
      body.set("line_items[0][price_data][unit_amount]", String(expected));
      body.set("line_items[0][price_data][product]", price.product);
      body.set("line_items[0][price_data][tax_behavior]", "exclusive");
    }
    if (!trial && !renewal) {
      const setup = this.setupPriceIds[plan];
      if (!/^price_[A-Za-z0-9]+$/.test(String(setup || ""))) throw new Error("stripe_setup_price_not_configured");
      body.set("line_items[1][price]", setup);
      body.set("line_items[1][quantity]", "1");
    }
    if (automatic) {
      body.set("payment_method_collection", "always");
      for (const key of ["tenant_id", "plan_code", "purchase_kind", "billing_path", "booking_id", "consent_version"])
        body.set(`subscription_data[metadata][${key}]`, body.get(`metadata[${key}]`));
    }
    const response = await fetch(`${this.apiBase}/v1/checkout/sessions`, { method: "POST", headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": `wb-booking-${bookingId}` }, body });
    const payload = await response.json();
    if (!response.ok || !payload.id || !payload.url) throw new Error(`stripe_checkout_failed_${response.status}`);
    return { id: payload.id, url: payload.url };
  }
  async prepareCheckoutCompletion() {
    // Deliberately no invoice items, subscriptions or future charges here.
    return { prepared: false };
  }
  async resolvePaymentPeriod(event) {
    if (event.type !== "payment.confirmed" || event.purchaseKind !== "PACKAGE" || event.billingPath !== "AUTO_CARD") return event;
    if (!/^sub_[A-Za-z0-9_]+$/.test(String(event.subscriptionRef || ""))) throw new Error("billing_subscription_reference_invalid");
    const response = await fetch(`${this.apiBase}/v1/subscriptions/${event.subscriptionRef}`, { headers: { authorization: `Bearer ${this.secretKey}` } });
    const subscription = await response.json();
    const item = subscription.items?.data?.[0];
    const periodEnd = subscription.current_period_end || item?.current_period_end;
    if (!response.ok || subscription.id !== event.subscriptionRef || subscription.customer !== event.customerRef || subscription.status !== "active" || subscription.metadata?.tenant_id !== event.tenantId || subscription.metadata?.purchase_kind !== "PACKAGE" || subscription.metadata?.plan_code !== event.plan || subscription.items?.data?.length !== 1 || item.price?.id !== this.priceIds[event.plan] || !Number.isSafeInteger(periodEnd) || periodEnd * 1000 <= this.now()) throw new Error("billing_subscription_period_invalid");
    return { ...event, periodEnd };
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
    const supported = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "invoice.paid", "invoice.payment_failed"]);
    if (!supported.has(stripe.type)) return { id: stripe.id, provider: "stripe", stripeType: stripe.type, ignored: true };
    const checkoutEvent = ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(stripe.type);
    const tenantId = stripeTenantId(stripe.type, object);
    let type;
    if (checkoutEvent && object.payment_status === "paid" && ["subscription","payment"].includes(object.mode) && object.id) type = "payment.confirmed";
    else if (stripe.type === "invoice.paid" && object.status === "paid" && object.paid === true) type = "invoice.paid";
    else if (stripe.type === "invoice.payment_failed" && object.paid !== true) type = "payment.failed";
    else throw new Error("billing_event_unsupported_or_unpaid");
    if (checkoutEvent) {
      const metadata = object.metadata || {};
      const trial = metadata.purchase_kind === "TRIAL";
      if (!["AUTO_CARD", "INVOICE_BILLIE"].includes(metadata.billing_path)) throw new Error("billing_path_invalid");
      if (!["TRIAL", "PACKAGE"].includes(metadata.purchase_kind) || !metadata.booking_id || metadata.consent_version !== "standalone-2026-09-07") throw new Error("billing_booking_metadata_invalid");
      if (trial && (object.mode !== "payment" || object.subscription || metadata.plan_code !== "TRIAL" || metadata.renewal !== "false")) throw new Error("billing_trial_contract_invalid");
      if (!trial && (!["NORMAL", "PROFESSIONAL", "ENTERPRISE"].includes(metadata.plan_code) || (metadata.billing_path === "AUTO_CARD" ? object.mode !== "subscription" || !object.subscription : object.mode !== "payment" || Boolean(object.subscription)))) throw new Error("billing_package_contract_invalid");
      if (object.currency !== "eur" || !Number.isSafeInteger(object.amount_subtotal)) throw new Error("billing_amount_invalid");
    }
    if (!stripe.id || !tenantId) throw new Error("billing_webhook_payload_invalid");
    return {
      id: stripe.id, type, tenantId, provider: "stripe", stripeType: stripe.type,
      checkoutRef: checkoutEvent ? object.id : null,
      customerRef: object.customer || null,
      subscriptionRef: checkoutEvent ? object.subscription : stripeInvoiceSubscription(object),
      plan: checkoutEvent ? object.metadata?.plan_code : null,
      billingPath: checkoutEvent ? object.metadata?.billing_path : null,
      periodEnd: stripe.type === "invoice.paid" ? Math.max(0, ...(object.lines?.data || []).filter(line => line.subscription === stripeInvoiceSubscription(object) || line.parent?.subscription_item_details?.subscription === stripeInvoiceSubscription(object)).map(line => Number(line.period?.end || 0))) : null,
      invoiceSubtotal: stripe.type === "invoice.paid" ? object.subtotal : null,
      invoiceCurrency: stripe.type === "invoice.paid" ? object.currency : null,
      purchaseKind: checkoutEvent ? object.metadata?.purchase_kind : (object.parent?.subscription_details?.metadata || object.subscription_details?.metadata || object.metadata)?.purchase_kind,
      bookingId: checkoutEvent ? object.metadata?.booking_id : null,
      amountSubtotal: checkoutEvent ? object.amount_subtotal : null,
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
    this.transport = nodemailer.createTransport({ host, port: Number(port), secure: Boolean(secure), ...(user && password ? { auth: { user, pass: password } } : {}), pool: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 45000, disableFileAccess: true, disableUrlAccess: true });
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
  async sendBookingConfirmation({ to, bookingId, purchaseKind, planName, amountSubtotal, billingPath, periodEnd }) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || "")) || /[\r\n]/.test(to)) throw new Error("smtp_recipient_invalid");
    if (!["TRIAL","PACKAGE"].includes(purchaseKind) || !Number.isSafeInteger(Number(amountSubtotal)) || Number(amountSubtotal)<=0 || !bookingId) throw new Error("booking_confirmation_invalid");
    const amount = new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR"}).format(Number(amountSubtotal)/100);
    const terms = purchaseKind === "TRIAL"
      ? "Ihr Testzugang endet automatisch nach exakt 14 Tagen. Keine automatische Verlängerung und keine Umwandlung in ein Paket. Pakete können Sie separat und ausdrücklich buchen."
      : billingPath === "AUTO_CARD"
        ? "Das separat gebuchte Paket wird entsprechend Ihrer ausdrücklichen Buchung monatlich per Karte abgerechnet."
        : "Sie haben einen Nutzungsmonat bezahlt. Weitere Monate buchen und bezahlen Sie gesondert im Kundenkonto. Ohne erneute Zahlung endet der Zugang.";
    const end = periodEnd ? new Date(periodEnd).toISOString() : "siehe Kundenkonto";
    const result = await this.transport.sendMail({ from:this.from, to, messageId:`<wb-booking-${bookingId}@wb-tender.com>`,
      subject:"WB-Tender – Buchung bestätigt",
      text:`Ihre Zahlung wurde bestätigt.\nAngebot: ${planName}\nBezahlter Nettobetrag: ${amount} zuzüglich Umsatzsteuer laut Stripe-Beleg.\nAktueller Zugangszeitraum bis: ${end}\n\n${terms}\n\nKundenkonto: ${this.verificationBaseUrl}/saas/account\nBuchungsreferenz: ${bookingId}` });
    if (!result.accepted?.length) throw new Error("smtp_recipient_rejected");
    return {accepted:true,messageId:result.messageId};
  }
  async sendInvitation({ to, email, tenantId, token, role = "MEMBER" }) {
    to = String(to || email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || /[\r\n]/.test(to)) throw new Error("smtp_recipient_invalid");
    const url = this.invitationUrl({ tenantId, token });
    const result = await this.transport.sendMail({ from: this.from, to, subject: "WB Business Suite – Einladung", text: `Sie wurden mit der Rolle ${role} eingeladen: ${url}\n\nRichten Sie über den Einladungslink Ihr eigenes Passwort und Ihren Authenticator ein. Bei einem bestehenden Konto melden Sie sich an und bestätigen die Einladung.`, html: `<p>Sie wurden mit der Rolle <strong>${role}</strong> zur WB Business Suite eingeladen.</p><p><a href="${url}">Einladung annehmen</a></p><p>Richten Sie über den Einladungslink Ihr eigenes Passwort und Ihren Authenticator ein. Bei einem bestehenden Konto melden Sie sich an und bestätigen die Einladung.</p>` });
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
