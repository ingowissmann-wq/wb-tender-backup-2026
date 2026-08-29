# WB Tender safety-repair runbook

This runbook defines the release gates for the reconstructed WB Tender source. It does not authorize a production deployment or an external portal write.

## Immutable safety boundary

- `EXTERNAL_SUBMISSION_ENABLED=false` and `WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false` are mandatory.
- The API must retain the HTTP 423 `external_submission_disabled` response.
- No migration in this repair may delete tender, document, calculation, configuration, credential, audit, or submission evidence.
- Credentials, keys, certificates, and database URLs are supplied only through the configured secret files or environment sources; they are never part of the release artifact.
- Portal validation and submission-adapter tests are non-transmitting simulations.

## Required source gates

Run from the repository root with installed, lockfile-resolved dependencies:

1. `npm test`
2. `npm run gate`
3. `npm run verify:artifact`
4. `npm run sbom`

`npm run gate` intentionally requires a local Chromium executable. A missing browser is a failed gate, not a permitted skip. The authenticated production browser acceptance is a separate post-candidate gate.

## Database rehearsal

Use only a verified isolated restore. Confirm the database, schema migration ledger, forced RLS state, exact tenant/company/service/profile scopes, calculation history, and queue state before applying a candidate migration. Apply migrations by their full ledger version, not by the numeric filename prefix alone. Duplicate numeric prefixes exist in the recovered history.

Every rehearsal must record:

- source commit and candidate digest;
- database backup timestamp and restore-verifier result;
- exact migration ledger before and after;
- up-migration and rollback results;
- row-count and RLS invariants;
- external receipt counts and submission safety state.

## Candidate and cutover gates

Build API, worker, and scheduler from the same committed source tree. Verify their source revision and image digest. Run unit, integration, RLS, API, worker, and browser tests against the isolated candidate. Keep the last verified rollback image and database backup.

Production cutover is permitted only after the candidate passes all gates and an explicit deployment decision. Monitor health, queues, logs, portal states, document processing, calculation states, and external-receipt invariants for at least 15 minutes. A failed invariant requires rollback; it never authorizes a direct container-file hotfix.

## Backup gate

The daily encrypted backup is complete only when its service succeeds, checksums validate, and `scripts/tender-restore-verify.sh` restores the archive in an isolated container with `rlsMissing=0`. Timer activity alone is not proof of a successful backup.
