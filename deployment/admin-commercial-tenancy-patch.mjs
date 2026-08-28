import fs from "node:fs";

const root = process.argv[2] || "/app";
const candidateDbPath = process.argv[3] || "/tmp/admin-commercial-tenancy-db.js";
const serverPath = `${root}/apps/api/dist/server.js`;
const dbPath = `${root}/apps/api/dist/db.js`;
const indexPath = `${root}/apps/admin/dist/index.html`;
let server = fs.readFileSync(serverPath, "utf8");

function replaceOnce(before, after, label) {
  const count = server.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}_expected_once_found_${count}`);
  server = server.replace(before, after);
}

replaceOnce(
  'async function authenticate(req, reply) {',
  'app.addHook("onRequest", async (req, reply) => commercialTenancy.openInternalRoute(req, reply));\napp.addHook("onResponse", async (req) => commercialTenancy.finish(req, true));\napp.addHook("onError", async (req) => commercialTenancy.finish(req, false));\nasync function authenticate(req, reply) {',
  "transaction_hooks",
);
replaceOnce(
  'import { pool, query } from "./db.js";',
  'import { pool, query, beginTenantQueryContext, finishTenantQueryContext } from "./db.js";\nimport { createCommercialTenancy } from "./commercial-tenancy.js";',
  "db_import",
);
replaceOnce(
  'const app = Fastify({',
  'const commercialTenancy = createCommercialTenancy({ pool, beginTenantQueryContext, finishTenantQueryContext });\nconst app = Fastify({',
  "commercial_init",
);
replaceOnce(
  '    await query("UPDATE iam.sessions SET last_seen_at=now() WHERE id_hash=$1", [',
  '    if (!(await commercialTenancy.attach(req, reply)) || reply.sent) return;\n    await query("UPDATE iam.sessions SET last_seen_at=now() WHERE id_hash=$1", [',
  "authenticate_attach",
);
replaceOnce(
  'app.get("/api/admin/v1/iam/me", { preHandler: authenticate }, async (req) => ({\n    email: req.auth.email,\n    permissions: req.auth.permissions,\n    csrf: req.cookies.wb_csrf || "",\n}));',
  'app.get("/api/admin/v1/iam/me", { preHandler: authenticate }, async (req) => ({\n    email: req.auth.email,\n    permissions: req.auth.permissions,\n    csrf: req.cookies.wb_csrf || "",\n    ...commercialTenancy.navigation(req),\n}));',
  "me_navigation",
);
fs.writeFileSync(serverPath, server);
fs.copyFileSync(candidateDbPath, dbPath);
const index = fs.readFileSync(indexPath, "utf8");
if (!index.includes("module-navigation.js")) {
  fs.writeFileSync(indexPath, index.replace("</body>", '<script src="/admin/module-navigation.js" defer></script></body>'));
}
