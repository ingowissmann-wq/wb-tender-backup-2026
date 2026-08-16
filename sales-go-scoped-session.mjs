import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { hashSession } from "/app/platform/auth.mjs";

const output = process.env.SESSION_OUTPUT;
const roleCode = process.env.TEST_ROLE_CODE || "business_security";
if (!output) throw new Error("SESSION_OUTPUT required");
const pool = new pg.Pool({ connectionString: fs.readFileSync("/run/secrets/database_url", "utf8").trim(), max: 1 });
try {
  if (process.argv[2] === "revoke") {
    const saved = JSON.parse(fs.readFileSync(output, "utf8"));
    await pool.query("UPDATE iam.sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id_hash=$1", [saved.idHash]);
    console.log(JSON.stringify({ revoked: true }));
  } else {
    const user = (await pool.query(`
      SELECT DISTINCT identity.id
      FROM iam.users AS identity
      JOIN iam.user_roles AS user_role ON user_role.user_id=identity.id
      JOIN iam.roles AS role ON role.id=user_role.role_id
      WHERE identity.active AND identity.mfa_required AND identity.mfa_secret_encrypted IS NOT NULL
        AND role.code=$1
      ORDER BY identity.id LIMIT 1
    `, [roleCode])).rows[0];
    if (!user) throw new Error("active scoped MFA identity unavailable");
    const pepper = fs.readFileSync("/run/secrets/session_pepper", "utf8").trim();
    const token = crypto.randomBytes(32).toString("hex");
    const csrf = crypto.randomBytes(32).toString("hex");
    const idHash = hashSession(token, pepper);
    await pool.query(`
      INSERT INTO iam.sessions(id_hash,user_id,csrf_hash,ip_prefix_hash,user_agent_hash,expires_at,mfa_verified_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes',now())
    `, [
      idHash,
      user.id,
      hashSession(csrf, pepper),
      crypto.createHash("sha256").update("sales-go-tenant-scope-test").digest("hex"),
      crypto.createHash("sha256").update("sales-go-tenant-scope-test-agent").digest("hex"),
    ]);
    fs.writeFileSync(output, JSON.stringify({ token, csrf, idHash }), { mode: 0o600 });
    console.log(JSON.stringify({ created: true, roleCode }));
  }
} finally {
  await pool.end();
}
