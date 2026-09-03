import { readFileSync, writeFileSync } from "node:fs";

const target = "/app/apps/api/dist/server.js";
const before = `const r = await query("SELECT id,title,data,updated_at FROM app.resources WHERE resource_type=$1 AND status='published' AND deleted_at IS NULL ORDER BY created_at", [type]);`;
const after = `const r = await query("SELECT id,title,data,updated_at FROM app.resources WHERE resource_type=$1 AND status='published' AND deleted_at IS NULL ORDER BY CASE WHEN $1='blogposts' THEN created_at END DESC NULLS LAST, CASE WHEN $1<>'blogposts' THEN created_at END ASC, id", [type]);`;

const source = readFileSync(target, "utf8");
const occurrences = source.split(before).length - 1;
if (occurrences !== 1) {
  throw new Error(`Expected exactly one public CMS query fingerprint, found ${occurrences}`);
}
writeFileSync(target, source.replace(before, after));
