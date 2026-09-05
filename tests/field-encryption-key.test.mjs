import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadFieldEncryptionKey } from "../platform/field-encryption-key.mjs";

test("release IAM field-key file name starts the API with a file-only key", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wb-field-key-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const keyFile = path.join(temporary, "field-key");
  const expected = "a".repeat(64);
  await writeFile(keyFile, `${expected}\n`, { mode: 0o600 });

  assert.equal(loadFieldEncryptionKey({ IAM_FIELD_ENCRYPTION_KEY_FILE: keyFile }), expected);
});

test("field-key compatibility remains fail-closed", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wb-field-key-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const canonical = path.join(temporary, "canonical");
  const iam = path.join(temporary, "iam");
  await writeFile(canonical, `${"b".repeat(64)}\n`, { mode: 0o600 });
  await writeFile(iam, `${"c".repeat(64)}\n`, { mode: 0o600 });

  assert.throws(
    () => loadFieldEncryptionKey({ FIELD_ENCRYPTION_KEY: "b".repeat(64) }),
    /inline_secret_forbidden_field_encryption_key/,
  );
  assert.throws(
    () => loadFieldEncryptionKey({ IAM_FIELD_ENCRYPTION_KEY: "b".repeat(64) }),
    /inline_secret_forbidden_iam_field_encryption_key/,
  );
  assert.throws(
    () => loadFieldEncryptionKey({
      FIELD_ENCRYPTION_KEY_FILE: canonical,
      IAM_FIELD_ENCRYPTION_KEY_FILE: iam,
    }),
    /field_encryption_key_file_conflict/,
  );
  assert.throws(() => loadFieldEncryptionKey({}), /field_encryption_key_file_required/);
});
