import crypto from "node:crypto";
import argon2 from "argon2";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const hmac = (value, pepper) => crypto.createHmac("sha256", pepper).update(String(value)).digest("hex");
const digest = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");
const constantTimeText = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export function safeAdminReturnTo(value) {
  const raw = String(value || "");
  if (!raw.startsWith("/admin/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return "/admin/";
  let target;
  try { target = new URL(raw, "https://wb-tender.invalid"); } catch { return "/admin/"; }
  if (target.origin !== "https://wb-tender.invalid" || !target.pathname.startsWith("/admin/") || target.pathname.startsWith("/admin/login") || target.pathname.includes("//")) return "/admin/";
  return `${target.pathname}${target.search}`;
}

export async function hashTenderPassword(value, { salt = crypto.randomBytes(16), cost = 16_384 } = {}) {
  const derived = await new Promise((resolve, reject) => crypto.scrypt(value, salt, 32, { N: cost, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key)));
  return `scrypt$${cost}$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyTenderPassword(encoded, value) {
  if (String(encoded).startsWith("$argon2id$")) {
    try { return await argon2.verify(encoded, value); } catch { return false; }
  }
  const [scheme, n, r, p, saltText, expectedText] = String(encoded || "").split("$");
  if (scheme !== "scrypt" || !/^\d+$/.test(n) || r !== "8" || p !== "1") return false;
  const expected = Buffer.from(expectedText || "", "base64url");
  if (expected.length !== 32 || Number(n) < 16_384 || Number(n) > 262_144) return false;
  try {
    const actual = await new Promise((resolve, reject) => crypto.scrypt(value, Buffer.from(saltText, "base64url"), expected.length, { N: Number(n), r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key)));
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

function base32Bytes(value) {
  let bits = "";
  for (const char of String(value).toUpperCase().replace(/=+$/, "")) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("totp_secret_invalid");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}

export function totpFor(secret, at = Date.now()) {
  const counter = Math.floor(Number(at) / 30_000);
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(counter));
  const result = crypto.createHmac("sha1", base32Bytes(secret)).update(input).digest();
  const offset = result.at(-1) & 15;
  return String((result.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function validTotpCounter(secret, code, at = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const current = Math.floor(Number(at) / 30_000);
  for (const candidate of [current - 1, current, current + 1]) {
    if (constantTimeText(totpFor(secret, candidate * 30_000), code)) return candidate;
  }
  return null;
}

export function encryptTotpSecret(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("field_encryption_key_invalid");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function decryptTotpSecret(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("field_encryption_key_invalid");
  const bytes = Buffer.from(String(value), "base64url");
  if (bytes.length < 29) throw new Error("encrypted_totp_invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}

const loginHtml = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Anmelden · WB Plattform</title><link rel="stylesheet" href="/admin/login.css"><script src="/admin/login.js" defer></script></head><body><main><h1>WB Plattform</h1><form id="login-form"><label>E-Mail<input name="email" type="email" autocomplete="username" required></label><label>Passwort<input name="password" type="password" autocomplete="current-password" minlength="12" required></label><button type="submit">Weiter</button></form><form id="mfa-form" hidden><label>Authenticator-Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label><button type="submit">Sicher anmelden</button></form><p id="status" role="status" aria-live="polite"></p></main></body></html>`;
const loginCss = `:root{font-family:system-ui;color:#172033;background:#f6f7f9}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(92vw,28rem);background:#fff;border:1px solid #d8dee7;border-radius:12px;padding:2rem;box-shadow:0 8px 30px #0f172915}[hidden]{display:none!important}form,label{display:grid;gap:.5rem}form{gap:1rem}input,button{font:inherit;min-height:44px;padding:.55rem .7rem}button{background:#0f8f91;color:white;border:0;border-radius:6px;font-weight:700}#status{min-height:1.5rem;color:#b42318}`;
const loginJs = `const login=document.querySelector('#login-form'),mfa=document.querySelector('#mfa-form'),status=document.querySelector('#status');let challenge='';const returnTo=()=>{const raw=new URLSearchParams(location.search).get('returnTo')||'';if(!raw.startsWith('/admin/')||raw.startsWith('//')||raw.includes('\\\\')||raw.startsWith('/admin/login')||raw.includes('//'))return '/admin/';try{const value=new URL(raw,location.origin);return value.origin===location.origin&&value.pathname.startsWith('/admin/')?value.pathname+value.search:'/admin/'}catch{return '/admin/'}};login.addEventListener('submit',async event=>{event.preventDefault();status.textContent='';const values=new FormData(login),response=await fetch('/api/admin/v1/iam/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({email:values.get('email'),password:values.get('password')})});const body=await response.json();if(!response.ok){status.textContent='Anmeldung fehlgeschlagen.';return}challenge=body.challenge;login.hidden=true;mfa.hidden=false;mfa.elements.code.focus()});mfa.addEventListener('submit',async event=>{event.preventDefault();status.textContent='';const response=await fetch('/api/admin/v1/iam/mfa',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({challenge,code:new FormData(mfa).get('code')})});if(!response.ok){status.textContent='Code ungültig oder abgelaufen.';return}location.assign(returnTo())});`;

export function registerAdminAuth(app, { pool, sessionPepper, fieldEncryptionKey, secureCookies = true, now = () => new Date() }) {
  if (!sessionPepper || sessionPepper.length < 32) throw new Error("session_pepper_invalid");
  if (!Buffer.isBuffer(fieldEncryptionKey) || fieldEncryptionKey.length !== 32) throw new Error("field_encryption_key_invalid");
  app.get("/admin/login", async (req, reply) => reply.header("content-security-policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'").type("text/html").send(loginHtml));
  app.get("/admin/login.js", async (_, reply) => reply.type("text/javascript").send(loginJs));
  app.get("/admin/login.css", async (_, reply) => reply.type("text/css").send(loginCss));
  app.get("/admin/", async (_, reply) => reply.redirect("/admin/ausschreibungen/", 303));

  app.post("/api/admin/v1/iam/login", { config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!EMAIL.test(email) || email.length > 254 || password.length < 12 || password.length > 1024) return reply.code(400).send({ error: "invalid_request" });
    const accountHash = digest(email), networkHash = digest(String(req.ip || "")), userAgentHash = digest(String(req.headers["user-agent"] || ""));
    const failures = await pool.query("SELECT count(*)::int count FROM iam.login_attempts WHERE account_hash=$1 AND network_hash=$2 AND success=false AND created_at>now()-interval '15 minutes'", [accountHash, networkHash]);
    if (Number(failures.rows[0]?.count || 0) >= 8) return reply.code(429).send({ error: "rate_limit_exceeded" });
    const user = (await pool.query("SELECT id,email,password_hash,active,mfa_required,mfa_secret_encrypted,locked_until FROM iam.users WHERE lower(email)=lower($1)", [email])).rows[0];
    const passwordValid = Boolean(user?.active && (!user.locked_until || new Date(user.locked_until) < now()) && await verifyTenderPassword(user.password_hash, password));
    if (!passwordValid || !user.mfa_required || !user.mfa_secret_encrypted) {
      await pool.query("INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES($1,$2,false)", [accountHash, networkHash]);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const challenge = token();
    await pool.query("DELETE FROM iam.tender_login_challenges WHERE expires_at<=now() OR user_id=$1", [user.id]);
    await pool.query("INSERT INTO iam.tender_login_challenges(challenge_hash,user_id,user_agent_hash,network_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')", [hmac(challenge, sessionPepper), user.id, userAgentHash, networkHash]);
    return { mfaRequired: true, challenge };
  });

  app.post("/api/admin/v1/iam/mfa", { config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const challenge = String(req.body?.challenge || ""), code = String(req.body?.code || "");
    if (challenge.length < 32 || challenge.length > 512 || !/^\d{6}$/.test(code)) return reply.code(400).send({ error: "invalid_request" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("DELETE FROM iam.tender_login_challenges WHERE challenge_hash=$1 AND user_agent_hash=$2 AND expires_at>now() RETURNING user_id,network_hash", [hmac(challenge, sessionPepper), digest(String(req.headers["user-agent"] || ""))])).rows[0];
      if (!row) { await client.query("ROLLBACK"); return reply.code(401).send({ error: "mfa_challenge_expired" }); }
      const user = (await client.query("SELECT id,email,mfa_secret_encrypted,mfa_last_counter FROM iam.users WHERE id=$1 AND active FOR UPDATE", [row.user_id])).rows[0];
      let counter = null;
      try { counter = user && validTotpCounter(decryptTotpSecret(user.mfa_secret_encrypted, fieldEncryptionKey), code, now().getTime()); } catch { counter = null; }
      if (counter == null || (user.mfa_last_counter != null && counter <= Number(user.mfa_last_counter))) {
        await client.query("INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES($1,$2,false)", [digest(String(user?.email || "").toLowerCase()), row.network_hash]);
        await client.query("COMMIT");
        return reply.code(401).send({ error: "invalid_mfa" });
      }
      const session = token(), csrf = token();
      await client.query("UPDATE iam.users SET mfa_last_counter=$2,failed_attempts=0,locked_until=NULL WHERE id=$1", [user.id, counter]);
      await client.query("INSERT INTO iam.sessions(id_hash,user_id,csrf_hash,ip_prefix_hash,user_agent_hash,mfa_verified_at,expires_at) VALUES($1,$2,$3,$4,$5,now(),now()+interval '8 hours')", [hmac(session, sessionPepper), user.id, hmac(csrf, sessionPepper), row.network_hash, digest(String(req.headers["user-agent"] || ""))]);
      await client.query("INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES($1,$2,true)", [digest(user.email.toLowerCase()), row.network_hash]);
      await client.query("COMMIT");
      reply.setCookie("wb_session", session, { httpOnly: true, secure: secureCookies, sameSite: "strict", path: "/", maxAge: 28_800 });
      reply.setCookie("wb_csrf", csrf, { httpOnly: false, secure: secureCookies, sameSite: "strict", path: "/", maxAge: 28_800 });
      return { mfaRequired: true, authenticated: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  });
}
