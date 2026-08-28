# WB Business Suite commercial module contract (Green candidate)

Status: verified candidate scope only. SaaS and external submission remain disabled by default. This source contains Tender functionality and tenant-isolation foundations; it does not contain the broader Admin Portal business implementations.

## Canonical keys and bundle matrix

| Technical key | Product name | Core | Normal | Professional | Enterprise | Suite |
|---|---|---:|---:|---:|---:|---:|
| `tender_scout` | WB Tender Scout | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tender_autopilot` | WB Tender Autopilot |  | ✓ | ✓ | ✓ | ✓ |
| `crm` | WB CRM |  |  | ✓ | ✓ | ✓ |
| `csm` | WB CSM |  |  | ✓ | ✓ | ✓ |
| `flow` | WB Flow |  | ✓ | ✓ | ✓ | ✓ |
| `people` | WB People |  | ✓ | ✓ | ✓ | ✓ |
| `docs` | WB Docs |  | ✓ | ✓ | ✓ | ✓ |
| `control` | WB Control | ✓ | ✓ | ✓ | ✓ | ✓ |
| `insights` | WB Insights |  |  | ✓ | ✓ | ✓ |
| `connect` | WB Connect |  |  |  | ✓ | ✓ |

`WB Business Suite` has product key `wb_business_suite` and grants all ten modules. `commercial_scope` distinguishes bundle (`BUNDLE`), individually contracted modules (`MODULES`) and full suite (`SUITE`). A tenant-level explicit module row takes precedence over bundle/suite inheritance, so a disabled row revokes the module immediately. Access also requires an active tenant, active membership and active non-expired subscription or trial.

No approved module pricing exists in this repository. Migration 082 removes the old 080 placeholder amounts from the database source of truth; pricing remains configurable and externally governed.

## Provisioning and dependencies

Provisioning creates only an empty organization, settings with demo disabled, and the `control` baseline required for owner administration. It copies no WB data. Contract modules are configured separately. Synthetic demo data still requires the exact opt-in confirmation and uses only `.invalid` identities.

WB Tender Autopilot has hidden technical dependencies on `tender.public_discovery` and `docs.object_storage`. Those capabilities are supplied to Autopilot internally. They do not add Scout or Docs to navigation and do not authorize direct Scout/Docs HTTP routes, exports or downloads. Commercially purchasing Autopilot therefore does not silently expose another paid module.

## Route and implementation mapping

All SaaS module routes live under `/api/tenant-portal/modules/...`. SaaS identities remain categorically denied from legacy `/api/tenders`, `/api/management-inbox`, `/api/autopilot` and other WB Tender data-plane routes by `saas_legacy_data_plane_forbidden`.

| Module | Candidate route/data contract | Status |
|---|---|---|
| Tender Scout | Entitled public-real discovery/search at `/api/tenant-portal/modules/tender-scout`; tenant favorites/deadlines/alerts remain cataloged but are not claimed complete | Partial |
| Tender Autopilot | RLS-isolated `tenant_portal.tender_workspaces`, documents, credential references and permanently non-transmitting drafts | Partial foundation; legacy Autopilot is not exposed |
| Control | Tenant organization/settings summary, entitlement administration contract, audit foundation and explicit demo opt-in | Foundation |
| CRM | Guard plus RLS-isolated empty account/contact shell | Secure empty shell |
| CSM | Guard plus RLS-isolated empty customer-health shell | Secure empty shell |
| Flow | Guard plus RLS-isolated empty Blocks/tasks shell | Secure empty shell |
| People | Guard plus RLS-isolated empty employee-profile shell | Secure empty shell |
| Docs | Guard, RLS-isolated file metadata and controlled-download adapter boundary | Secure empty shell; storage adapter absent |
| Insights | Guard, navigation/catalog and empty response contract | Secure empty shell |
| Connect | Guard, navigation/catalog and empty response contract | Secure empty shell |

Every list, search, export, download and job enqueue route runs its module guard before querying module data. Jobs store `module_key`; the database claim function rechecks tenant context, lifecycle and current entitlement, so revocation prevents workers from claiming queued work. RLS remains forced on tenant-owned tables and no application guard substitutes for it.

## Deployment boundary

Migration order is 080, 081, 082. Application rollback starts by setting `WB_TENDER_SAAS_ENABLED=false`; the 082 database rollback refuses live non-baseline commercial entitlements. `EXTERNAL_SUBMISSION_ENABLED=false` and `WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false` remain immutable candidate requirements.
