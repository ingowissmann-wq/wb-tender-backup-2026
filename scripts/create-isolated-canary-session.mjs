import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { hashSession } from "../platform/auth.mjs";

const databaseUrl = fs.readFileSync(process.env.DATABASE_URL_FILE || "/run/secrets/database_url", "utf8").trim();
const pepper = fs.readFileSync(process.env.SESSION_PEPPER_FILE || "/run/secrets/session_pepper", "utf8").trim();
const outputFile = process.env.CANARY_SESSION_OUTPUT;
if (!outputFile) throw new Error("CANARY_SESSION_OUTPUT_required");
const pool = new pg.Pool({ connectionString:databaseUrl, max:1 });
try {
  const user = (await pool.query(`SELECT user_row.id FROM iam.users user_row
    WHERE user_row.active=true AND EXISTS(
      SELECT 1 FROM iam.user_roles user_role
      JOIN iam.role_permissions role_permission ON role_permission.role_id=user_role.role_id
      JOIN iam.permissions permission ON permission.id=role_permission.permission_id
      WHERE user_role.user_id=user_row.id AND permission.code='tender.admin'
    ) ORDER BY user_row.id LIMIT 1`)).rows[0];
  if (!user) throw new Error("isolated_canary_admin_missing");
  const token = crypto.randomBytes(32).toString("base64url"), csrf = crypto.randomBytes(32).toString("base64url");
  await pool.query(`INSERT INTO iam.sessions(id_hash,user_id,csrf_hash,ip_prefix_hash,user_agent_hash,expires_at,mfa_verified_at)
    VALUES($1,$2,$3,'ISOLATED_CANARY','ISOLATED_CANARY',now()+interval '90 minutes',now())`, [hashSession(token,pepper),user.id,hashSession(csrf,pepper)]);
  fs.writeFileSync(outputFile, JSON.stringify({token,csrf}), {mode:0o600});
  console.log(JSON.stringify({created:true,isolated:true,expiresInMinutes:90}));
} finally {
  await pool.end();
}
