#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE="sha256:871f89c205b68d43043fa06c25a5e3a5a7083f550ab7d41e2b8cd950b11efe86"
docker image inspect "$IMAGE" >/dev/null

docker run --rm \
  --network none \
  --user 0 \
  --entrypoint node \
  --volume /:/host:ro \
  "$IMAGE" \
  --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const roots = ["/host/srv", "/host/var/lib/docker/volumes", "/host/root", "/host/opt"];
const skipped = new Set([".git", "node_modules", "overlay2", "containers", "proc", "sys", "dev"]);
const databases = [];
const mediaDirectories = [];
const archives = [];

function walk(directory, depth = 0) {
  if (depth > 14) return;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skipped.has(entry.name)) continue;
      if (/^(private|uploads|media|local-media|responsive-media)$/i.test(entry.name)) {
        mediaDirectories.push(full.replace(/^\/host/, ""));
      }
      walk(full, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;

    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    if (/(backup|career|cms|media|upload).*\.(tar|tgz|gz|zst|zip|age|gpg|enc)$/i.test(entry.name)) {
      archives.push({ path: full.replace(/^\/host/, ""), size: stat.size });
    }
    if (stat.size < 512) continue;

    let descriptor;
    try {
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
      databases.push({ path: full.replace(/^\/host/, ""), size: stat.size, tables, contentItems });
    } catch (error) {
      try {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      } catch {}
      databases.push({ path: full.replace(/^\/host/, ""), size: stat.size, error: error.message });
    }
  }
}

for (const root of roots) walk(root);

console.log("===== SQLITE-DATENBANKEN =====");
for (const database of databases) {
  console.log(`path=${database.path}`);
  console.log(`size=${database.size}`);
  if (database.error) console.log(`error=${database.error}`);
  else {
    console.log(`tables=${database.tables.join(",")}`);
    console.log(`content_items=${JSON.stringify(database.contentItems)}`);
  }
}

console.log("===== MEDIENVERZEICHNISSE =====");
for (const directory of [...new Set(mediaDirectories)].sort()) console.log(directory);

console.log("===== MÖGLICHE SICHERUNGSARCHIVE =====");
for (const archive of archives.sort((a, b) => b.size - a.size).slice(0, 100)) {
  console.log(`path=${archive.path} size=${archive.size}`);
}

console.log("WB_FIND_REAL_ADMIN_DATA=SUCCESS");
console.log("mode=read_only");
console.log("production_changed=false");
NODE
