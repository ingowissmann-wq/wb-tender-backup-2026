# WB Tender SaaS commercialization: Green-only implementation plan

Status: implementation-ready foundation, not approved for public deployment. The old server is out of scope and unchanged. `WB_TENDER_SAAS_ENABLED` defaults off. `EXTERNAL_SUBMISSION_ENABLED=false` and `WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false` remain mandatory.

Follow-up status: migration 081 and the Green tenant data-plane candidate are documented in `docs/tenant-isolation-candidate.md`. Real external trials remain blocked; legacy WB Tender APIs are intentionally unavailable to SaaS identities.

## Architecture findings

- The application is a Fastify/Node service backed by PostgreSQL, with a separate read-only SQLite career-sector source. The Tender UI is served by the same process.
- Production IAM uses upstream `iam.users`, roles, permissions and MFA-verified hashed sessions. Tender scopes are direct company/sector grants. There was no self-service credential, tenant, subscription, billing or email-verification model in this source.
- The existing UI and APIs are private, permission-protected and globally `noindex`. Public tender rows are explicitly limited to `data_class='PUBLIC_REAL'`; document and portal actions additionally require exact company/portal scope.
- Existing company data in `tender.enterprise_company_links` is internal. SaaS companies therefore live in `saas.tenant_companies` and may link to Tender companies only through an explicit, unique binding.
- Submission routes are hard-disabled with HTTP 423 and false runtime capabilities. SaaS entitlements contain no external-submission feature.
- No payment/email provider implementation or approved commercial/legal content exists in the repository.

## Implemented boundary

Migration 080 adds the initial data-driven plan and lifecycle foundation. Migration 082 adds the canonical WB Business Suite module catalog, bundle/standalone/suite scopes and tenant overrides, and clears the unapproved 080 placeholder amounts. No price is treated as an approved source of truth; pricing remains configurable.

Registration stores a hashed customer identity and hashed, expiring verification token. It creates no IAM user, IAM role, internal company scope or active trial. Tokens are delivered only through an email adapter and are accepted in a POST body; the browser verification URL uses a fragment so the token is not placed in server logs. Duplicate registration responses do not disclose whether an email exists.

Customer login reuses MFA-capable IAM through a separately configured SaaS login URL. No local password system was invented. A provisioned SaaS IAM identity is reduced to tenant-owned company bindings, loses internal admin roles/permissions in SaaS context, and must pass tenant, subscription and canonical module-entitlement checks.

Billing is provider-neutral. Checkout never activates a trial. Only an authenticated, signed, idempotent payment webhook can move `PENDING_PAYMENT` to a 14-day `TRIAL_ACTIVE` state, and the one-trial claim is transactionally unique per normalized customer identity. Effective access locks immediately at expiry. Provider-confirmed upgrades/downgrades are validated against current seat/company usage.

Internal admin APIs list tenants, status, plan and current/allowed seat/company counts and can suspend/reactivate with CSRF protection and audit. Reactivation cannot invent a paid state.

## Remaining implementation and deployment sequence

1. Select payment and transactional-email providers; implement their concrete adapters, secret loading, retry/dead-letter handling, webhook replay validation and provider sandbox tests.
2. Configure the commercial IAM realm/client, verified redirect allowlist, MFA policy and automated provisioning that creates only the SaaS role/membership. Test deprovisioning and multi-tenant identity policy.
3. Have authorized counsel and commercial owners approve prices, tax/invoice behavior, AGB/terms, Datenschutz notice, Impressum, DPA/AVV, retention/deletion policy and consent/marketing behavior. Link the approved immutable versions.
4. Apply migration 080 to a Green staging database; use a distinct least-privilege runtime DB role with only required `saas` grants. Do not apply to the old server.
5. Run tenant-isolation integration tests against PostgreSQL, IAM sandbox login/MFA tests, email deliverability tests, payment-provider sandbox checkout/webhook/refund/dispute tests, accessibility/browser tests, backup/restore and load/rate-limit tests.
6. Keep both external-submission environment variables false and run `npm test`, `npm run gate`, `npm run verify:artifact`, `npm run gate:readiness`, and `npm run gate:saas` in the release artifact.
7. Deploy Green with `WB_TENDER_SAAS_ENABLED=false`, validate health and internal Tender regressions, then enable only on an allowlisted hostname/canary after human go-live approval. Monitor registration, verification, payment, entitlement and audit metrics.
8. Roll back first by disabling the flag. If database rollback is required and no lifecycle is live, use `deployment/rollback-saas-product-entitlements.sql`, which preserves records by renaming the schema.

## Go-live blockers

- Concrete payment provider, merchant configuration, webhook secret, checkout adapter and provider sandbox acceptance.
- Transactional email provider/domain authentication, verification-email adapter/templates, bounce/retry handling and deliverability acceptance.
- Dedicated SaaS IAM client/realm/login URL, callback configuration, MFA and safe membership provisioning.
- Approved prices/taxes/invoicing and approved AGB/terms, Datenschutz/DSGVO notice, Impressum and DPA/AVV; retention/deletion and consent decisions.
- Production PostgreSQL migration/integration evidence, least-privilege grants, backup/restore evidence, observability/runbooks and human commercial/security/legal release approval.

The readiness gate fails closed on these items whenever the SaaS feature flag is enabled.
