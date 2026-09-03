import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchAdminLoginMfa } from "../integrations/wb-admin-portal/candidate/admin-login-mfa-enrollment-patch.mjs";

const workspace = path.resolve(import.meta.dirname, "..");
const baseline = path.join(workspace, "integrations/wb-admin-portal/production-dist-baseline");

function patchedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-admin-login-"));
  fs.mkdirSync(path.join(root, "apps/api/dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/admin/dist/assets"), { recursive: true });
  fs.copyFileSync(path.join(baseline, "api/server.js"), path.join(root, "apps/api/dist/server.js"));
  fs.copyFileSync(path.join(baseline, "admin/index.html"), path.join(root, "apps/admin/dist/index.html"));
  fs.copyFileSync(path.join(baseline, "admin/assets/index-2Yce_8u7.js"), path.join(root, "apps/admin/dist/assets/index-2Yce_8u7.js"));
  patchAdminLoginMfa(root);
  return root;
}

test("shipped client login body matches the API contract", () => {
  const api = fs.readFileSync(path.join(baseline, "api/server.js"), "utf8");
  const client = fs.readFileSync(path.join(baseline, "admin/assets/index-2Yce_8u7.js"), "utf8");
  assert.match(api, /const loginSchema = z\.object\(\{\s*email:[\s\S]*password:/);
  assert.doesNotMatch(api.slice(api.indexOf("const loginSchema"), api.indexOf("const mfaSchema")), /acceptancePassword/);
  assert.match(client, /JSON\.stringify\(\{email:X\.get\("email"\),password:X\.get\("password"\)\}\)/);
});

test("unconfigured accounts enroll MFA before a session can be created", () => {
  const root = patchedFixture();
  try {
    const api = fs.readFileSync(path.join(root, "apps/api/dist/server.js"), "utf8");
    const asset = fs.readdirSync(path.join(root, "apps/admin/dist/assets")).find((name) => name.endsWith(".js"));
    const client = fs.readFileSync(path.join(root, "apps/admin/dist/assets", asset), "utf8");
    const html = fs.readFileSync(path.join(root, "apps/admin/dist/index.html"), "utf8");
    const login = api.slice(api.indexOf('app.post("/api/admin/v1/iam/login"'), api.indexOf('app.post("/api/admin/v1/iam/mfa"'));
    assert.match(login, /mfaSetupSecret/);
    assert.match(login, /mfaSetupRequired: true/);
    assert.doesNotMatch(login, /createAdminSession/);
    assert.match(api, /verifyTotp\(decryptSecret\(encryptedSecret\)/);
    assert.match(api, /else if \(!preauth\.mfaSetupSecret\)/);
    assert.match(api, /mfa_secret_encrypted IS NULL RETURNING id/);
    assert.ok(api.indexOf("mfa_self_enrollment") < api.indexOf("return createAdminSession", api.indexOf('app.post("/api/admin/v1/iam/mfa"')));
    assert.match(client, /challenge:R\.challenge/);
    assert.match(client, /Eine Sitzung wird erst nach erfolgreicher Codeprüfung erstellt/);
    assert.match(client, /location\.assign\(W\)/);
    assert.match(client, /Z\.startsWith\(\"\/admin\/\"\)/);
    assert.notEqual(asset, "index-2Yce_8u7.js");
    assert.match(html, new RegExp(`assets/${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("patch is fingerprinted and refuses an unknown runtime", () => {
  const root = patchedFixture();
  try {
    assert.throws(() => patchAdminLoginMfa(root), /Expected production/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
