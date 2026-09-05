#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { encryptTotpSecret, hashTenderPassword } from "../platform/admin-auth.mjs";
import { hashSession } from "../platform/auth.mjs";

const mode = process.argv[2];
const allowedModes = new Set(["dry-run", "prepare", "cleanup", "verify-absence"]);
if (!allowedModes.has(mode)) throw new Error("usage: production-iam-canary.mjs dry-run|prepare|cleanup|verify-absence");
if (process.getuid?.() !== 0) throw new Error("production_iam_canary_requires_root");

for (const name of ["DATABASE_URL", "SESSION_PEPPER", "FIELD_ENCRYPTION_KEY", "CANARY_PASSWORD", "CANARY_TOTP", "CANARY_SESSION", "CANARY_CSRF"]) {
  if (String(process.env[name] || "")) throw new Error(`inline_secret_forbidden_${name.toLowerCase()}`);
}

const stateDirectory = path.resolve(String(process.env.PRODUCTION_CANARY_STATE_DIR || ""));
const repositoryRoot = path.resolve(import.meta.dirname, "..");
if (!process.env.PRODUCTION_CANARY_STATE_DIR || !path.isAbsolute(process.env.PRODUCTION_CANARY_STATE_DIR) || stateDirectory === "/"
    || stateDirectory === repositoryRoot || stateDirectory.startsWith(`${repositoryRoot}${path.sep}`)) {
  throw new Error("production_canary_state_dir_must_be_absolute_outside_checkout");
}
const output = Object.freeze({
  manifest: path.join(stateDirectory, "manifest.json"),
  email: path.join(stateDirectory, "email"),
  password: path.join(stateDirectory, "password"),
  totp: path.join(stateDirectory, "totp"),
  curl: path.join(stateDirectory, "curl.config"),
});
const secureFile = (environmentName) => {
  const pathname = String(process.env[environmentName] || "");
  if (!pathname || !path.isAbsolute(pathname)) throw new Error(`${environmentName.toLowerCase()}_absolute_file_required`);
  const stat = fs.lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) > 0o600) throw new Error(`${environmentName.toLowerCase()}_must_be_root_owned_mode_0600`);
  return fs.readFileSync(pathname, "utf8").replace(/\r?\n$/, "");
};
const databaseUrl = secureFile("DATABASE_URL_FILE");
const pepper = secureFile("SESSION_PEPPER_FILE");
const fieldKeyText = secureFile("FIELD_ENCRYPTION_KEY_FILE");
if (pepper.length < 32) throw new Error("session_pepper_invalid");
if (!/^[0-9a-f]{64}$/i.test(fieldKeyText)) throw new Error("field_encryption_key_invalid");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, application_name: "wb_tender_production_iam_canary" });
const requiredTables = ["users", "roles", "permissions", "user_roles", "role_permissions", "sessions", "login_attempts"];
const tablePresent = async (client, table) => Boolean((await client.query("SELECT to_regclass($1) present", [`iam.${table}`])).rows[0].present);
const assertSchema = async (client) => {
  for (const table of requiredTables) if (!(await tablePresent(client, table))) throw new Error(`required_iam_table_missing:${table}`);
  const permission = (await client.query("SELECT id FROM iam.permissions WHERE code='tender.submission.approve'")).rows[0];
  if (!permission) throw new Error("required_canary_permission_missing");
  return permission.id;
};
const assertStateDirectory = () => {
  const stat = fs.lstatSync(stateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) throw new Error("production_canary_state_dir_must_be_root_owned_mode_0700");
};
const writeExclusive = (pathname, value) => {
  fs.writeFileSync(pathname, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const stat = fs.lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600) throw new Error("canary_output_file_security_check_failed");
};
const readManifest = () => {
  assertStateDirectory();
  const stat = fs.lstatSync(output.manifest);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600) throw new Error("canary_manifest_security_check_failed");
  const value = JSON.parse(fs.readFileSync(output.manifest, "utf8"));
  if (value.version !== 1 || !/^WB_TENDER_IAM_CANARY_[A-Z0-9_]+$/.test(value.marker)
      || !/^[0-9a-f-]{36}$/i.test(value.userId) || !/^[0-9a-f-]{36}$/i.test(value.roleId)
      || !/^[^@\s]+@example\.invalid$/.test(value.email)) throw new Error("canary_manifest_invalid");
  return value;
};
const updateManifest = (value) => {
  const temporary = `${output.manifest}.new`;
  writeExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, output.manifest);
};
const randomBase32 = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", bytes = crypto.randomBytes(20);
  let bits = "", result = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  for (let offset = 0; offset < bits.length; offset += 5) result += alphabet[Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, "0"), 2)];
  return result;
};
const shred = (pathname) => {
  if (!fs.existsSync(pathname)) return;
  const stat = fs.lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0) throw new Error("refusing_to_shred_untrusted_canary_file");
  const descriptor = fs.openSync(pathname, "r+");
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      fs.writeSync(descriptor, crypto.randomBytes(stat.size), 0, stat.size, 0);
      fs.fsyncSync(descriptor);
    }
  } finally { fs.closeSync(descriptor); }
  fs.unlinkSync(pathname);
};
const absenceCount = async (client, manifest) => {
  let count = 0;
  for (const [table, column, value] of [
    ["users", "id", manifest.userId], ["roles", "id", manifest.roleId],
    ["user_roles", "user_id", manifest.userId], ["role_permissions", "role_id", manifest.roleId],
    ["sessions", "user_id", manifest.userId], ["login_attempts", "account_hash", manifest.accountHash],
    ["tender_identity_scopes", "user_id", manifest.userId], ["tender_login_challenges", "user_id", manifest.userId],
  ]) {
    if (await tablePresent(client, table)) count += Number((await client.query(`SELECT count(*)::int count FROM iam.${table} WHERE ${column}=$1`, [value])).rows[0].count);
  }
  return count;
};

try {
  if (mode === "dry-run") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await assertSchema(client);
      if (process.env.CANARY_REQUIRE_COMPANY_SCOPE === "true") {
        const company = await client.query("SELECT company_id FROM tender.enterprise_company_links WHERE active=true ORDER BY company_id LIMIT 1");
        if (!company.rowCount) throw new Error("optional_existing_company_scope_unavailable");
      }
      await client.query("ROLLBACK");
    } finally { client.release(); }
    console.log(JSON.stringify({ passed: true, mode, writes: false, iamOnly: true, externalSubmission: false, secretsLogged: false }));
  } else if (mode === "prepare") {
    if (fs.existsSync(stateDirectory)) throw new Error("production_canary_state_dir_must_not_exist_for_prepare");
    fs.mkdirSync(stateDirectory, { mode: 0o700 });
    assertStateDirectory();
    const marker = `WB_TENDER_IAM_CANARY_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
    const userId = crypto.randomUUID(), roleId = crypto.randomUUID();
    const email = `${marker.toLowerCase()}@example.invalid`;
    const password = `C-${crypto.randomBytes(36).toString("base64url")}!7z`;
    const totp = randomBase32(), session = crypto.randomBytes(48).toString("base64url"), csrf = crypto.randomBytes(48).toString("base64url");
    const accountHash = crypto.createHash("sha256").update(email).digest("hex");
    const manifest = { version: 1, status: "PREPARED", marker, userId, roleId, email, accountHash, companyScopeId: null, createdAt: new Date().toISOString(), expiresInMinutes: 90 };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('wb-tender-production-iam-canary'))");
      const permissionId = await assertSchema(client);
      const passwordHash = await hashTenderPassword(password);
      const encryptedTotp = encryptTotpSecret(totp, Buffer.from(fieldKeyText, "hex"));
      await client.query("INSERT INTO iam.users(id,email,password_hash,active,mfa_required,mfa_secret_encrypted,failed_attempts,mfa_last_counter) VALUES($1,$2,$3,true,true,$4,0,NULL)", [userId, email, passwordHash, encryptedTotp]);
      await client.query("INSERT INTO iam.roles(id,code,label) VALUES($1,$2,$3)", [roleId, `tender.production_canary.${marker.toLowerCase()}`, `${marker} IAM-only release gate`]);
      await client.query("INSERT INTO iam.role_permissions(role_id,permission_id) VALUES($1,$2)", [roleId, permissionId]);
      await client.query("INSERT INTO iam.user_roles(user_id,role_id) VALUES($1,$2)", [userId, roleId]);
      if (process.env.CANARY_REQUIRE_COMPANY_SCOPE === "true") {
        const company = (await client.query("SELECT company_id FROM tender.enterprise_company_links WHERE active=true ORDER BY company_id LIMIT 1")).rows[0];
        if (!company) throw new Error("optional_existing_company_scope_unavailable");
        if (!(await tablePresent(client, "tender_identity_scopes"))) throw new Error("tender_identity_scopes_missing");
        await client.query("INSERT INTO iam.tender_identity_scopes(user_id,scope_type,scope_id,active) VALUES($1,'company',$2,true)", [userId, company.company_id]);
        manifest.companyScopeId = String(company.company_id);
      }
      await client.query("INSERT INTO iam.sessions(id_hash,user_id,csrf_hash,ip_prefix_hash,user_agent_hash,mfa_verified_at,expires_at) VALUES($1,$2,$3,$4,$4,now(),now()+interval '90 minutes')", [hashSession(session, pepper), userId, hashSession(csrf, pepper), accountHash]);
      writeExclusive(output.email, `${email}\n`);
      writeExclusive(output.password, `${password}\n`);
      writeExclusive(output.totp, `${totp}\n`);
      writeExclusive(output.curl, `cookie = "wb_session=${session}; wb_csrf=${csrf}"\nheader = "x-csrf-token: ${csrf}"\n`);
      writeExclusive(output.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      for (const pathname of [output.email, output.password, output.totp, output.curl, output.manifest]) shred(pathname);
      try { fs.rmdirSync(stateDirectory); } catch {}
      throw error;
    } finally { client.release(); }
    console.log(JSON.stringify({ passed: true, mode, marker, iamOnly: true, sessionMinutes: 90, curlConfigLines: 2, externalSubmission: false, secretsLogged: false }));
  } else {
    const manifest = readManifest();
    const client = await pool.connect();
    try {
      if (mode === "cleanup") {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('wb-tender-production-iam-canary'))");
        if (await tablePresent(client, "sessions")) await client.query("UPDATE iam.sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1", [manifest.userId]);
        await client.query("COMMIT");
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('wb-tender-production-iam-canary'))");
        if (await tablePresent(client, "tender_login_challenges")) await client.query("DELETE FROM iam.tender_login_challenges WHERE user_id=$1", [manifest.userId]);
        if (await tablePresent(client, "tender_identity_scopes")) await client.query("DELETE FROM iam.tender_identity_scopes WHERE user_id=$1", [manifest.userId]);
        await client.query("DELETE FROM iam.sessions WHERE user_id=$1", [manifest.userId]);
        await client.query("DELETE FROM iam.login_attempts WHERE account_hash=$1", [manifest.accountHash]);
        await client.query("DELETE FROM iam.user_roles WHERE user_id=$1", [manifest.userId]);
        await client.query("DELETE FROM iam.role_permissions WHERE role_id=$1", [manifest.roleId]);
        await client.query("DELETE FROM iam.users WHERE id=$1", [manifest.userId]);
        await client.query("DELETE FROM iam.roles WHERE id=$1", [manifest.roleId]);
        const absent = await absenceCount(client, manifest);
        if (absent !== 0) throw new Error(`canary_cleanup_absence_failed:${absent}`);
        await client.query("COMMIT");
        for (const pathname of [output.email, output.password, output.totp, output.curl]) shred(pathname);
        updateManifest({ ...manifest, status: "CLEANED", cleanedAt: new Date().toISOString(), postCleanupAbsence: true });
      } else {
        await client.query("BEGIN READ ONLY");
        const absent = await absenceCount(client, manifest);
        await client.query("ROLLBACK");
        if (absent !== 0) throw new Error(`canary_absence_verification_failed:${absent}`);
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
    console.log(JSON.stringify({ passed: true, mode, marker: manifest.marker, postCleanupAbsence: true, absenceCount: 0, secretsLogged: false }));
  }
} finally {
  await pool.end();
}
