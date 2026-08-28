# Green multi-tenant commercialization candidate

Status: verified non-destructive candidate only. Not approved for real external trial users or production cutover. The old server was not accessed. External submission remains hard-disabled.

## Source inventory and present isolation

This repository is the Tender service extracted from the productive RC23 image. It is not the source repository for the broader Admin/Business Portal. Classification below distinguishes evidence in this workspace from modules that cannot be truthfully audited here.

| Area | Store/evidence in this workspace | Isolation before migration 081 | Candidate state |
|---|---|---|---|
| CRM | No implementation or legacy store present | Unknown; broader portal source required | New neutral `tenant_portal.crm_accounts` and `crm_contacts`, mandatory tenant RLS, empty by default |
| CSM | No implementation or legacy store present | Unknown | New `tenant_portal.csm_customers`, mandatory tenant RLS, empty by default |
| Blocks | No implementation or legacy store present | Unknown | New `tenant_portal.blocks`, mandatory tenant RLS, empty by default |
| Employee portal | Only a read-only career SQLite sector lookup is present; no employee portal store | Career lookup is user-scoped, not tenant-scoped | New `tenant_portal.employee_profiles`; SaaS identities no longer read career sector assignments |
| IAM/users | Upstream PostgreSQL `iam.users`, sessions, roles, permissions, `tender_identity_scopes` | Globally stored; MFA session validation; scopes are company/sector, not tenant | `saas.tenant_memberships` remains the tenant mapping and is now RLS-protected. IAM realm/client provisioning remains external work |
| Companies | `tender.enterprise_company_links`, profiles, approvals, cost/configuration records | Hard-linked to existing WB entities and usually company-scoped in application SQL; no RLS | Customer tenants receive an organization shell only and no legacy Tender company binding. Only `INTERNAL` tenants may retain mapped legacy companies |
| Files/documents | Tender document blobs, enrichment documents, uploads, working copies, signatures, generated documents and malware scans | Mixed tender/company/lot checks in routes; no tenant key or RLS | New file/tender-document metadata is tenant-RLS-bound. Download fails closed until a tenant-aware storage adapter exists |
| Tasks/notes/reminders/favorites | `tender.tasks`, notes, reminders and favorites | User/company/tender scoped in route SQL; no tenant RLS | New `tenant_portal.tasks` is tenant-RLS-bound. Legacy tables are denied to SaaS identities |
| Settings/configuration | Company profiles, configuration versions/changes/parameters/costs, feature flags, source/scheduler catalogs | Mix of company-scoped and global records; no tenant RLS | Neutral `tenant_settings`; legacy configuration denied to SaaS identities |
| Tender public source | `tender.tenders`, versions, lots, sources and enrichment/import material | Shared schema; public list filters `data_class='PUBLIC_REAL'`, but rows and joins include fields not approved as a SaaS projection | Intended shared read-only catalog, but legacy route is blocked until an explicit minimal public projection is built |
| Tender tenant state | Favorites, relevance, evaluations, decisions, tasks, documents, requirements, calculations, portal credentials/sessions, packages, approvals, audit, submissions and queue jobs | Predominantly company/tender scoped; missing scope can expose rows because DB RLS is absent | New RLS tables for workspace, documents, credential references, draft submissions and jobs. Existing Autopilot routes/workers remain unavailable to SaaS |
| Billing/trial/plans | `saas` schema from migration 080 | Tenant IDs existed, schema grants were revoked, but no RLS | Tenant-owned lifecycle tables now use forced RLS; global plan catalog remains neutral/shared |

Cross-module legacy tables carrying the greatest risk are IAM users/scopes, `enterprise_company_links`, company profiles/configuration, `documents`/`document_blobs`/uploads, tasks/favorites/notes, audit events, Autopilot queue/results, portal credentials/sessions, bid packages, and submission state. Company filtering is not a tenant boundary. A single missed predicate can expose another WB company.

## Chosen tenancy model

- Customer-owned application data: shared PostgreSQL tables with non-null `tenant_id`, composite tenant/object foreign keys, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and one fail-closed policy based on transaction-local `app.tenant_id`.
- Request/worker access: `withTenantContext` opens a transaction and sets tenant and actor with `set_config(..., true)`. Missing context returns zero rows and rejects writes under the runtime role.
- Public procurement catalog: may be shared only through a separately reviewed read-only projection containing public source fields. Customer relevance, actions, documents, credentials, companies, users and workflow state never belong in that projection.
- Legacy WB Tender data: stays in place. SaaS identities are denied every legacy route. Company IDs for customer tenants are forced to an empty list.
- Files: database metadata is shared-table RLS. Object storage must use tenant-prefixed immutable keys and authorize downloads from the RLS lookup; the candidate returns 503 rather than issuing an unbound download.
- Portal secrets: the data plane stores only an opaque tenant-bound secret reference. A production secret vault should use a dedicated per-tenant namespace and a service identity unable to enumerate other namespaces.
- Especially sensitive Enterprise customers: a separate database (preferred) or schema plus distinct DB role is preferable for files, credentials, employee data and audit exports where contractual isolation or residency requires it. Shared-table RLS remains the baseline, not a reason to combine storage credentials.

## Provisioning and demo data

1. Registration creates a `CUSTOMER` tenant, pending registration and provider-neutral pending subscription under an explicit transaction-local tenant context.
2. `tenant_portal.provision_empty_tenant` creates only the customer-supplied organization display name, neutral settings with `demo_data_enabled=false`, and the minimum WB Control owner-administration baseline.
3. IAM provisioning binds the verified non-admin IAM user as `OWNER`. It does not grant an internal role, sector, WB company or legacy Tender scope.
4. Provider-confirmed billing may activate the selected 14-day trial only after email and IAM provisioning. Trial access uses the selected bundle, individual-module contract or full-suite entitlement.
5. CRM, CSM, Blocks, employees, files, tasks and Tender workspace tables remain empty.
6. Demo data requires the exact confirmation `ENABLE_SYNTHETIC_DEMO_DATA`. It inserts only marked synthetic rows and `.invalid` email addresses. It cannot be silently re-enabled and contains no WB-derived rows.

## Plan/module mapping

Migration 082 supersedes the phase-one feature-fragment mapping with ten canonical modules, standalone-module and full-suite scopes, hidden dependency capabilities, and the exact bundle matrix in `docs/commercial-modularization.md`. The old 080 placeholder amounts are cleared; no approved pricing source is present. The provider-neutral adapter still refuses checkout without explicit configuration.

## WB internal backfill

The phase-one backfill creates an `INTERNAL` tenant and a one-to-one ownership mapping for every row in `tender.enterprise_company_links`. It requires operator-supplied approved identifiers, exact source row count, immutable source fingerprint and unique run ID. It aborts on mismatch or prior bindings, records the result, and does not update/copy/delete any Tender business row. The rollback validates the exact tenant/run and refuses if lifecycle rows exist.

This preserves current WB behavior because legacy routes and rows are unchanged. It is not the final per-row enforcement migration. Before legacy tables can be served to customer tenants, every tenant-specific legacy table needs an asserted `tenant_id` backfill, non-null constraint, composite tenant foreign keys, forced RLS and a compatibility run against the WB internal tenant.

## Test and deployment evidence

- Unit/static suite: tenant transaction handling, mandatory RLS coverage, demo defaults/synthetic-only markers, legacy SaaS denial, file/search/list/export tenant binding and guarded backfill contracts.
- PostgreSQL 16 integration: migrations 080/081 applied on a clean database; this found and fixed migration 080's invalid bigint seed inference. A non-superuser runtime role verified empty onboarding for two tenants, tenant-A demo isolation, cross-tenant read denial, cross-tenant write denial and missing-context zero rows.
- Backfill drill: two synthetic legacy companies mapped to an internal tenant, assertions verified, then rollback removed exactly the mapping/run/tenant.
- Full application tests and release gates must remain green in the immutable candidate. Production/database readiness gates requiring live services are not evidence unless run in Green staging.

## Release blockers

- Obtain the actual Admin/Business Portal source and schema; audit and adapt CRM, CSM, Blocks, employee, file, task, export/search and shared tables there.
- Build a minimal shared-public Tender projection and migrate each selected Autopilot route/worker to tenant-owned state. Until then SaaS Tender APIs intentionally return `saas_legacy_data_plane_forbidden`.
- Add PostgreSQL integration coverage for every adapted route, queue claim, retry/DLQ path and object-storage download using the exact production runtime role.
- Configure a separate least-privilege privileged admin/reporting data plane. Cross-tenant admin listing currently fails 503 rather than bypassing RLS from the web role.
- Configure/test tenant-bound object storage and secret-vault adapters, IAM realm/client with MFA, email and billing providers, backup/restore, deletion/retention, monitoring and incident runbooks.
- Complete full WB per-row backfill/RLS and prove compatibility in a restored Green production snapshot.
- Obtain commercial, legal, privacy, tax, pricing, security and tender-specific human release approvals.

Rollback order: keep `WB_TENDER_SAAS_ENABLED=false`; roll application image back first; reverse the WB mapping only with its exact guarded rollback if used; if no active customer lifecycle exists, preserve migration-080/081 data for investigation or rename the entire `saas`/`tenant_portal` data plane using a reviewed follow-up rollback. No destructive schema rollback is authorized for live tenants.
