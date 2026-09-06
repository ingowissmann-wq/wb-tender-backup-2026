import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const routes = await readFile(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/155_autopilot_overview_latest_lookup.sql", import.meta.url), "utf8");
const rollout = await readFile(new URL("../deployment/production-rollout.sh", import.meta.url), "utf8");
const productionBrowserRunner = await readFile(new URL("../deployment/run-production-browser-canary.sh", import.meta.url), "utf8");
const runtimeDrain = await readFile(new URL("../deployment/drain-runtime-database-sessions.sh", import.meta.url), "utf8");
const rolloutStateCapture = await readFile(new URL("../deployment/capture-rollout-db-state.sh", import.meta.url), "utf8");
const rolloutGuide = await readFile(new URL("../docs/production-rollout-hard-gates.md", import.meta.url), "utf8");
const backup = await readFile(new URL("../deployment/create-encrypted-production-backup.sh", import.meta.url), "utf8");
const encryptedCatalog = await readFile(new URL("../deployment/lib/encrypted-pg-archive.sh", import.meta.url), "utf8");
const plans = await readFile(new URL("../migrations/156_approved_tender_commercial_plans.sql", import.meta.url), "utf8");
const canary = await readFile(new URL("../scripts/production-iam-canary.mjs", import.meta.url), "utf8");
const browserCanary = await readFile(new URL("../scripts/production-iam-browser-canary.mjs", import.meta.url), "utf8");
const rehearsal = await readFile(new URL("../deployment/rehearse-release.sh", import.meta.url), "utf8");
const rehearsalCompose = await readFile(new URL("../deployment/compose.rehearsal.yml", import.meta.url), "utf8");
const isolatedRestore = await readFile(new URL("../deployment/verify-fresh-backup-restore.sh", import.meta.url), "utf8");
const isolatedRestoreRuntimeRole = await readFile(new URL("../deployment/prepare-isolated-restore-runtime-role.sql", import.meta.url), "utf8");
const rehearsalFixture = await readFile(new URL("../scripts/release-rehearsal-fixture.mjs", import.meta.url), "utf8");
const rollbackRuntimeWriter = new URL("../deployment/write-rollback-runtime-override.mjs", import.meta.url);

test("overview resolves latest rows set-wise before joining", () => {
  assert.match(routes, /selected AS MATERIALIZED/);
  assert.match(routes, /latest_results AS/);
  assert.match(routes, /latest_jobs AS/);
  assert.doesNotMatch(routes.slice(routes.indexOf('"\/api\/autopilot\/navigation\/overview"'), routes.indexOf('"\/api\/autopilot\/navigation\/context')), /LEFT JOIN LATERAL/);
});

test("approved net plans retain server-side tenant limits", () => {
  assert.match(plans, /display_name='Pro'.*recommended_monthly_price_minor=99000/);
  assert.match(plans, /display_name='Business'.*recommended_monthly_price_minor=149000/);
  assert.match(plans, /display_name='Enterprise'.*recommended_monthly_price_minor=249000/);
  assert.doesNotMatch(plans, /INSERT\s+INTO\s+saas\.plans/i);
});

test("overview indexes are additive, online and reversible", () => {
  assert.equal((migration.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g) || []).length, 3);
  assert.doesNotMatch(migration, /\b(?:DELETE|TRUNCATE|UPDATE|ALTER\s+TABLE|DROP)\b/i);
});

test("production rollout is digest-pinned, rehearsed and fail-closed", () => {
  assert.match(rollout, /RELEASE_IMAGE.*@sha256/);
  assert.match(rollout, /ACTUAL_COMMIT=\$\(git rev-parse HEAD\)/);
  assert.match(rollout, /EXPECTED_TREE/);
  assert.match(rollout, /create-encrypted-production-backup\.sh/);
  assert.match(backup, /pg_dump/);
  assert.match(backup, /gpg .*--symmetric/);
  assert.match(backup, /verify_encrypted_pg_archive_catalog/);
  assert.match(encryptedCatalog, /pg_restore -l/);
  assert.match(encryptedCatalog, /Broken pipe/);
  assert.match(backup, /sha256sum/);
  assert.match(rollout, /REHEARSAL_EVIDENCE/);
  assert.match(rollout, /api worker scheduler/);
  assert.match(rollout, /EXTERNAL_SUBMISSION_ENABLED=false/);
  assert.match(rollout, /WB_TENDER_ALLOW_EXTERNAL_SUBMISSION=false/);
  assert.match(rollout, /trap rollback ERR INT TERM/);
  assert.match(productionBrowserRunner, /production-iam-browser-canary\.mjs/);
  assert.match(rollout, /production-iam-canary\.mjs cleanup/);
  assert.match(rollout, /production-iam-canary\.mjs verify-absence/);
  assert.doesNotMatch(rollout, /(?:password|token|secret)=['"][^'"]+['"]/i);
});

test("production host runtime dependencies fail before the expensive backup and restore gates", () => {
  const hostPreflight = rollout.indexOf("HOST_RELEASE_RUNTIME_PRECHECK=PASS");
  const backup = rollout.indexOf("create-encrypted-production-backup.sh");
  assert.ok(hostPreflight > 0 && hostPreflight < backup);
  assert.match(rollout, /await import\('pg'\)/);
  assert.match(rollout, /scripts\/production-iam-canary\.mjs/);
  assert.match(rolloutGuide, /npm ci --omit=dev --audit=false --fund=false/);
});

test("rollback stops services, drains only the runtime role, and restores exact runtime configuration", async () => {
  assert.match(runtimeDrain, /RUNTIME_DATABASE_ROLE:-wb_tender_api_login/);
  assert.match(runtimeDrain, /pg_terminate_backend\(pid\)/);
  assert.match(runtimeDrain, /usename=:'runtime_role'/);
  assert.doesNotMatch(runtimeDrain, /WHERE\s+pid\s*<>\s*pg_backend_pid\(\)\s*;?/);
  const stop = rollout.indexOf('stop -t 30 api worker scheduler');
  const drain = rollout.indexOf('drain-runtime-database-sessions.sh');
  const reverse = rollout.indexOf('rollback-applied-release-migrations.sh');
  const restore = rollout.indexOf('up -d --no-deps --force-recreate api worker scheduler', reverse);
  assert.ok(stop > 0 && stop < drain && drain < reverse && reverse < restore);
  assert.match(rollout, /\.Config\.Cmd/);
  assert.match(rollout, /write-rollback-runtime-override\.mjs/);
  assert.match(rollout, /\.Config\.Env/);
  assert.match(rollout, /exact previous image, command, environment and health/);
  const rehearsalStop = rehearsal.indexOf('stop -t 30 api worker scheduler');
  const rehearsalDrain = rehearsal.indexOf('drain-runtime-database-sessions.sh');
  const rehearsalReverse = rehearsal.indexOf('rollback-probe.sh');
  assert.ok(rehearsalStop > 0 && rehearsalStop < rehearsalDrain && rehearsalDrain < rehearsalReverse);
  assert.match(rolloutGuide, /sessions belonging exactly to `wb_tender_api_login`[\s\S]*reverse order[\s\S]*prior image, command, and environment sets are restored only after/);

  const directory = await mkdtemp(path.join(tmpdir(), "wb-tender-rollback-runtime-"));
  try {
    const commands = {
      api: ["node", "platform/server.mjs"],
      worker: ["node", "platform/autopilot-pipeline-worker.mjs"],
      scheduler: ["node", "platform/source-ingestion.mjs"],
    };
    const candidate = { services: {} };
    for (const [service, command] of Object.entries(commands)) {
      await writeFile(path.join(directory, `${service}.image-id`), `sha256:${service.charCodeAt(0).toString(16).padStart(64, "0")}\n`);
      await writeFile(path.join(directory, `${service}.command.json`), `${JSON.stringify(command)}\n`);
      await writeFile(path.join(directory, `${service}.environment.json`), `${JSON.stringify(["EXTERNAL_SUBMISSION_ENABLED=false", "IAM_FIELD_ENCRYPTION_KEY_FILE=/run/secrets/iam_field_key"])}\n`);
      candidate.services[service] = { image: `sha256:${service.charCodeAt(0).toString(16).padStart(64, "0")}`, environment: { EXTERNAL_SUBMISSION_ENABLED: "false", FIELD_ENCRYPTION_KEY_FILE: "/run/secrets/iam_field_key" } };
    }
    const candidateFile = path.join(directory, "candidate-compose.json");
    await writeFile(candidateFile, `${JSON.stringify(candidate)}\n`);
    const output = path.join(directory, "rollback-runtime.compose.yml");
    const result = spawnSync(process.execPath, [rollbackRuntimeWriter.pathname, directory, output, candidateFile], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const overrideText = await readFile(output, "utf8");
    for (const [service, command] of Object.entries(commands)) {
      assert.match(overrideText, new RegExp(`  ${service}:`));
      assert.match(overrideText, new RegExp(`command: ${JSON.stringify(command).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
    assert.match(overrideText, /"IAM_FIELD_ENCRYPTION_KEY_FILE": "\/run\/secrets\/iam_field_key"/);
    assert.match(overrideText, /"FIELD_ENCRYPTION_KEY_FILE": !reset null/);
    const rendered = spawnSync("docker", ["compose", "-f", candidateFile, "-f", output, "config", "--format", "json"], { encoding: "utf8" });
    assert.equal(rendered.status, 0, rendered.stderr);
    const resolved = JSON.parse(rendered.stdout);
    for (const service of Object.keys(commands)) {
      assert.equal(resolved.services[service].environment.IAM_FIELD_ENCRYPTION_KEY_FILE, "/run/secrets/iam_field_key");
      assert.equal("FIELD_ENCRYPTION_KEY_FILE" in resolved.services[service].environment, false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production state snapshots use the existing restore-admin database client through POSIX sh", () => {
  assert.match(rollout, /ROLLOUT_DATABASE_ADMIN_TRUSTED=true/);
  assert.match(rollout, /db sh -s <deployment\/capture-rollout-db-state\.sh/);
  assert.doesNotMatch(rollout.slice(rollout.indexOf("capture_db_state()"), rollout.indexOf("ledger_existed=")), /DATABASE_URL_FILE/);
  assert.match(rolloutStateCapture, /ROLLOUT_DATABASE_ADMIN_TRUSTED/);
  for (const name of ["PGHOST", "PGUSER", "PGDATABASE", "PGPASSFILE"]) assert.match(rolloutStateCapture, new RegExp(name));
  assert.match(rolloutStateCapture, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(rolloutStateCapture, /\[\[|\]\]|\w+=\(\)|\$\{![^}]+\}|\b(?:declare|local)\b/);
  const syntax = spawnSync("sh", ["-n"], { input: rolloutStateCapture, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("production IAM canary is IAM-only, file-secret-only and revocation-first", () => {
  assert.match(canary, /inline_secret_forbidden/);
  assert.match(canary, /UPDATE iam\.sessions SET revoked_at/);
  assert.match(canary, /DELETE FROM iam\.tender_login_challenges/);
  assert.match(canary, /DELETE FROM iam\.login_attempts/);
  assert.doesNotMatch(canary, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:tender|saas|cms)\./i);
  assert.match(browserCanary, /passwordMfaReturnTo/);
  assert.match(browserCanary, /locator\("#login-form"\)/);
  assert.doesNotMatch(browserCanary, /page\.getByLabel\("E-Mail"\)/);
  assert.match(browserCanary, /businessWrites: 0/);
  assert.match(rollout, /PRODUCTION_BROWSER_IMAGE/);
  assert.match(rollout, /run-production-browser-canary\.sh/);
  assert.doesNotMatch(rollout, /node scripts\/production-iam-browser-canary\.mjs/);
  assert.match(productionBrowserRunner, /PRODUCTION_BROWSER_IMAGE.*@sha256/);
  assert.match(productionBrowserRunner, /--read-only/);
  assert.match(productionBrowserRunner, /--cap-drop ALL/);
  assert.match(productionBrowserRunner, /PRODUCTION_CANARY_STATE_DIR:\/run\/canary:ro/);
  assert.match(productionBrowserRunner, /PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  assert.doesNotMatch(productionBrowserRunner, /(?:password|token|secret)=['"][^'"]+['"]/i);
});

test("rehearsal applies IAM migrations before starting the API as the production-like login", () => {
  const prepare = rehearsal.indexOf("release-rehearsal-fixture.mjs prepare-runtime");
  const migrate = rehearsal.indexOf("deployment/apply-release-migrations.sh");
  assert.ok(prepare > 0 && prepare < migrate, "runtime roles must exist before role-targeted migrations");
  assert.match(rehearsalFixture, /CREATE ROLE tender_api_runtime NOLOGIN/);
  assert.match(rehearsalFixture, /CREATE ROLE wb_tender_api_login LOGIN[^;]*IN ROLE tender_api_runtime/);
  assert.match(rehearsalCompose, /api_runtime_database_url/);
  assert.match(rehearsalCompose, /api:\n[\s\S]*?DATABASE_URL_FILE: \/run\/secrets\/api_runtime_database_url/);
});

test("restore readiness waits for the final PostgreSQL PID 1 instead of the temporary init server", () => {
  assert.match(rehearsal, /\/proc\/1\/comm/);
  assert.match(isolatedRestore, /\/proc\/1\/comm/);
  assert.match(rehearsalCompose, /\/proc\/1\/comm/);
});

test("database-only restore recreates the least-privilege release runtime role before migrations", () => {
  const restore = isolatedRestore.indexOf("pg_restore -U postgres");
  const prepareRole = isolatedRestore.indexOf("prepare-isolated-restore-runtime-role.sql");
  const migrate = isolatedRestore.indexOf('run_tools env RELEASE_ID="$RELEASE_ID" deployment/apply-release-migrations.sh');
  assert.ok(restore >= 0 && restore < prepareRole && prepareRole < migrate);
  assert.match(isolatedRestoreRuntimeRole, /CREATE ROLE tender_api_runtime/);
  assert.match(isolatedRestoreRuntimeRole, /NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOLOGIN/);
  assert.match(isolatedRestoreRuntimeRole, /existing tender_api_runtime role is not least privilege/);
  assert.match(isolatedRestore, /has_table_privilege\('tender_api_runtime','iam\.tender_login_challenges','SELECT,INSERT,DELETE'\)/);
  assert.match(isolatedRestore, /NOT has_table_privilege\('tender_api_runtime','iam\.tender_login_challenges','UPDATE,TRUNCATE,REFERENCES,TRIGGER'\)/);
});

test("isolated restore gates execute the digest-bound release image without masking its runtime dependencies", () => {
  assert.match(isolatedRestore, /docker run --rm --network none --read-only --cap-drop ALL/);
  assert.match(isolatedRestore, /await import\('pg'\)/);
  assert.doesNotMatch(isolatedRestore, /-v "\$repository:\/app:ro"/);
  assert.match(isolatedRestore, /"\$RELEASE_IMAGE" "\$@"/);
});
