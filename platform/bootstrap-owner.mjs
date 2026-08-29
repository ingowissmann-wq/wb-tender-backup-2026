import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { passwordHash } from "./owner-auth.mjs";

const readSecret = (name) => readFileSync(process.env[`${name}_FILE`], "utf8").trim();
const pepper = readSecret("SESSION_PEPPER");
const databaseUrl = readSecret("DATABASE_URL");
const rawToken = crypto.randomBytes(32).toString("base64url");
const tokenHash = crypto.createHmac("sha256", pepper).update(rawToken).digest("hex");
const discardedPassword = crypto.randomBytes(48).toString("base64url");
const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const users = await client.query("SELECT id,email FROM iam.users FOR UPDATE");
  if (users.rowCount && !(users.rowCount === 1 && users.rows[0].email.toLowerCase() === "admin@wb-tender.de"))
    throw new Error("bootstrap_refuses_nonempty_iam");
  await client.query("INSERT INTO iam.permissions(code) VALUES('tender.admin') ON CONFLICT(code) DO NOTHING");
  await client.query("INSERT INTO iam.roles(code,label) VALUES('administrator','Administrator') ON CONFLICT(code) DO UPDATE SET label=excluded.label");
  await client.query("INSERT INTO iam.role_permissions(role_id,permission_id) SELECT r.id,p.id FROM iam.roles r CROSS JOIN iam.permissions p WHERE r.code='administrator' AND p.code='tender.admin' ON CONFLICT DO NOTHING");
  let user = users.rows[0];
  if (!user) user = (await client.query("INSERT INTO iam.users(email,password_hash,active,mfa_required) VALUES('admin@wb-tender.de',$1,true,true) RETURNING id,email", [await passwordHash(discardedPassword)])).rows[0];
  await client.query("INSERT INTO iam.user_roles(user_id,role_id) SELECT $1,id FROM iam.roles WHERE code='administrator' ON CONFLICT DO NOTHING", [user.id]);
  await client.query("UPDATE iam.password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [user.id]);
  await client.query("INSERT INTO iam.password_reset_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '2 hours')", [tokenHash, user.id]);
  await client.query("COMMIT");
  process.stdout.write(rawToken + "\n");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
