import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const migration=await readFile(new URL("../migrations/158_owner_mfa_challenge_contract.sql",import.meta.url),"utf8");
const rollback=await readFile(new URL("../migrations/158_owner_mfa_challenge_contract.down.sql",import.meta.url),"utf8");

test("migration 158 installs the exact bounded owner MFA challenge contract",()=>{
  assert.match(migration,/CREATE TABLE IF NOT EXISTS iam\.login_challenges/);
  for(const column of ["challenge_hash","user_id","user_agent_hash","network_hash","mfa_setup_secret_encrypted","attempts","created_at","expires_at","used_at"])
    assert.match(migration,new RegExp(`\\b${column}\\b`));
  assert.match(migration,/CHECK\(attempts BETWEEN 0 AND 8\)/);
  assert.match(migration,/WHERE used_at IS NULL/);
  assert.match(migration,/0158-owner-mfa-challenge-contract/);
});

test("migration 158 never rewrites existing identities, credentials or sessions",()=>{
  assert.match(migration,/existingUsersChanged',false/);
  assert.match(migration,/existingPasswordsChanged',false/);
  assert.match(migration,/existingMfaSecretsChanged',false/);
  assert.match(migration,/existingSessionsChanged',false/);
  assert.doesNotMatch(migration,/(?:UPDATE|DELETE FROM) iam\.(?:users|sessions|password_reset_tokens|recovery_codes)/);
});

test("application rollback preserves challenge and identity evidence",()=>{
  assert.match(rollback,/challengeTableRetained',true/);
  assert.match(rollback,/challengeRowsDeleted',false/);
  assert.doesNotMatch(rollback,/DROP (?:TABLE|COLUMN|CONSTRAINT|INDEX)/);
  assert.doesNotMatch(rollback,/(?:UPDATE|DELETE FROM) iam\./);
});
