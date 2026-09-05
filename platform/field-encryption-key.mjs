import { readFileSync } from "node:fs";

export function loadFieldEncryptionKey(env = process.env) {
  if (env.FIELD_ENCRYPTION_KEY) {
    throw new Error("inline_secret_forbidden_field_encryption_key");
  }
  if (env.IAM_FIELD_ENCRYPTION_KEY) {
    throw new Error("inline_secret_forbidden_iam_field_encryption_key");
  }

  const canonicalPath = env.FIELD_ENCRYPTION_KEY_FILE || "";
  const iamPath = env.IAM_FIELD_ENCRYPTION_KEY_FILE || "";
  if (canonicalPath && iamPath && canonicalPath !== iamPath) {
    throw new Error("field_encryption_key_file_conflict");
  }
  const keyPath = canonicalPath || iamPath;
  if (!keyPath) throw new Error("field_encryption_key_file_required");
  return readFileSync(keyPath, "utf8").replace(/\r?\n$/, "");
}
