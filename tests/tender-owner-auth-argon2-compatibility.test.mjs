import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchTenderOwnerAuth } from "../integrations/wb-admin-portal/candidate/tender-owner-auth-argon2-compatibility-patch.mjs";

const fixture = `import QRCode from "qrcode";
export async function passwordVerify(encoded, value) {
  const parts = String(encoded || "").split("$");
  return parts.length === 7 && value === "legacy";
}`;

test("overlay declares both image arguments in global Dockerfile scope", () => {
  const dockerfile = fs.readFileSync(
    new URL("../deployment/Dockerfile.tender-owner-auth-argon2-compatibility", import.meta.url),
    "utf8",
  );
  const firstFrom = dockerfile.indexOf("FROM ");
  assert.ok(firstFrom > 0);
  const globalArgs = dockerfile.slice(0, firstFrom);
  assert.match(globalArgs, /^ARG ADMIN_AUTH_IMAGE$/m);
  assert.match(globalArgs, /^ARG TENDER_BASE_IMAGE$/m);
  assert.match(dockerfile, /USER root[\s\S]*RUN node \/tmp\/patch\.mjs \/app[\s\S]*USER pwuser/);
});

test("owner login patch accepts only the deployed Argon2id cost profile and preserves Scrypt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-owner-auth-"));
  try {
    fs.mkdirSync(path.join(root, "platform"));
    fs.writeFileSync(path.join(root, "platform/owner-auth.mjs"), fixture);
    patchTenderOwnerAuth(root);
    const patched = fs.readFileSync(path.join(root, "platform/owner-auth.mjs"), "utf8");
    assert.match(patched, /import argon2 from "argon2"/);
    assert.ok(patched.includes(String.raw`argon2id\$v=19\$m=65536,t=3,p=1`));
    assert.ok(patched.includes('const parts = stored.split("$")'));
    assert.doesNotMatch(patched, /passwordHash\(value\).*argon2/s);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("owner login patch fails closed when the runtime source is not the inspected version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-owner-auth-"));
  try {
    fs.mkdirSync(path.join(root, "platform"));
    fs.writeFileSync(path.join(root, "platform/owner-auth.mjs"), 'import QRCode from "qrcode";');
    assert.throws(() => patchTenderOwnerAuth(root), /verifier marker not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
