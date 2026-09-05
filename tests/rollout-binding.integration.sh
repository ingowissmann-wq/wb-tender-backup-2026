#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
project=$(git rev-parse --show-toplevel)
temporary=$(mktemp -d /tmp/wb-binding-integration.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
repo="$temporary/repo" artifacts="$temporary/artifacts"
mkdir "$repo" "$artifacts"
git -C "$repo" init -q
git -C "$repo" config user.email rollout-test@example.invalid
git -C "$repo" config user.name 'Rollout Test'
printf 'exact tree\n' >"$repo/tracked"
git -C "$repo" add tracked
git -C "$repo" commit -qm fixture
commit=$(git -C "$repo" rev-parse HEAD)
tree=$(git -C "$repo" rev-parse HEAD^{tree})
image_id="sha256:$(printf 'b%.0s' {1..64})"
image_digest="sha256:$(printf 'c%.0s' {1..64})"
release_image="registry.example.invalid/wb@$image_digest"
evidence="$artifacts/evidence" approval="$artifacts/approval"
{
  printf 'EVIDENCE_VERSION=1\nSOURCE_COMMIT=%s\nSOURCE_TREE=%s\nRELEASE_IMAGE_ID=%s\nRELEASE_IMAGE_DIGEST=%s\n' "$commit" "$tree" "$image_id" "$image_digest"
  printf 'SOURCE_DUMP_SHA256=%064d\nWIKOS_EVIDENCE_SHA256=%064d\nRESULT=PASS\nPLAN_ROWS_SHA256=%064d\nIAM_ROWS_SHA256=%064d\n' 0 0 0 0
  printf 'FIXTURE_NAMESPACE=WB_RELEASE_REHEARSAL_INTEGRATION\nFIXTURE_CLEANUP_ABSENCE=PASS\nTENANT_ISOLATION=PASS\nRBAC_ISOLATION=PASS\nBROWSER_PASSWORD_MFA_RETURNTO=PASS\nDOCUMENT_WORKFLOW=PASS\nCALCULATION_WORKFLOW=PASS\nMANAGEMENT_WORKFLOW=PASS\nTASK_WORKFLOW=PASS\nREMINDER_WORKFLOW=PASS\nHTTP423=PASS\nWIKOS_REAL=PASS\nWIKOS_STUB_COMPONENT=PASS\nSAME_IMAGE_API_WORKER_SCHEDULER=PASS\nSCHEDULER=PASS\nROLLBACK=PASS\nEXTERNAL_SUBMISSION=false\n'
} >"$evidence"
evidence_sha=$(sha256sum "$evidence" | cut -d' ' -f1)
printf 'APPROVAL_VERSION=1\nAPPROVE_COMMIT=%s\nAPPROVE_TREE=%s\nAPPROVE_IMAGE_DIGEST=%s\nAPPROVE_EVIDENCE_SHA256=%s\nEXTERNAL_SUBMISSION_ENABLED=false\n' "$commit" "$tree" "$image_digest" "$evidence_sha" >"$approval"
for file in database key; do printf 'file-only\n' >"$artifacts/$file"; done
printf 'cookie = "wb_session=%064d; wb_csrf=%064d"\nheader = "x-csrf-token: %064d"\n' 0 0 0 >"$artifacts/session"
export EXPECTED_COMMIT="$commit" EXPECTED_TREE="$tree" EXPECTED_RELEASE_IMAGE_ID="$image_id" EXPECTED_RELEASE_IMAGE_DIGEST="$image_digest" EXPECTED_EVIDENCE_SHA256="$evidence_sha"
export RELEASE_IMAGE="$release_image" REHEARSAL_EVIDENCE="$evidence" OPERATOR_APPROVAL="$approval" DATABASE_URL_FILE="$artifacts/database" BACKUP_ENCRYPTION_KEY_FILE="$artifacts/key" PRODUCTION_SESSION_FILE="$artifacts/session"
export ACTUAL_COMMIT="$commit" ACTUAL_TREE="$tree" CHECKOUT_CLEAN=true ACTUAL_RELEASE_IMAGE_ID="$image_id" ACTUAL_RELEASE_IMAGE_REVISION="$commit" ACTUAL_RELEASE_IMAGE_TREE="$tree"
node "$project/scripts/verify-rollout-binding.mjs" | grep -q '"passed":true'
PRODUCTION_SESSION_FILE= VERIFY_ROLLOUT_BINDING_PHASE=pre-canary node "$project/scripts/verify-rollout-binding.mjs" | grep -q '"canarySessionBound":false'
sed -i 's/RESULT=PASS/RESULT=FAIL/' "$evidence"
set +e
tamper_output=$(node "$project/scripts/verify-rollout-binding.mjs" 2>&1)
tamper_status=$?
set -e
[[ "$tamper_status" -ne 0 && "$tamper_output" == *"evidence sha256 mismatch"* ]]
sed -i 's/RESULT=FAIL/RESULT=PASS/' "$evidence"
chmod 0640 "$artifacts/session"
set +e
mode_output=$(node "$project/scripts/verify-rollout-binding.mjs" 2>&1)
mode_status=$?
set -e
[[ "$mode_status" -ne 0 && "$mode_output" == *"0600 or stricter"* ]]
chmod 0600 "$artifacts/session"
set +e
inline_output=$(DATABASE_URL=forbidden-inline node "$project/scripts/verify-rollout-binding.mjs" 2>&1)
inline_status=$?
set -e
[[ "$inline_status" -eq 64 && "$inline_output" == *"inline secret is forbidden"* ]]
printf '{"passed":true,"actualValidatorExecuted":true,"exactBindingAccepted":true,"evidenceTamperRejected":true,"permissiveSecretModeRejected":true,"inlineSecretRejected":true}\n'
