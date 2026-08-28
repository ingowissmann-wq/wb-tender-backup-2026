# Real Admin/Business Portal integration candidate (NEW Green)

Status: candidate-only. No database migration, image replacement, nginx change, traffic cutover, external SaaS exposure, or tender submission was performed. The old server was not accessed. `WB_ADMIN_SAAS_ENABLED=false`, `WB_TENDER_SAAS_ENABLED=false`, `EXTERNAL_SUBMISSION_ENABLED=false`, and `WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false` remain the deployment defaults.

## Located production topology

- Host: `wb-tender-green` (NEW Green).
- Live nginx container: `wb-green-nginx`; configuration bind mount `/srv/wb-green/current/opt/wbholding/nginx/nginx.conf` → `/etc/nginx/nginx.conf`.
- Admin ingress: `admin.wb-holding.ag`; `/` redirects to `/admin/`; ordinary Admin requests proxy to `wb-auth-lockout-recovery-iam-user-create-canary-20260811:3400`. Tender paths `/admin/ausschreibungen[/...]` and `/api/tender/...` use nginx upstream `wb_tender_rc3312`, currently `wb-tender-public-ingestion-visibility-production-20260817:4240`.
- Compose project/service: `wb-green` / `admin`, declared in `/srv/wb-green/compose.green.yml`.
- Admin runtime container: `wb-auth-lockout-recovery-iam-user-create-canary-20260811`.
- Admin runtime image: `wb-phase4-platform@sha256:9641216275d8c93908aa7d02b487d98a9be858553a5e9754b26794882cc20c57`; command `node apps/api/dist/server.js`; workdir `/app`; user `node`.
- Current runtime implementation: `/app/apps/api/dist/server.js`, sibling modules `autoseo.js`, `calculator.js`, `globalTrash.js`, `iam-user-create.js`, `interviewInvitation.js`, `db.js`, and `security.js`; UI `/app/apps/admin/dist/assets/index-2Yce_8u7.js`.
- Admin PostgreSQL runtime: compose service `postgres`, live container `wb-phase4b-acceptance-postgres-1`, PostgreSQL 16.10, database `wb_platform`. Admin tables have no RLS and no `tenant_id` in the current live schema.
- Admin Redis runtime: `wb-phase4b-acceptance-redis-1` on the platform data network.
- Private files: host `/srv/wb-green/current/var/lib/docker/volumes/wb-phase4b-acceptance_private_files/_data` → `/data/private` (read/write).
- Career/People-adjacent data: host release `/srv/wb-green/current/opt/wb-holding/codex-migration/releases/runtime/website-20260728-career-integration-production` → `/career-data` (read/write), with shared SQLite `/career-data/wb-cms.sqlite` and `/career-data/uploads`.
- Retained editable source snapshot: `/srv/wb-green/current/opt/wb-holding/codex-migration/phase4-custom-platform/runtime/backups/dashboard-navigation-20260727T113126Z/configuration.tar.gz`, containing `apps/api/src`, `apps/admin/src`, contracts, database migrations, and tests.
- The mounted phase4 directory `/srv/wb-green/current/opt/wb-holding/codex-migration/phase4-custom-platform` contains migrations/runtime evidence but not the current application source. No current `apps/api/src` or `apps/admin/src` tree was found elsewhere on NEW Green. The retained editable source predates the August production IAM/career/global-trash changes; the exact latest implementation exists only as the compiled artifacts in the running image.
- Candidate import: `integrations/wb-admin-portal/source` contains the retained source snapshot with secrets/runtime/private data excluded. `integrations/wb-admin-portal/production-dist-baseline` contains the exact current compiled API/UI artifacts for deterministic comparison.

## Real module and storage inventory

| Canonical module | Real implementation found | Stores | Candidate SaaS state |
|---|---|---|---|
| `tender_scout` | Tender service | Tender public projection plus tenant state | Existing partial candidate; unchanged |
| `tender_autopilot` | Tender service | Tender PostgreSQL and protected files/secrets | Existing partial candidate; external submission remains impossible |
| `crm` | Admin `app.resources` types companies, contacts, leads, opportunities, pipelines, activities | `app.resources`, file links, audit; calculator links | Tenant ID + forced RLS, route entitlement, customer IAM permissions reduced |
| `csm` | No implementation, route, table, or runtime found | None | Hard blocked; catalog marks source absent |
| `flow` | Admin resource types tasks, reminders, notes, appointments and workflow mutations | `app.resources`, revisions/audit | Tenant ID + forced RLS; direct URL/search/export guarded |
| `people` | Recruiting/career and team functionality exists, but it is not a tenant-owned employee portal | Shared `/career-data/wb-cms.sqlite` and uploads, plus recruiting file links | Hard blocked for SaaS until a tenant-bound store exists |
| `docs` | Admin file upload/list/download/replace/delete/ZIP and resource documents | `files.objects`, `app.resource_files`, `crm.documents`, `recruiting.application_files`, `/data/private` | Metadata tenant-bound; all SaaS file operations return 503 until tenant-prefixed storage is implemented and enabled |
| `control` | MFA-capable IAM, roles/permissions, sessions, audit, trash/admin | Global `iam.*`, tenant memberships, `audit.events` | MFA reused; `/me` and logout tenant-aware. Global users/roles/sessions/audit enumeration remains blocked for SaaS |
| `insights` | Calculator dashboard, CRM metrics, filters, PDF/CSV exports | `app.resources`, `integration.calculator_*`, audit | Tenant-bound resource/dashboard reads; integration internals remain blocked to SaaS |
| `connect` | Calculator HMAC ingest, communication/webhook schemas, AutoSEO integration | `integration.*`, `communication.*`, Redis/secrets | Tables receive tenant ID/RLS, but service calls remain blocked until the signed payload and worker claim bind a tenant |

Internal CMS/website content is not commercialized as a customer module. It stays internal/shared and its SaaS routes are blocked. New customer provisioning remains empty and does not copy WB entities, staff, customers, documents, files, tasks, or configuration.

## Candidate changes and migration order

1. `migrations/083_real_admin_portal_tenant_columns.sql` inventories the real stores, adds nullable tenant columns/indexes, creates a data-only source manifest, and marks unavailable modules fail closed. SaaS must remain disabled.
2. `deployment/backfill-real-admin-internal-tenant.sql` requires the exact approved INTERNAL tenant UUID, unique run UUID, and exact manifest SHA-256. It assigns only existing Admin rows and tracked legacy IAM memberships to that tenant. It temporarily disables only the append-only audit update trigger inside the guarded transaction and immediately re-enables it.
3. `migrations/084_real_admin_portal_tenant_enforcement.sql` refuses incomplete backfills, adds non-null/default/composite tenant constraints, replaces global content-deduplication uniqueness with tenant-scoped uniqueness, and enables/forces RLS on 17 real Admin and cross-module tables.
4. `deployment/rollback-real-admin-tenant-enforcement.sql` is application-first and refuses rollback while any customer-tenant rows exist. `deployment/rollback-real-admin-internal-tenant-backfill.sql` reverses only the exact tracked run and refuses customer data.
5. `deployment/grant-real-admin-tenant-runtime-role.sql` grants only the existing non-superuser Admin runtime role the catalog/function and RLS-protected data access needed by the candidate.
6. The immutable-image patch adds transaction-local PostgreSQL context using a dedicated pooled connection, immediate canonical-module checks, customer-permission reduction, internal service/public-context binding, navigation hiding, and default-off storage/SaaS flags. Unknown or unadapted SaaS routes return 403.

The real Admin code continues to use its MFA challenge/session path. Customer identities derive permissions from their single active tenant membership and current modules; global IAM roles are discarded for customer requests. More than one/no active tenant membership fails closed. Internal users keep their current roles inside the one INTERNAL tenant.

## Verification evidence

- Exact production artifact patch: deterministic replacement assertions passed; patched server and database modules pass `node --check`.
- Unit/regression: 109/109 tests passed, including canonical route mapping, two synthetic tenant entitlement checks, immediate revocation, storage 503, no global IAM permission inheritance, and migration/rollback contracts.
- PostgreSQL rehearsal: disposable loopback-only PostgreSQL 16.10; real Admin migrations 0001–0004 followed by Tender 080–082, Admin 083, asserted backfill, and 084.
- Runtime-role isolation: a non-superuser role verified empty onboarding; tenant A created CRM, Flow, Docs metadata, Control audit, Insights, integration, and communication records; tenant B could not read/list/search/export/download/update/delete them; missing tenant context returned zero.
- Legacy compatibility: synthetic pre-migration Admin records remained visible only through the INTERNAL tenant after backfill.
- Rollback: correctly refused while synthetic customer data existed; after removing only that synthetic test data, enforcement/backfill rollback succeeded, the audit trigger was enabled, and backfill + 084 reapplied successfully with 17 forced-RLS tables.
- Immutable Admin candidate: `wb-phase4-platform@sha256:c23c61484aee1f7cefa635c67e4417f0a1eff27cd4982dba50a823b1f447c98a`, based on live image `sha256:9641216275d8c93908aa7d02b487d98a9be858553a5e9754b26794882cc20c57`.

## Remaining blockers / no-cutover decision

- The authoritative current TypeScript/React source repository is absent on NEW Green. Only the July source snapshot and exact August compiled runtime were found. The candidate therefore uses a fingerprinted deterministic patch over the exact live image; source-of-record recovery is required before production maintenance can be considered complete.
- No CSM implementation exists. It must remain unavailable.
- The shared career SQLite/upload store is not a safe external People data plane. It remains unavailable.
- Physical Docs/object storage is not tenant-prefixed or independently credentialed. SaaS file list/download/upload/export stays 503.
- Tenant-owned Control user/role/session/audit administration is incomplete; global administration stays blocked.
- Connect service payloads, webhooks, retry/DLQ/worker claims, and secrets are not tenant-bound end to end; customer Connect stays blocked.
- Current Admin source-level UI E2E tests could not be rebuilt from the absent authoritative August sources. The runtime navigation patch is verified statically/unit-wise, not with a full browser journey across every current Admin screen.
- A restored Green production snapshot rehearsal with approved WB manifest/counts, backups, monitoring, retention/deletion, IAM provisioning, tenant storage, and human security/commercial/legal readiness approvals is still required.

No production cutover is safe under these blockers. The live nginx, Admin image, databases, and traffic remain unchanged.
