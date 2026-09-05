# Production rollout hard gates

`deployment/production-rollout.sh` is an operator-run, fail-closed release primitive. It does not submit or enable external tender actions. The operator must keep both `EXTERNAL_SUBMISSION_ENABLED` and `WB_TENDER_ALLOW_EXTERNAL_SUBMISSION` false; the script exports those values itself and the HTTP gate proves the authenticated transmit endpoint returns HTTP 423 with `external_submission_enabled=false` and `transmitted=false`.

## Immutable inputs

The checkout must be clean and exactly match `EXPECTED_COMMIT` and `EXPECTED_TREE`. `RELEASE_IMAGE`, `POSTGRES_IMAGE`, and `PRODUCTION_BROWSER_IMAGE` must be registry-digest references. The release image ID must equal `EXPECTED_RELEASE_IMAGE_ID`, and its OCI `org.opencontainers.image.revision` and `org.opencontainers.image.source-tree` labels must equal the approved commit and tree. The browser image must be the reviewed Playwright runtime used by rehearsal and must already be present locally by its exact digest.

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

All database URLs, encryption keys, cookies, CSRF values, passwords, keys, tokens, and session material are file inputs with mode 0600 or stricter. Known inline secret variables are rejected. The database/key/session file paths are supplied through `DATABASE_URL_FILE`, `SESSION_PEPPER_FILE`, `FIELD_ENCRYPTION_KEY_FILE`, `BACKUP_ENCRYPTION_KEY_FILE`, and `PRODUCTION_SESSION_FILE`.

## Backup, restore, and rollback

Before touching the live schema, the rollout creates a new encrypted custom-format logical dump with the existing file-based key. It verifies the ciphertext checksum, decrypts and verifies the plaintext checksum, and reads the `pg_restore` catalog. That exact new ciphertext is then restored into a temporary PostgreSQL container attached only to a newly created Docker `--internal` network. Only missing release migrations are applied there, followed by the real tenant and admin database isolation programs and exact server-side Pro 99000, Business 149000, and Enterprise 249000 minor-unit boundaries. The container, volume, temporary credentials, and internal network are removed on every exit; the encrypted backup and checksum-bound manifest remain outside the checkout.

Immediately before live migration, exact API, worker, and scheduler image IDs, commands, and restart counters are recorded along with schema, commercial-plan, migration-ledger, and migration-snapshot hashes. Only migrations absent from the checksum ledger run. On failure, API, Worker, and Scheduler are stopped; sessions belonging exactly to `wb_tender_api_login` in the current database are terminated and verified absent; and only migrations attempted by this release are taken down in reverse order. The three exact prior image-and-command pairs are restored only after that reverse-migration attempt, preventing runtime transactions from blocking concurrent index rollback and preventing a candidate command from being combined with a prior image. The complete database state hashes and service image-and-command pairs are compared afterward. Any rollback or verification error exits 90 with `EMERGENCY_ROLLBACK_VERIFICATION_FAILED`; external submission stays disabled. The rollout never restores the backup over the live database automatically.

## Tender proxy and login contract

Tender does not own `/admin/` or `/admin/login`; those remain WB Admin routes. Its configured public UI root is `TENDER_UI_BASE` (production and rehearsal: `/admin/ausschreibungen`) and its login is `${TENDER_UI_BASE}/login`. Browser authentication uses `${TENDER_API_BASE}/iam/login` and `${TENDER_API_BASE}/iam/mfa` (production: `/api/tender`; rehearsal: `/api`). Any malformed base path aborts startup.

Production Nginx strips `/admin/ausschreibungen` to the Tender application's root and `/api/tender` to the application's `/api` subtree. Rehearsal forwards `/api` unstripped and its TLS proxy strips the configured UI root. The application registers the stripped auth routes and the exact configured direct routes so a proxy mismatch does not silently turn the login into a WB Admin request. The executable Fastify contract covers both forms, and Chromium records the exact configured authentication request paths.

The production wrapper and rollout bind `TENDER_API_BASE` to `/api/tender` and reject any conflicting value. The public live gate validates `PRODUCTION_BASE_URL` as an HTTPS origin only, then uses that same configured Tender API base for both `${TENDER_API_BASE}/healthz` and the authenticated, payload-free `${TENDER_API_BASE}/tools/action/transmit` lock probe. Rehearsal remains independently bound to its unstripped `/api` base.

## Two-stage production IAM proof

The production canary is deliberately IAM-only. It creates one unique synthetic `iam.users` row, one dedicated role, the minimum `tender.submission.approve` role binding, one short-lived session, and—only if explicitly requested—one identity scope referencing an existing company selected read-only. It never inserts or modifies tenant, tender, document, task, pricing, submission, receipt, or other business-workflow rows. Password, TOTP, session, and CSRF material is random, file-only, root-owned mode 0600, and never printed. Existing users and credentials are neither selected for impersonation nor changed.

Run the wrapper as root with a new absolute `PRODUCTION_CANARY_STATE_DIR` outside the checkout and the normal file-based rollout inputs:

```sh
deployment/production-rollout-with-iam-canary.sh
```

The wrapper binds `PRODUCTION_SESSION_FILE` to the future two-line `curl.config`. Before backup, the rollout verifies every immutable checkout/image/evidence/approval binding in `pre-canary` mode; that mode defers only the not-yet-created session file. It then creates and proves the encrypted backup and isolated restore while no canary row exists. Next it executes `dry-run` and `prepare`, followed immediately by the complete binding verification—including the generated session file—and migration. Do not pre-create the state directory and do not substitute a human session. `scripts/verify-rollout-binding.mjs` independently rejects a permissive, non-root, symlinked, malformed, or non-two-line session file.

The stage-one session is prepared before migration/cutover without requiring `iam.tender_login_challenges`, which migration 157 has not created yet. Immediately after cutover it is used only for the authenticated, payload-free public HTTP 423 probe.

Stage two occurs immediately after migration 157 and candidate cutover, while automatic rollback is still armed: real Chromium in the digest-pinned `PRODUCTION_BROWSER_IMAGE` opens `${TENDER_UI_BASE}/login` on `PRODUCTION_BASE_URL`, performs password → MFA → same-navigation `returnTo` without a reload, verifies the two authentication requests used `${TENDER_API_BASE}/iam/*`, and performs only an authenticated health read. The browser container receives the clean checkout and canary directory as read-only mounts, has all Linux capabilities dropped, and receives no business-action payload. This avoids host-browser drift while preserving the same reviewed browser runtime as rehearsal. Any failure enters the existing exact-image/reverse-migration rollback.

The stage-one curl config has exactly two lines and no other curl directives:

```text
cookie = "wb_session=<opaque>; wb_csrf=<opaque>"
header = "x-csrf-token: <opaque>"
```

After the browser proof, cleanup first revokes the canary session in its own transaction, then removes challenge, login-attempt, scope, session, role binding, role, and user rows in FK-safe order in a second transaction. It proves exact-ID/marker absence, overwrites and removes the password/TOTP/curl files, and retains only the root-only manifest updated with the cleanup proof. Cleanup and `verify-absence` also run on rollback and from the wrapper's exit trap; a cleanup failure is an emergency failure, never a successful rollout.

The full tenant/RBAC, pricing, WIKOS, and business-workflow proofs remain confined to the isolated restored-backup rehearsal. External tender submission remains hard disabled throughout; neither canary stage supplies an external-action payload.
