#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${REHEARSAL_DATABASE_TRUSTED:-false}" == true ]] || { echo "prerequisite verification is restricted to the trusted isolated rehearsal database" >&2; exit 64; }
database=(-h db -U postgres -d wb_rehearsal)
required_versions=(
  0131-calculation-version-concurrency
  0132-calculation-duplicate-order-repair
  0133-portal-registry-live-redirect-evidence
  0134-runtime-child-scope-rls
  0135-participation-terminal-truth
  0136-portal-human-continuation-truth
  0137-canonical-context-retry
  0138-canonical-technical-retry
  0139-pipeline-repair-continuation-truth
  0140-obsolete-relevance-terminal-truth
  0141-required-office-form-working-copies
  0142-ted-tender-lot-browser-evidence
  0143-authoritative-company-tender-scope
  0144-munich-ai-netserver-public-adapter
  0145-public-document-queue-scope
  0147-public-document-production-validated-scope
  0148-wb-protect-authoritative-scope-profile-activation
  0149-superseded-relevance-context-truth
  0150-eu-etenders-family-adapters
  0151-terminal-deadline-context-truth
  0153-phase2-authoritative-portal-jobs
  0154-phase2-company-scoped-resolver-jobs
)
for version in "${required_versions[@]}"; do
  present=$(psql "${database[@]}" -Atv ON_ERROR_STOP=1 -v version="$version" <<'SQL'
SELECT EXISTS(SELECT 1 FROM app.schema_migrations WHERE version=:'version');
SQL
)
  [[ "$present" == t ]] || { echo "source archive prerequisite missing: $version" >&2; exit 65; }
done
structural=$(psql "${database[@]}" -Atv ON_ERROR_STOP=1 -c "SELECT to_regclass('tender.enrichment_context_bindings_version_manifest_key') IS NOT NULL AND to_regclass('tender.region_evaluations_management_inbox_exact_idx') IS NOT NULL")
[[ "$structural" == t ]] || { echo "source archive structural prerequisites 0146/0152 missing" >&2; exit 65; }
