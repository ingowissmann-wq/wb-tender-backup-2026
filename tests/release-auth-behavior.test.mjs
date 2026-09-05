import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import argon2 from "argon2";
import {
  decryptTotpSecret, encryptTotpSecret, hashTenderPassword,
  safeAdminReturnTo, tenderBasePath, totpFor, verifyTenderPassword,
} from "../platform/admin-auth.mjs";

test("safe admin return targets preserve local paths and reject redirect variants", () => {
  assert.equal(safeAdminReturnTo("/admin/ausschreibungen/?tab=tasks"), "/admin/ausschreibungen/?tab=tasks");
  for (const unsafe of ["https://outside.invalid/admin/", "//outside.invalid/admin/", "/admin/", "/admin/login?returnTo=/admin/", "/admin/ausschreibungen/../login", "/admin/ausschreibungen/\\outside.invalid"]) {
    assert.equal(safeAdminReturnTo(unsafe), "/admin/ausschreibungen/");
  }
  assert.equal(safeAdminReturnTo("/tender/tasks?q=1", "/tender"), "/tender/tasks?q=1");
  assert.equal(safeAdminReturnTo("/admin/ausschreibungen-other", "/admin/ausschreibungen"), "/admin/ausschreibungen/");
});

test("base paths reject ambiguous or non-path configuration", () => {
  for (const invalid of ["", "/", "admin/tender", "/admin/tender/", "/admin//tender", "/admin/../tender", "/admin/tender?x=1", "/admin/%2f/tender"]) {
    assert.throws(() => tenderBasePath(invalid, "test_base"), /test_base_invalid/);
  }
  assert.equal(tenderBasePath("/api/tender"), "/api/tender");
});

test("password verification supports the production Argon2id profile and bounded synthetic scrypt fixtures", async () => {
  const password = "synthetic-only-password-value-42!";
  const scrypt = await hashTenderPassword(password, { salt: Buffer.alloc(16, 7) });
  assert.equal(await verifyTenderPassword(scrypt, password), true);
  assert.equal(await verifyTenderPassword(scrypt, `${password}x`), false);
  const productionCompatible = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
  assert.equal(await verifyTenderPassword(productionCompatible, password), true);
});

test("TOTP secrets remain encrypted at rest and produce RFC-compatible six-digit windows", () => {
  const key = crypto.randomBytes(32), secret = "JBSWY3DPEHPK3PXP";
  const encrypted = encryptTotpSecret(secret, key);
  assert.equal(encrypted.includes(secret), false);
  assert.equal(decryptTotpSecret(encrypted, key), secret);
  assert.match(totpFor(secret, 1_800_000_000_000), /^\d{6}$/);
  assert.throws(() => decryptTotpSecret(encrypted, crypto.randomBytes(32)));
});
