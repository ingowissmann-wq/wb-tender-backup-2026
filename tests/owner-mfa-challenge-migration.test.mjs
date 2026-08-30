import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const [migration,rollback,runtimeGrants,runtimeGrantsRollback]=await Promise.all([
  readFile(new URL("../migrations/158_owner_mfa_challenge_contract.sql",import.meta.url),"utf8"),
  readFile(new URL("../migrations/158_owner_mfa_challenge_contract.down.sql",import.meta.url),"utf8"),
  readFile(new URL("../migrations/159_owner_auth_runtime_privileges.sql",import.meta.url),"utf8"),
  readFile(new URL("../migrations/159_owner_auth_runtime_privileges.down.sql",import.meta.url),"utf8"),
]);

test("migration 158 installs the exact bounded owner MFA challenge contract",()=>{
  assert.match(migration,/CREATE TABLE IF NOT EXISTS iam\.login_challenges/);
  for(const column of ["challenge_hash","user_id","user_agent_hash","network_hash","mfa_setup_secret_encrypted","attempts","created_at","expires_at","used_at"])
    assert.match(migration,new RegExp(`\\b${column}\\b`));
  assert.match(migration,/CHECK\(attempts BETWEEN 0 AND 8\)/);
  assert.match(migration,/WHERE used_at IS NULL/);
  assert.match(migration,/0158-owner-mfa-challenge-contract/);
  assert.match(runtimeGrants,/rolcanlogin OR rolsuper OR rolbypassrls/);
  assert.match(runtimeGrants,/GRANT SELECT ON[\s\S]*iam\.login_attempts[\s\S]*iam\.login_challenges[\s\S]*iam\.recovery_codes[\s\S]*iam\.sessions[\s\S]*TO tender_api_runtime/);
  assert.match(runtimeGrants,/GRANT INSERT ON[\s\S]*iam\.password_reset_events[\s\S]*iam\.login_attempts[\s\S]*iam\.login_challenges[\s\S]*iam\.recovery_codes[\s\S]*iam\.sessions[\s\S]*TO tender_api_runtime/);
  assert.match(runtimeGrants,/GRANT UPDATE\(password_hash,mfa_required,mfa_secret_encrypted,mfa_last_counter,failed_attempts,locked_until,updated_at\)[\s\S]*ON iam\.users TO tender_api_runtime/);
  assert.match(runtimeGrants,/GRANT UPDATE\(attempts,used_at\)[\s\S]*ON iam\.login_challenges TO tender_api_runtime/);
  assert.match(runtimeGrants,/GRANT UPDATE\(revoked_at\)[\s\S]*ON iam\.sessions TO tender_api_runtime/);
  assert.match(runtimeGrants,/GRANT USAGE, SELECT ON SEQUENCE/);
  assert.match(runtimeGrants,/0159-owner-auth-runtime-privileges/);
  assert.doesNotMatch(runtimeGrants,/TO wb_tender_api_login|GRANT (?:ALL|ALL PRIVILEGES)/);
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
  assert.match(runtimeGrantsRollback,/runtimePrivilegesRetained',true/);
  assert.doesNotMatch(runtimeGrantsRollback,/REVOKE|DROP (?:TABLE|COLUMN|CONSTRAINT|INDEX)/);
  assert.doesNotMatch(runtimeGrantsRollback,/(?:UPDATE|DELETE FROM) iam\./);
});
