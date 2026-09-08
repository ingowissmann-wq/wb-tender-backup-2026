import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const handler = readFileSync(path.join(workspace, "integrations/wb-admin-portal/production-dist-baseline/api/autoseo.js"), "utf8");
const server = readFileSync(path.join(workspace, "integrations/wb-admin-portal/production-dist-baseline/api/server.js"), "utf8");
const migration = readFileSync(path.join(workspace, "migrations/084_real_admin_portal_tenant_enforcement.sql"), "utf8");
const blogOrderPatch = readFileSync(path.join(workspace, "deployment/admin-public-blog-order-patch.mjs"), "utf8");

test("AutoSEO media upsert targets the tenant-scoped partial unique index", () => {
  assert.match(migration, /ON app\.resources\(tenant_id,source_system,resource_type,external_id\) WHERE external_id IS NOT NULL/);
  assert.match(handler, /ON CONFLICT\(tenant_id,source_system,resource_type,external_id\) WHERE external_id IS NOT NULL DO UPDATE SET/);
  assert.doesNotMatch(handler, /ON CONFLICT\(source_system,resource_type,external_id\) DO UPDATE SET title=EXCLUDED\.title,status='published'/);
});

test("AutoSEO repairs a hash-verified missing binary and keeps compensation reversible", () => {
  assert.match(handler, /await fsp\.writeFile\(target, downloaded\.bytes, \{ mode: 0o600 \}\);\s+repairedBinary = true;/);
  assert.match(handler, /image\.repairedBinary && image\.previousBinary/);
  assert.match(handler, /await fsp\.writeFile\(target, image\.previousBinary, \{ mode: 0o600 \}\);/);
  assert.match(handler, /else if \(image\.created\)\s+await query\("DELETE FROM files\.objects/);
});

test("AutoSEO verifies the active wrapped public CMS response and serializes rollback JSON", () => {
  assert.match(handler, /\(item\?\.slug \|\| item\?\.data\?\.slug\) === slug/);
  assert.match(handler, /fullContent: match\.data\.fullContent \|\| match\.data\.content_html \|\| ""/);
  assert.match(handler, /content: match\.data\.content \|\| match\.data\.content_markdown \|\| ""/);
  assert.match(handler, /structured_data,created_at,updated_at\) VALUES\(\$1,\$2,\$3,\$4,\$5,\$6,\$7::jsonb,\$8,\$9\)/);
  assert.match(handler, /jsonb\(item\.structured_data\)/);
});

test("AutoSEO media uses the restricted public route and its configured public origin", () => {
  assert.match(handler, /url: `\$\{mediaOrigin\}\/api\/public\/v1\/autoseo\/media\/\$\{file\.rows\[0\]\.id\}`/);
  assert.match(handler, /process\.env\.AUTOSEO_MEDIA_ORIGIN \|\| process\.env\.AUTOSEO_CMS_API_ORIGIN \|\| process\.env\.PUBLIC_ORIGIN/);
  assert.match(handler, /fetch\(image\.url/);
  assert.match(handler, /app\.get\("\/api\/public\/v1\/autoseo\/media\/:id"[\s\S]*?header\("cross-origin-resource-policy", "cross-origin"\)/);
});

test("overlay preserves the live URL-auth, body-compatibility, and tenant context contract", () => {
  assert.match(handler, /WB_AUTOSEO_URL_AUTH_CANARY/);
  assert.match(handler, /const urlRequest = constantEqual\(text\(req\.query\?\.key\), endpointKey\)/);
  assert.match(handler, /if \(!delivery && urlRequest\)/);
  assert.match(handler, /WB_AUTOSEO_TENANT_RESOLUTION_V2_CANARY/);
  assert.match(handler, /SELECT set_config\('app\.tenant_id',\$1,false\)/);
  assert.match(handler, /integration\.autoseo_deliveries\(delivery_id,event_type,external_id,payload_sha256,status,tenant_id\)/);
});

test("PostgreSQL CMS remains the sole write source for AutoSEO publication", () => {
  const route = handler.slice(handler.indexOf("export function registerAutoSeoRoutes"));
  assert.doesNotMatch(route, /publishToPublicCms\(/);
  assert.doesNotMatch(route, /restorePublicCms\(/);
  assert.match(route, /publicCms: "postgresql-source-of-truth"/);
  assert.match(route, /content_html: renderedHtml, fullContent: renderedHtml/);
  assert.match(route, /heroImageLocalUrl: hero\?\.url \|\| null, coverImage: hero\?\.url \|\| null/);
});

test("CMS edits and the public renderer read the same PostgreSQL resource", () => {
  assert.match(server, /app\.patch\("\/api\/admin\/v1\/resources\/:type\/:id"/);
  assert.match(server, /UPDATE app\.resources SET data=data\|\|\$1,title=COALESCE\(\$2,title\),status=COALESCE\(\$3,status\),version=version\+1/);
  assert.match(server, /app\.get\("\/api\/public\/v1\/:type"/);
  assert.match(server, /SELECT id,title,data,updated_at FROM app\.resources WHERE resource_type=\$1 AND status='published'/);
});

test("common AutoSEO meta-title aliases map to the editable CMS SEO title", () => {
  assert.match(handler, /articleValue\.seoTitle \?\? articleValue\.seo_title \?\? articleValue\.metaTitle \?\? articleValue\.meta_title/);
});

test("public blog index returns newest published CMS rows first without changing other resource ordering", () => {
  const expected = /ORDER BY CASE WHEN \$1='blogposts' THEN created_at END DESC NULLS LAST, CASE WHEN \$1<>'blogposts' THEN created_at END ASC, id/;
  const publicRoute = server.slice(server.indexOf('app.get("/api/public/v1/:type"'), server.indexOf('app.get("/api/admin/v1/audit"'));
  assert.match(publicRoute, expected);
  assert.match(blogOrderPatch, expected);
  assert.match(blogOrderPatch, /Expected exactly one public CMS query fingerprint/);
  assert.doesNotMatch(publicRoute, /source_system\s*=|content_type\s*=|category\s*=|LIMIT\s+12/i);
});
