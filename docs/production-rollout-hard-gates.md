# Production rollout hard gates

`deployment/production-rollout.sh` is an operator-run, fail-closed release primitive. It does not submit or enable external tender actions. The operator must keep both `EXTERNAL_SUBMISSION_ENABLED` and `WB_TENDER_ALLOW_EXTERNAL_SUBMISSION` false; the script exports those values itself and the HTTP gate proves the authenticated transmit endpoint returns HTTP 423 with `external_submission_enabled=false` and `transmitted=false`.

## Immutable inputs

The checkout must be clean and exactly match `EXPECTED_COMMIT` and `EXPECTED_TREE`. `RELEASE_IMAGE` and `POSTGRES_IMAGE` must be registry-digest references. The release image ID must equal `EXPECTED_RELEASE_IMAGE_ID`, and its OCI `org.opencontainers.image.revision` and `org.opencontainers.image.source-tree` labels must equal the approved commit and tree.

`REHEARSAL_EVIDENCE` has a closed field set enforced by `scripts/verify-rollout-binding.mjs`; unknown, missing, duplicate, malformed, or non-PASS fields fail the rollout. Its exact SHA-256 is supplied as `EXPECTED_EVIDENCE_SHA256`.

`OPERATOR_APPROVAL` must be a regular, non-symlink file owned by UID 0 with mode 0600 or stricter. Its exact content is:

```text
APPROVAL_VERSION=1
APPROVE_COMMIT=<40 lowercase hex>
APPROVE_TREE=<40 lowercase hex>
APPROVE_IMAGE_DIGEST=sha256:<64 lowercase hex>
APPROVE_EVIDENCE_SHA256=<64 lowercase hex>
EXTERNAL_SUBMISSION_ENABLED=false
```

All database URLs, encryption keys, cookies, CSRF values, passwords, keys, tokens, and session material are file inputs with mode 0600 or stricter. Known inline secret variables are rejected. The database/key/session file paths are supplied through `DATABASE_URL_FILE`, `BACKUP_ENCRYPTION_KEY_FILE`, and `PRODUCTION_SESSION_FILE`.

## Backup, restore, and rollback

Before touching the live schema, the rollout creates a new encrypted custom-format logical dump with the existing file-based key. It verifies the ciphertext checksum, decrypts and verifies the plaintext checksum, and reads the `pg_restore` catalog. That exact new ciphertext is then restored into a temporary PostgreSQL container attached only to a newly created Docker `--internal` network. Only missing release migrations are applied there, followed by the real tenant and admin database isolation programs and exact server-side Pro 99000, Business 149000, and Enterprise 249000 minor-unit boundaries. The container, volume, temporary credentials, and internal network are removed on every exit; the encrypted backup and checksum-bound manifest remain outside the checkout.

Immediately before live migration, exact API, worker, and scheduler image IDs and restart counters are recorded along with schema, commercial-plan, migration-ledger, and migration-snapshot hashes. Only migrations absent from the checksum ledger run. On failure, the three exact prior image IDs are restored first, then only migrations attempted by this release are taken down in reverse order. The complete database state hashes and service image IDs are compared afterward. Any rollback or verification error exits 90 with `EMERGENCY_ROLLBACK_VERIFICATION_FAILED`; external submission stays disabled. The rollout never restores the backup over the live database automatically.

## Authenticated live probe limitation

A production write fixture is deliberately not created: the current schema has no independently proven production-only fixture partition that can guarantee every trigger, worker, and future cleanup path remains confined to synthetic rows. The full password login, MFA, same-navigation `returnTo`, browser/API workflows, tenant/RBAC isolation, pricing boundaries, WIKOS read-only contract, HTTP 423, and exact-ID cleanup run against the isolated restored backup during release rehearsal.

The live gate therefore requires a short-lived, pre-created root-owned curl config at `PRODUCTION_SESSION_FILE` with exactly two lines and no other curl directives:

```text
cookie = "wb_session=<opaque>; wb_csrf=<opaque>"
header = "x-csrf-token: <opaque>"
```

It performs a real HTTPS health request and an authenticated POST with no request payload to `/api/tools/action/transmit`. The expected response is HTTP 423 with both safety booleans false. Revoke the session immediately after the operator-reviewed rollout. This live probe cannot independently repeat password entry, MFA enrollment/entry, tenant/RBAC mutations, plan-limit writes, WIKOS access, or synthetic cleanup; those remain hard-bound to the approved isolated rehearsal evidence.
