# Canonical source reconstruction evidence — 2026-08-29

## Proven identity

- Repository: `https://github.com/ingowissmann-wq/wb-tender-backup-2026.git`
- Productive source label and base revision: `1a12eff67005be271600e1725192ce2db6222522`
- Reconstruction branch: `repair/canonical-source-c23`
- Productive API exception: image `wb-tender:1a12eff-owner-login-20260828` contained the owner-login hotfix; its three runtime files were forensically exported and reconciled into this tree.
- API, worker, and scheduler are reconstructed into one repository-root source tree. `current/` is a retained local staging duplicate and is explicitly ignored.

## Database evidence used

The encrypted backup dated `20260827T022452Z` restored successfully in the isolated PostgreSQL container `wb-tender-restore-verify-20260828T211025Z-db` with:

- database size: 33 GB;
- tenders: 125,535;
- enrichment documents: 26,451;
- bid packages: 7;
- forced-RLS omissions: 0;
- migration ledger rows: 60;
- latest recorded migration: `0154-phase2-company-scoped-resolver-jobs`.

The read-only audit found six exact active company/service/profile scopes. C23 was absent in all six. Historical active C05 values were 13.5 PERCENT for WB-Cleaning and 12.1 PERCENT for WB-Security. Historical calculations contained schema versions 1 and 3 plus blocked/scenario rows without a schema version; no schema version 4 was present.

## Reconstructed behavior and verification

The reconstruction preserves the newer production worker calculation and document pipeline, exact company/lot/portal bindings, forced fail-closed states, server-side tenant enforcement, and the owner-login hotfix. TED parsing again retains procedure ID, lot-bound zoned deadlines, and semantic public-document evidence. Public evidence remains read-only and does not acquire submission semantics.

Verification result at this checkpoint:

- `npm test`: 689 tests, 684 passed, 0 failed, 5 explicitly skipped;
- targeted TED/portal/context regressions: 38 passed, 0 failed;
- release artifact: 141 required files present;
- candidate digest: `c11cb3eba4a2e87b1ff4ab6f882e7ff13f882aa428b6a42e45db074949d1a521` before adding this evidence manifest;
- `git diff --check`: clean;
- static production safety gate: passed.

The local browser release gate is not complete because this Codex runtime has no Chromium executable. That condition remains a blocking gate and was not bypassed.

## Deterministic migration rule

Recovered migrations contain duplicate numeric filename prefixes from different historical release lines. They must never be applied by prefix sorting. `config/canonical-release-20260829.json` is the only migration list for this candidate and binds the full ledger version, path, and SHA-256. It requires ledger head `0154-phase2-company-scoped-resolver-jobs` and contains only the additive C23 sandbox authorization migration 155 plus its isolated rollback.

## Remaining gates

No production migration, cleanup, deployment, credential change, external submission, or price transmission has been performed. Remaining work is: commit and publish the canonical branch, apply and roll back migration 155 in the isolated clone, run C23 shadow calculations against historical and real cases, build a same-source candidate, complete authenticated browser acceptance, cut over only after approval, monitor for at least 15 minutes, and verify the new daily encrypted full-package backup by isolated restore.
