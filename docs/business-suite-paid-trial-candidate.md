# WB Business Suite paid-trial candidate (NEW Green only)

Status: candidate code only; no traffic cutover or live database migration. Productive Tender and the public careers SQLite/upload store are protected dependencies and are not written by this implementation. Both external-submission environment variables must be the literal string `false` in every candidate, worker and deployment.

## Added implementation

- CSM: tenant-owned customers with health, status, lifecycle, owner, renewal/follow-up dates, interactions, service cases and tasks. List, text search, JSON export, detail, create, update and delete enter transaction-local tenant context and require the canonical `csm` module.
- People: dedicated PostgreSQL employee profiles, employment status/contact/team/job/manager fields, onboarding tasks, Docs metadata references and a constrained absence-request data plane. It has no relationship to `/career-data/wb-cms.sqlite`, recruiting applications or public career uploads.
- Docs: metadata remains in forced-RLS PostgreSQL; object bytes use generated UUID keys physically rooted at `<configured-root>/<tenant-uuid>/<object-uuid>`. Caller paths are never accepted. Download rechecks tenant metadata and SHA-256. Upload, download and delete are audited.
- Control/IAM: the existing MFA identity remains authoritative. SaaS authorization comes only from one active tenant membership. Owner/admin/member/billing roles, invitations, acceptance, role/status changes, seat-trigger enforcement and self-protection are tenant-scoped. Multi-tenant membership is rejected until an explicit safe tenant selector exists.
- Providers: `StripeBillingAdapter` creates subscription Checkout sessions from configured price IDs and accepts only timestamp-valid, signed Stripe events. An unpaid Checkout event is rejected. Activation remains transactionally idempotent and starts exactly 14 days only after verified email, IAM provisioning and provider-confirmed payment. `SmtpEmailAdapter` uses only configured SMTP and HTTPS public-base settings. Missing configuration returns 503 and grants no access.
- UI/API: entitled navigation returns canonical `/saas/app/<module>` and API paths. The small tenant UI exposes search/list/export; mutation APIs enforce CSRF, tenant context, role and module entitlement. Unknown, revoked, expired or context-free access fails closed.

## Migration and rollback order

Apply on a restored Green-compatible database with SaaS flags disabled:

1. `080_saas_product_entitlements.sql`
2. `081_tenant_data_plane.sql`
3. `082_commercial_module_catalog.sql`
4. `083_real_admin_portal_tenant_columns.sql`
5. asserted `backfill-wb-internal-tenant.sql`
6. asserted `backfill-real-admin-internal-tenant.sql`
7. `084_real_admin_portal_tenant_enforcement.sql`
8. `085_business_suite_trial_data_plane.sql`
9. least-privilege grants, then runtime-role and two-tenant tests

Rollback is application-first and SaaS-disabled. Remove synthetic test tenants, run `rollback-business-suite-trial-data-plane.sql`, `rollback-real-admin-tenant-enforcement.sql`, `rollback-real-admin-internal-tenant-backfill.sql`, then `rollback-wb-internal-tenant-backfill.sql`. Every rollback refuses customer lifecycle/data outside its exact scope. Reapply with a new Admin backfill run UUID.

The executable rehearsal helpers require `WB_TENDER_ISOLATION_TEST_DATABASE=true`, an explicitly restored `DATABASE_URL`, and both submission flags set to `false`:

```sh
npm run test:business-suite-rehearsal
npm run test:tenant-isolation
npm run test:admin-tenant-isolation
npm run test:business-suite-rollback
REHEARSAL_ADMIN_RUN_ID=00000000-0000-4000-8000-000000000088 npm run test:business-suite-rehearsal
```

## Required runtime configuration (no values belong in source)

- Storage: `WB_TENDER_TENANT_STORAGE_ADAPTER=filesystem`, `WB_TENDER_TENANT_STORAGE_ROOT` on a dedicated external-tenant volume.
- Stripe: `SAAS_BILLING_PROVIDER=stripe`, `SAAS_BILLING_ADAPTER=stripe`, secret key and webhook secret from secret files, and approved Stripe price IDs per offered plan.
- Email: `SAAS_EMAIL_PROVIDER=smtp`, `SAAS_EMAIL_ADAPTER=smtp`, SMTP host/port/TLS/from and optional credentials from secret files.
- IAM/invites: `SAAS_INVITATION_PEPPER`, dedicated SaaS IAM login URL/client and approved callback configuration; current MFA policy remains mandatory.
- Commercial/legal: approved prices, taxes/invoicing, terms, privacy, imprint, DPA, retention/deletion and human security/commercial/legal approval.

`scripts/saas-commercial-readiness-gate.mjs` fails closed when SaaS is enabled and any required contract, evidence flag, provider, storage, IAM or legal setting is absent.
