#!/usr/bin/env python3
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
PLATFORM = ROOT / "platform"


def load(name):
    p = PLATFORM / name
    if not p.exists():
        raise SystemExit(f"missing:{p}")
    return p, p.read_text()


def save(p, text):
    p.write_text(text)


def once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"patch_anchor_{label}_count={count}")
    return text.replace(old, new, 1)


def regex_once(text, pattern, repl, label, flags=0):
    new, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"patch_anchor_{label}_count={count}")
    return new

# The dedicated workflow module must already be copied from the feature branch.
module = PLATFORM / "saas-email-first-trial.mjs"
if not module.exists():
    raise SystemExit("missing:platform/saas-email-first-trial.mjs")

# 1) SMTP: allow only the new trial verification path in addition to the legacy path.
p, s = load("saas-adapters.mjs")
s = once(
    s,
    '  verificationUrl(token) {\n    return `${this.verificationBaseUrl}/saas/verify#${encodeURIComponent(token)}`;\n  }',
    '  verificationUrl(token, verificationPath = "/saas/verify") {\n'
    '    const path = verificationPath === "/saas/trial/verify" ? verificationPath : "/saas/verify";\n'
    '    return `${this.verificationBaseUrl}${path}#${encodeURIComponent(token)}`;\n'
    '  }',
    "verification_url",
)
s = once(
    s,
    '  async sendVerification({ to, email, token }) {',
    '  async sendVerification({ to, email, token, verificationPath = "/saas/verify" }) {',
    "send_verification_signature",
)
s = once(
    s,
    '    const url = this.verificationUrl(token);',
    '    const url = this.verificationUrl(token, verificationPath);',
    "send_verification_url",
)

# 2) Stripe: opt-in success path for the email-first trial only. Legacy behavior remains unchanged.
s = regex_once(
    s,
    r'async createCheckout\(\{ tenantId, plan, purchaseKind, billingPath, bookingId, consentVersion, amountSubtotal, renewal = false \}\) \{',
    'async createCheckout({ tenantId, plan, purchaseKind, billingPath, bookingId, consentVersion, amountSubtotal, renewal = false, successPath = "" }) {',
    "stripe_create_checkout_signature",
)
s = once(
    s,
    '      success_url: `${this.publicBaseUrl}/saas/${trial ? "trial" : "package"}-complete?session_id={CHECKOUT_SESSION_ID}`,',
    '      success_url: `${this.publicBaseUrl}${trial && successPath === "/saas/trial/setup" ? successPath : `/saas/${trial ? "trial" : "package"}-complete`}?session_id={CHECKOUT_SESSION_ID}`,',
    "stripe_success_url",
)
save(p, s)

# 3) Dedicated module: request the setup success path. No hard-coded price/duration is introduced.
p, s = load("saas-email-first-trial.mjs")
s = once(
    s,
    "    contract=bookingContract({\n      purchaseKind:'TRIAL',plan:'TRIAL',billingPath:'AUTO_CARD',\n      consentVersion:BOOKING_TERMS_VERSION,bookingConfirmed:true\n    });",
    "    contract={...bookingContract({\n      purchaseKind:'TRIAL',plan:'TRIAL',billingPath:'AUTO_CARD',\n      consentVersion:BOOKING_TERMS_VERSION,bookingConfirmed:true\n    }),successPath:'/saas/trial/setup'};",
    "trial_success_path",
)
save(p, s)

# 4) Core SaaS: wire routes and separate webhook payment from IAM activation for this flow.
p, s = load("saas-platform.mjs")
import_line = "import { registerEmailFirstTrialRoutes, markEmailFirstPaymentPendingSetup } from './saas-email-first-trial.mjs';\n"
if import_line not in s:
    anchor = "import { withTenantContext } from \"./tenant-context.mjs\";\n"
    s = once(s, anchor, anchor + import_line, "email_first_import")

legacy = '''    if (mapped === "PAYMENT_CONFIRMED") {
      await client.query("UPDATE saas.tenants SET status='ACTIVE',updated_at=$2 WHERE id=$1", [event.tenantId, now]);
      await client.query("UPDATE saas.pending_registrations SET status=CASE WHEN iam_provisioned_at IS NULL THEN 'IAM_PROVISIONING_PENDING' ELSE 'ACTIVATED' END,verification_token_hash=NULL,updated_at=$2 WHERE tenant_id=$1", [event.tenantId, now]);
      if (!(await client.query("SELECT iam_provisioned_at FROM saas.pending_registrations WHERE tenant_id=$1",[event.tenantId])).rows[0]?.iam_provisioned_at) {
        const provisioned = (await client.query("SELECT saas.provision_pending_native_identity($1) user_id", [event.tenantId])).rows[0]?.user_id;
        if (!provisioned) throw new Error("activation_identity_missing");
        const company = (await client.query("INSERT INTO saas.tenant_companies(id,tenant_id,display_name,status) SELECT id,id,display_name,'ACTIVE' FROM saas.tenants WHERE id=$1 RETURNING id", [event.tenantId])).rows[0];
        if (!company) throw new Error("activation_company_missing");
        await client.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'REGISTERED_COMPANY_ACTIVATED','tenant_company',$1::uuid::text)", [event.tenantId,provisioned]);
      }
    }'''
replacement = '''    if (mapped === "PAYMENT_CONFIRMED") {
      const emailFirstTrial = event.purchaseKind === "TRIAL"
        ? await markEmailFirstPaymentPendingSetup(client,event.tenantId,event.checkoutRef,now)
        : false;
      if (!emailFirstTrial) {
        await client.query("UPDATE saas.tenants SET status='ACTIVE',updated_at=$2 WHERE id=$1", [event.tenantId, now]);
        await client.query("UPDATE saas.pending_registrations SET status=CASE WHEN iam_provisioned_at IS NULL THEN 'IAM_PROVISIONING_PENDING' ELSE 'ACTIVATED' END,verification_token_hash=NULL,updated_at=$2 WHERE tenant_id=$1", [event.tenantId, now]);
        if (!(await client.query("SELECT iam_provisioned_at FROM saas.pending_registrations WHERE tenant_id=$1",[event.tenantId])).rows[0]?.iam_provisioned_at) {
          const provisioned = (await client.query("SELECT saas.provision_pending_native_identity($1) user_id", [event.tenantId])).rows[0]?.user_id;
          if (!provisioned) throw new Error("activation_identity_missing");
          const company = (await client.query("INSERT INTO saas.tenant_companies(id,tenant_id,display_name,status) SELECT id,id,display_name,'ACTIVE' FROM saas.tenants WHERE id=$1 RETURNING id", [event.tenantId])).rows[0];
          if (!company) throw new Error("activation_company_missing");
          await client.query("INSERT INTO saas.audit_events(tenant_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'REGISTERED_COMPANY_ACTIVATED','tenant_company',$1::uuid::text)", [event.tenantId,provisioned]);
        }
      }
    }'''
s = once(s, legacy, replacement, "payment_activation_split")

route_anchor = "  registerBillingWebhookRoute(app, { pool, enabled, billingAdapter });\n"
route_call = "  registerEmailFirstTrialRoutes(app, { pool, guard, verificationPepper, fieldEncryptionKey, emailAdapter, billingAdapter });\n"
if route_call not in s:
    s = once(s, route_anchor, route_anchor + route_call, "register_trial_routes")

# Change only the trial CTA. Package registration remains legacy and untouched.
s = regex_once(
    s,
    r'href="/saas/register\?plan=TRIAL"',
    'href="/saas/trial/start"',
    "trial_cta",
)
save(p, s)

# 5) Guardrails: the new code must never put fine-grained onboarding states in pending_registrations.
combined = (PLATFORM / "saas-email-first-trial.mjs").read_text()
for forbidden in [
    "pending_registrations SET status='ACCOUNT_SETUP_PENDING'",
    "pending_registrations SET status='MFA_SETUP_PENDING'",
]:
    if forbidden in combined:
        raise SystemExit(f"forbidden_pending_status:{forbidden}")
if "SET status='IAM_PROVISIONING_PENDING'" not in combined:
    raise SystemExit("missing_final_iam_transition")
if "successPath:'/saas/trial/setup'" not in combined:
    raise SystemExit("missing_trial_success_path")

print("EMAIL_FIRST_PATCH_OK")
print("changed=platform/saas-adapters.mjs,platform/saas-platform.mjs,platform/saas-email-first-trial.mjs")
print("production_state_modified=false")
