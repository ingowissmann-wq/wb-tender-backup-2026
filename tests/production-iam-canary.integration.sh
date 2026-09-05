#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=$(git rev-parse --show-toplevel)
temporary=$(mktemp -d /tmp/wb-iam-canary-integration.XXXXXX)
container="wb-iam-canary-test-$(openssl rand -hex 6)"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
}
trap cleanup EXIT

docker run -d --name "$container" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:16.10-alpine >/dev/null
for _ in {1..60}; do docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL' >/dev/null
CREATE EXTENSION pgcrypto;
CREATE SCHEMA iam;
CREATE SCHEMA tender;
CREATE TABLE iam.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text UNIQUE NOT NULL,password_hash text NOT NULL,active boolean NOT NULL,mfa_required boolean NOT NULL,mfa_secret_encrypted text,failed_attempts integer NOT NULL DEFAULT 0,mfa_last_counter bigint,locked_until timestamptz);
CREATE TABLE iam.roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text UNIQUE NOT NULL,label text NOT NULL);
CREATE TABLE iam.permissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text UNIQUE NOT NULL);
CREATE TABLE iam.user_roles(user_id uuid NOT NULL REFERENCES iam.users(id),role_id uuid NOT NULL REFERENCES iam.roles(id),PRIMARY KEY(user_id,role_id));
CREATE TABLE iam.role_permissions(role_id uuid NOT NULL REFERENCES iam.roles(id),permission_id uuid NOT NULL REFERENCES iam.permissions(id),PRIMARY KEY(role_id,permission_id));
CREATE TABLE iam.sessions(id_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES iam.users(id),csrf_hash text NOT NULL,ip_prefix_hash text NOT NULL,user_agent_hash text NOT NULL,mfa_verified_at timestamptz,expires_at timestamptz NOT NULL,revoked_at timestamptz);
CREATE TABLE iam.login_attempts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,account_hash text NOT NULL,network_hash text NOT NULL,success boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE iam.tender_identity_scopes(user_id uuid NOT NULL REFERENCES iam.users(id),scope_type text NOT NULL,scope_id uuid NOT NULL,active boolean NOT NULL);
CREATE TABLE iam.tender_login_challenges(challenge_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,user_agent_hash text NOT NULL,network_hash text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tender.enterprise_company_links(company_id uuid PRIMARY KEY,active boolean NOT NULL);
CREATE TABLE test_session_revocations(user_id uuid PRIMARY KEY);
CREATE FUNCTION record_test_revocation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN INSERT INTO test_session_revocations VALUES(NEW.user_id); END IF; RETURN NEW; END$$;
CREATE TRIGGER record_test_revocation BEFORE UPDATE ON iam.sessions FOR EACH ROW EXECUTE FUNCTION record_test_revocation();
INSERT INTO iam.permissions(code) VALUES('tender.submission.approve');
SQL

port=$(docker port "$container" 5432/tcp | sed 's/.*://')
printf 'postgresql://postgres@127.0.0.1:%s/postgres\n' "$port" >"$temporary/database-url"
openssl rand -base64 48 >"$temporary/session-pepper"
openssl rand -hex 32 >"$temporary/field-key"
chmod 0600 "$temporary/database-url" "$temporary/session-pepper" "$temporary/field-key"
export DATABASE_URL_FILE="$temporary/database-url" SESSION_PEPPER_FILE="$temporary/session-pepper" FIELD_ENCRYPTION_KEY_FILE="$temporary/field-key"
export PRODUCTION_CANARY_STATE_DIR="$temporary/state"

node "$root/scripts/production-iam-canary.mjs" dry-run >/dev/null
node "$root/scripts/production-iam-canary.mjs" prepare >/dev/null
[[ $(stat -c '%a:%u' "$temporary/state") == "700:0" ]]
for file in manifest.json email password totp curl.config; do [[ $(stat -c '%a:%u' "$temporary/state/$file") == "600:0" ]]; done
[[ $(wc -l <"$temporary/state/curl.config") -eq 2 ]]
grep -Eq '^cookie = "wb_session=[A-Za-z0-9_-]+; wb_csrf=[A-Za-z0-9_-]+"$' "$temporary/state/curl.config"
grep -Eq '^header = "x-csrf-token: [A-Za-z0-9_-]+"$' "$temporary/state/curl.config"

user_id=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).userId)' "$temporary/state/manifest.json")
account_hash=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).accountHash)' "$temporary/state/manifest.json")
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -v user_id="$user_id" -v account_hash="$account_hash" <<'SQL' >/dev/null
INSERT INTO iam.tender_login_challenges(challenge_hash,user_id,user_agent_hash,network_hash,expires_at) VALUES(repeat('c',64),:'user_id','browser','network',now()+interval '5 minutes');
INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES(:'account_hash','network',true);
SQL

node "$root/scripts/production-iam-canary.mjs" cleanup >/dev/null
node "$root/scripts/production-iam-canary.mjs" verify-absence >/dev/null
[[ -f "$temporary/state/manifest.json" && ! -e "$temporary/state/email" && ! -e "$temporary/state/password" && ! -e "$temporary/state/totp" && ! -e "$temporary/state/curl.config" ]]
[[ $(docker exec "$container" psql -U postgres -d postgres -Atc 'SELECT count(*) FROM test_session_revocations') == 1 ]]
[[ $(docker exec "$container" psql -U postgres -d postgres -Atc "SELECT (SELECT count(*) FROM iam.users)+(SELECT count(*) FROM iam.roles)+(SELECT count(*) FROM iam.user_roles)+(SELECT count(*) FROM iam.role_permissions)+(SELECT count(*) FROM iam.sessions)+(SELECT count(*) FROM iam.login_attempts)+(SELECT count(*) FROM iam.tender_login_challenges)") == 0 ]]
printf '{"passed":true,"realPostgreSQL":true,"prepare":true,"sessionRevoked":true,"fkSafeCleanup":true,"postCleanupAbsence":true,"secretFilesShredded":true}\n'
