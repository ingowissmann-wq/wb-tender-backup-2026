import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function patchTenderOwnerAuth(root) {
  const authPath = path.join(root, "platform/owner-auth.mjs");
  let source = fs.readFileSync(authPath, "utf8");

  const importMarker = 'import QRCode from "qrcode";';
  if (!source.includes(importMarker))
    throw new Error("Expected owner-auth import marker not found");
  source = source.replace(importMarker, `${importMarker}\nimport argon2 from "argon2";`);

  const verifierBefore = `export async function passwordVerify(encoded, value) {
  const parts = String(encoded || "").split("$");`;
  const verifierAfter = `export async function passwordVerify(encoded, value) {
  const stored = String(encoded || "");
  // The separately deployed Admin IAM writes Argon2id hashes with this exact
  // cost profile. Accept that established format without rewriting the
  // password or weakening the legacy Tender Scrypt verification contract.
  if (/^\\$argon2id\\$v=19\\$m=65536,t=3,p=1\\$/.test(stored)) {
    try {
      return await argon2.verify(stored, value, { type: argon2.argon2id });
    } catch {
      return false;
    }
  }
  const parts = stored.split("$");`;
  if (!source.includes(verifierBefore))
    throw new Error("Expected owner-auth verifier marker not found");
  source = source.replace(verifierBefore, verifierAfter);

  fs.writeFileSync(authPath, source);
  return { authPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  patchTenderOwnerAuth(process.argv[2] || "/app");
}
