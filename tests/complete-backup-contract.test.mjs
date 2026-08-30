import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("complete backup keeps application and secret payloads cryptographically separate", async () => {
  const backup = await source("scripts/tender-encrypted-backup.sh");
  assert.match(backup, /PACKAGE_VERSION=wb-tender-complete-backup\/2/);
  assert.match(backup, /application_archive="\$target\/application\.tar\.zst\.enc"/);
  assert.match(backup, /secrets_archive="\$target\/secrets\.tar\.zst\.enc"/);
  assert.match(backup, /git -C "\$SOURCE_REPOSITORY" archive/);
  assert.match(backup, /container-images\.tsv/);
  assert.match(backup, /compose_sha256/);
  assert.match(backup, /data\/career\.db/);
  assert.match(backup, /secret_paths=\(secrets\)/);
  assert.match(backup, /choose exactly one database source/);
  assert.match(backup, /docker exec "\$DATABASE_CONTAINER"/);
  assert.match(backup, /DATABASE_URL_FILE or DATABASE_CONTAINER is required/);
  assert.match(backup, /SHA256SUMS\.enc/);
  assert.doesNotMatch(backup, /data\/postgres["']/);
  assert.doesNotMatch(backup, /postgres-failed-init/);
});

test("complete restore validates every payload before isolated database restore", async () => {
  const restore = await source("scripts/tender-restore-verify.sh");
  assert.match(restore, /SHA256SUMS\.enc/);
  assert.match(restore, /sha256sum -c "\$package_stage\/SHA256SUMS"/);
  assert.match(restore, /application\.tar\.zst\.enc/);
  assert.match(restore, /secrets\.tar\.zst\.enc/);
  assert.match(restore, /test ! -e .*production\/secrets/);
  assert.match(restore, /application\.members/);
  assert.match(restore, /secrets\.members/);
  assert.match(restore, /source\/source\.tar\.zst/);
  assert.match(restore, /--exit-on-error/);
  assert.match(restore, /EXPECTED_TENDERS/);
  assert.match(restore, /EXPECTED_DOCUMENTS/);
  assert.match(restore, /EXPECTED_PACKAGES/);
  assert.match(restore, /rlsMissing/);
});

test("backup and restore shell contracts are syntactically valid", () => {
  for (const script of ["scripts/tender-encrypted-backup.sh", "scripts/tender-restore-verify.sh"]) {
    const result = spawnSync("bash", ["-n", fileURLToPath(new URL(`../${script}`, import.meta.url))], { encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test("systemd contract schedules only the versioned complete-package implementation", async () => {
  const [service, timer] = await Promise.all([
    source("deployment/wb-tender-backup.service"),
    source("deployment/wb-tender-backup.timer"),
  ]);
  assert.match(service, /wb-tender-backup-v2\/backup\.env/);
  assert.match(service, /wb-tender-backup-v2\/tender-encrypted-backup\.sh/);
  assert.match(timer, /OnCalendar=\*-\*-\* 02:15:00 UTC/);
  assert.match(timer, /Persistent=true/);
});
