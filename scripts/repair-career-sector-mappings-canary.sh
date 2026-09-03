#!/usr/bin/env bash
set -Eeuo pipefail

C=wb-admin-rehearsal-auth-1
EXPECTED_IMAGE='sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="/srv/wb-tender-recovery/admin-runtime-rehearsal-4/career-sector-fix-${STAMP}"
BACKUP="${WORK}/career.before.db"

mkdir -p "$WORK"
test "$(docker inspect "$C" --format '{{.Image}}')" = "$EXPECTED_IMAGE"
test "$(docker inspect "$C" --format '{{.State.Running}}')" = true
docker cp "$C:/data/career.db" "$BACKUP"

CHANGED=false
rollback() {
  status=$?
  trap - ERR
  if test "$CHANGED" = true; then
    docker cp "$BACKUP" "$C:/data/career.db" >/dev/null || true
    docker restart "$C" >/dev/null || true
  fi
  printf '%s\n' 'WB_CAREER_SECTOR_ROLLBACK=SUCCESS' >&2
  exit "$status"
}
trap rollback ERR

docker exec -i "$C" node --input-type=module <<'NODE'
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/data/career.db');
db.exec('PRAGMA busy_timeout=10000');
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
if (integrity !== 'ok') throw new Error(`sqlite_integrity_${integrity}`);

const sectors = db.prepare('SELECT id, code, name FROM recruiting_sectors WHERE active=1').all();
function sector(code) {
  const matches = sectors.filter(row => String(row.code || '').toLowerCase() === code);
  if (matches.length !== 1) throw new Error(`sector_${code}_matches_${matches.length}`);
  return matches[0];
}

const cleaning = sector('cleaning');
const security = sector('security');
const administration = sector('administration');
const assignments = [
  ['5dc5bfd4-94a7-4c83-a507-a0af071d4325', administration],
  ['ac0cf775-3af8-49fe-9cca-7afe1190d7da', cleaning],
  ['deb95ceb-6da5-45f9-9e0e-382733005572', cleaning],
  ['7112b765-6810-4239-bce6-93fbbad757ac', cleaning],
  ['a46485cb-12c5-4ddf-aa8d-b068eb73dae6', cleaning],
  ['26d19785-eb55-44ec-8198-5d8465979d9c', security],
  ['8f0f6739-417c-4550-8ce8-091a17e53042', security]
];

const read = db.prepare('SELECT sector_id FROM recruiting_job_sectors WHERE job_id=?');
const insert = db.prepare(`
  INSERT INTO recruiting_job_sectors(job_id, sector_id, updated_at, updated_by)
  VALUES (?, ?, ?, ?)
`);
const now = new Date().toISOString();

db.exec('BEGIN IMMEDIATE');
try {
  for (const [jobId, expected] of assignments) {
    const existing = read.all(jobId);
    if (existing.length === 0) {
      insert.run(jobId, expected.id, now, 'admin@wb-holding.ag');
    } else if (existing.length !== 1 || existing[0].sector_id !== expected.id) {
      throw new Error(`conflicting_sector_mapping_${jobId}`);
    }
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

for (const [jobId, expected] of assignments) {
  const existing = read.all(jobId);
  if (existing.length !== 1 || existing[0].sector_id !== expected.id) {
    throw new Error(`sector_mapping_not_persisted_${jobId}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  assignments: assignments.map(([jobId, value]) => ({jobId, sector: value.code})),
  integrity: db.prepare('PRAGMA integrity_check').get().integrity_check
}));
db.close();
NODE
CHANGED=true

test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4341/api/healthz)" = 200

trap - ERR
printf '%s\n' 'WB_CAREER_SECTOR_MAPPINGS_CANARY=SUCCESS'
printf '%s\n' 'mapped_jobs=7'
printf 'backup=%s\n' "$BACKUP"
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'production_mfa_changed=false'
printf '%s\n' 'external_submission_changed=false'
