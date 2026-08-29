import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("../scripts/isolated-c23-approved-scope-activation.sh", import.meta.url), "utf8");

test("approved C23 activation is bound to the isolated restore database and exact business value", () => {
  assert.match(script, /database=\$\{RESTORE_DATABASE:-wb_platform_restore\}/);
  assert.match(script, /test "\$database" = wb_platform_restore/);
  assert.match(script, /current_database\(\)<>'wb_platform_restore'/);
  assert.match(script, /approved_value=1670/);
  assert.match(script, /approved_unit=HOURS_PER_YEAR/);
  assert.match(script, /approved_scopes=6/);
});

test("approved C23 activation fails closed on scope, actor, migration and prior-state drift", () => {
  assert.match(script, /active configuration scopes differ from the six approved scopes/);
  assert.match(script, /tender\.config\.self_approve_activate/);
  assert.match(script, /migration 155 candidate state is absent/);
  assert.match(script, /required SHA-256 digest function is absent/);
  assert.match(script, /refusing partial or conflicting C23 state/);
  assert.match(script, /C23_active_state_must_be_empty/);
});

test("approved C23 activation uses the historically proven MFA board identity", () => {
  assert.match(script, /approval_actor_id=fe93f980-5699-44f4-ad41-69d254dcaa9f/);
  assert.match(script, /approval_actor_email=admin@wb-holding\.ag/);
  assert.match(script, /user_row\.mfa_required=true/);
  assert.match(script, /role_row\.code='board'/);
  assert.match(script, /audit\.action='BOARD_SELF_APPROVED'/);
  assert.doesNotMatch(script, /admin@wb-tender\.de/);
});

test("approved C23 activation preserves protected fingerprints and records approval provenance", () => {
  assert.match(script, /protected_fingerprint/);
  assert.match(script, /BOARD_SELF_APPROVED/);
  assert.match(script, /Vorstandsfreigabe Dr\. Ingo Wissmann vom 29\.08\.2026/);
  assert.match(script, /businessApprovalId','WB-C23-1670-20260829/);
  assert.match(script, /configuration audit delta is not \+24/);
  assert.match(script, /rerun is idempotent and made no changes/);
});
