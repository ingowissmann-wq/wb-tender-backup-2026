import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { hashSession } from "/app/platform/auth.mjs";

const output = process.env.SESSION_OUTPUT;
if (!output) throw new Error("SESSION_OUTPUT required");
const pool = new pg.Pool({ connectionString: fs.readFileSync("/run/secrets/database_url", "utf8").trim(), max: 1 });
try {
  if (process.argv[2] === "revoke") {
    const saved = JSON.parse(fs.readFileSync(output, "utf8"));
    await pool.query("UPDATE iam.sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id_hash=$1", [saved.idHash]);
    console.log(JSON.stringify({ revoked: true }));
  } else {
    const user = (await pool.query(`SELECT DISTINCT u.id FROM iam.users u JOIN iam.user_roles ur ON ur.user_id=u.id JOIN iam.role_permissions rp ON rp.role_id=ur.role_id JOIN iam.permissions p ON p.id=rp.permission_id WHERE u.active AND p.code='tender.admin' ORDER BY u.id LIMIT 1`)).rows[0];
    if (!user) throw new Error("active tender admin unavailable");
    const pepper = fs.readFileSync("/run/secrets/session_pepper", "utf8").trim();
    const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(32).toString("hex"), idHash = hashSession(token, pepper);
    await pool.query(`INSERT INTO iam.sessions(id_hash,user_id,csrf_hash,ip_prefix_hash,user_agent_hash,expires_at,mfa_verified_at) VALUES($1,$2,$3,$4,$5,now()+interval '30 minutes',now())`, [idHash, user.id, hashSession(csrf, pepper), crypto.createHash("sha256").update("full-production-audit").digest("hex"), crypto.createHash("sha256").update("credential-ux-acceptance").digest("hex")]);
    fs.writeFileSync(output, JSON.stringify({ token, csrf, idHash, userId: user.id }), { mode: 0o600 });
    console.log(JSON.stringify({ created: true, userId: user.id }));
  }
} finally {
  await pool.end();
}
