#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE="sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86"
docker image inspect "$IMAGE" >/dev/null

docker run --rm --interactive \
  --network none \
  --user 0 \
  --entrypoint node \
  "$IMAGE" \
  --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const roots = ["/career-data", "/data", "/app", "/opt"];
const databases = [];
const media = [];

function directorySummary(directory) {
  let files = 0;
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        files += 1;
        try { bytes += fs.statSync(full).size; } catch {}
      }
    }
  }
  return { files, bytes };
}

function walk(directory, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      if (/^(private|uploads|media|local-media|responsive-media)$/i.test(entry.name)) {
        media.push({ path: full, ...directorySummary(full) });
      }
      walk(full, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    let descriptor;
    try {
      const stat = fs.statSync(full);
      if (stat.size < 512) continue;
      descriptor = fs.openSync(full, "r");
      const header = Buffer.alloc(16);
      fs.readSync(descriptor, header, 0, 16, 0);
      fs.closeSync(descriptor);
      descriptor = undefined;
      if (header.toString("binary") !== "SQLite format 3\u0000") continue;
      const db = new DatabaseSync(full, { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
      const contentItems = tables.includes("content_items")
        ? db.prepare("SELECT collection,count(*) AS total FROM content_items GROUP BY collection ORDER BY collection").all()
        : null;
      db.close();
      databases.push({ path: full, size: stat.size, tables, contentItems });
    } catch {
      try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch {}
    }
  }
}

for (const root of roots) walk(root);

console.log("===== SQLITE IM CANARY-IMAGE =====");
for (const database of databases) {
  console.log(`path=${database.path}`);
  console.log(`size=${database.size}`);
  console.log(`tables=${database.tables.join(",")}`);
  console.log(`content_items=${JSON.stringify(database.contentItems)}`);
}
if (!databases.length) console.log("none");

console.log("===== MEDIEN IM CANARY-IMAGE =====");
for (const directory of media) console.log(`path=${directory.path} files=${directory.files} bytes=${directory.bytes}`);
if (!media.length) console.log("none");

console.log("WB_INSPECT_ADMIN_IMAGE_DATA=SUCCESS");
console.log("mode=read_only");
console.log("production_changed=false");
NODE
