import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  currentTotp,
  mfaEnrollmentPayload,
  passwordHash,
  passwordVerify,
  registerOwnerAuth,
  totpEnrollmentUri,
} from "../platform/owner-auth.mjs";

const makeApp = () => {
  const routes = [];
  return {
    routes,
    get(url, options, handler) {
      routes.push({ method: "GET", url, options, handler });
    },
    post(url, options, handler) {
      routes.push({ method: "POST", url, options, handler });
    },
  };
};

test("owner password hashes use the canonical scrypt parameters", async () => {
  const encoded = await passwordHash("correct horse battery staple");
  assert.match(encoded, /^\$scrypt\$65536\$8\$1\$/);
  assert.equal(await passwordVerify(encoded, "correct horse battery staple"), true);
  assert.equal(await passwordVerify(encoded, "incorrect horse battery staple"), false);
  assert.equal(await passwordVerify("not-a-supported-hash", "anything"), false);
});

test("TOTP generation is deterministic for a fixed secret and instant", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  assert.equal(currentTotp(secret, 0), "282760");
  assert.equal(currentTotp(secret, 59_000), currentTotp(secret, 30_000));
  assert.match(currentTotp(secret, Date.UTC(2026, 7, 29)), /^\d{6}$/);
});

test("first MFA enrollment returns a scannable local PNG QR code and a manual fallback", async () => {
  const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const uri = totpEnrollmentUri(secret, "New.User@WB-Holding.AG");
  assert.equal(uri, "otpauth://totp/WB%20Tender:new.user%40wb-holding.ag?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=WB%20Tender&algorithm=SHA1&digits=6&period=30");
  const enrollment = await mfaEnrollmentPayload(secret, "New.User@WB-Holding.AG");
  assert.equal(enrollment.secret, secret);
  assert.match(enrollment.qrCodeDataUrl, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.ok(enrollment.qrCodeDataUrl.length > 1_000);
  assert.equal(Object.hasOwn(enrollment, "uri"), false);
});

test("owner enrollment UI prefers QR scanning and keeps the long secret behind a fallback", async () => {
  const source = await readFile(new URL("../platform/owner-auth.mjs", import.meta.url), "utf8");
  assert.match(source, /id="qr" class="qr hidden"/);
  assert.match(source, /Manuellen Einrichtungsschlüssel anzeigen/);
  assert.match(source, /data\.qrCodeDataUrl/);
  assert.match(source, /Scannen Sie den QR-Code/);
  assert.doesNotMatch(source, /id="uri"/);
});

test("owner routes accept a configured canonical HTTPS origin without hardcoding a tenant domain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wb-owner-auth-"));
  const keyFile = path.join(directory, "iam-field.key");
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  const previousKeyFile = process.env.IAM_FIELD_ENCRYPTION_KEY_FILE;
  const previousInlineKey = process.env.IAM_FIELD_ENCRYPTION_KEY;
  try {
    await writeFile(keyFile, "11".repeat(32), { mode: 0o600 });
    process.env.PUBLIC_ORIGIN = "https://candidate.wb-tender.invalid";
    process.env.IAM_FIELD_ENCRYPTION_KEY_FILE = keyFile;
    delete process.env.IAM_FIELD_ENCRYPTION_KEY;
    const app = makeApp();
    const result = registerOwnerAuth(app, {
      pool: {}, authenticate() {}, csrf() {},
      uiBase: "/admin/ausschreibungen",
      apiBase: "/api/tender",
      sessionPepper: "22".repeat(32),
    });
    assert.equal(result.browserAuth.config.browserAuth, true);
    assert.deepEqual(
      app.routes.map(({ method, url }) => `${method} ${url}`),
      [
        "GET /login", "GET /first-login", "GET /auth.css", "GET /auth.js",
        "POST /api/auth/first-login", "POST /api/auth/login", "POST /api/auth/mfa",
        "GET /api/auth/me", "POST /api/auth/logout",
      ],
    );
  } finally {
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    if (previousKeyFile === undefined) delete process.env.IAM_FIELD_ENCRYPTION_KEY_FILE;
    else process.env.IAM_FIELD_ENCRYPTION_KEY_FILE = previousKeyFile;
    if (previousInlineKey === undefined) delete process.env.IAM_FIELD_ENCRYPTION_KEY;
    else process.env.IAM_FIELD_ENCRYPTION_KEY = previousInlineKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner routes reject non-TLS, path-bearing and credential-bearing origins", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wb-owner-origin-"));
  const keyFile = path.join(directory, "iam-field.key");
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  const previousKeyFile = process.env.IAM_FIELD_ENCRYPTION_KEY_FILE;
  try {
    await writeFile(keyFile, "33".repeat(32), { mode: 0o600 });
    process.env.IAM_FIELD_ENCRYPTION_KEY_FILE = keyFile;
    for (const origin of [
      "http://candidate.wb-tender.invalid",
      "https://candidate.wb-tender.invalid/path",
      "https://user:password@candidate.wb-tender.invalid",
    ]) {
      process.env.PUBLIC_ORIGIN = origin;
      assert.throws(
        () => registerOwnerAuth(makeApp(), {
          pool: {}, authenticate() {}, csrf() {},
          uiBase: "/admin/ausschreibungen",
          apiBase: "/api/tender",
          sessionPepper: "44".repeat(32),
        }),
        /public_origin_must_be_canonical_tls_origin/,
      );
    }
  } finally {
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    if (previousKeyFile === undefined) delete process.env.IAM_FIELD_ENCRYPTION_KEY_FILE;
    else process.env.IAM_FIELD_ENCRYPTION_KEY_FILE = previousKeyFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("server integrates owner auth without replacing the reconstructed production server", async () => {
  const server = await readFile(new URL("../platform/server.mjs", import.meta.url), "utf8");
  assert.match(server, /import \{ registerOwnerAuth \} from "\.\/owner-auth\.mjs";/);
  assert.match(server, /registerOwnerAuth\(app, \{ pool: rawPool,/);
  assert.match(server, /config: \{ browserAuth: true \}/);
  assert.match(server, /reply\.redirect\(uiBase \+ "\/login\?returnTo="/);
});

test("bootstrap is fail-closed and reads secrets only from files", async () => {
  const bootstrap = await readFile(new URL("../platform/bootstrap-owner.mjs", import.meta.url), "utf8");
  assert.match(bootstrap, /process\.env\[`\$\{name\}_FILE`\]/);
  assert.match(bootstrap, /bootstrap_refuses_nonempty_iam/);
  assert.match(bootstrap, /UPDATE iam\.password_reset_tokens SET used_at=now\(\)/);
  assert.doesNotMatch(bootstrap, /postgres(?:ql)?:\/\//i);
});
