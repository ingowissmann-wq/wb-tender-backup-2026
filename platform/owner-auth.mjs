import crypto from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import QRCode from "qrcode";

const scryptAsync = promisify(crypto.scrypt);
const TARGET_EMAIL = "admin@wb-tender.de";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PASSWORD_N = 65536;
const PASSWORD_R = 8;
const PASSWORD_P = 1;

const token = () => crypto.randomBytes(32).toString("base64url");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const ipPrefix = (ip) => String(ip || "").includes(":")
  ? String(ip || "").split(":").slice(0, 4).join(":")
  : String(ip || "").split(".").slice(0, 3).join(".");

export async function passwordHash(value) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(value, salt, 32, {
    N: PASSWORD_N, r: PASSWORD_R, p: PASSWORD_P, maxmem: 128 * 1024 * 1024,
  });
  return `$scrypt$${PASSWORD_N}$${PASSWORD_R}$${PASSWORD_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function passwordVerify(encoded, value) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 7 || parts[1] !== "scrypt") return false;
  const [, , nText, rText, pText, saltText, hashText] = parts;
  const N = Number(nText), r = Number(rText), p = Number(pText);
  if (N !== PASSWORD_N || r !== PASSWORD_R || p !== PASSWORD_P) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = await scryptAsync(value, Buffer.from(saltText, "base64url"), expected.length, {
      N, r, p, maxmem: 128 * 1024 * 1024,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function decodeBase32(value) {
  let bits = "";
  for (const char of String(value).toUpperCase().replace(/=+$/, "")) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error("invalid_base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret, counter) {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function currentTotp(secret, now = Date.now()) {
  return totpAt(secret, Math.floor(now / 30000));
}

function matchingTotpCounter(secret, supplied, now = Date.now()) {
  if (!/^\d{6}$/.test(String(supplied))) return null;
  const current = Math.floor(now / 30000);
  for (const counter of [current - 1, current, current + 1])
    if (safeEqual(totpAt(secret, counter), supplied)) return counter;
  return null;
}

function generateTotpSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let result = "";
  for (let index = 0; index < bits.length; index += 5)
    result += B32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  return result;
}

export function totpEnrollmentUri(secret, email = TARGET_EMAIL) {
  if (!/^[A-Z2-7]{32}$/.test(String(secret || ""))) throw new Error("invalid_totp_enrollment_secret");
  const issuer = "WB Tender";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(String(email).toLowerCase())}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export async function mfaEnrollmentPayload(secret, email = TARGET_EMAIL) {
  const uri = totpEnrollmentUri(secret, email);
  const qrCodeDataUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 256,
    color: { dark: "#0f1729", light: "#ffffff" },
  });
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qrCodeDataUrl))
    throw new Error("invalid_totp_qr_output");
  return { secret, qrCodeDataUrl };
}

function encryptionKey() {
  if (process.env.IAM_FIELD_ENCRYPTION_KEY)
    throw new Error("inline_iam_field_encryption_key_forbidden");
  const path = process.env.IAM_FIELD_ENCRYPTION_KEY_FILE;
  const value = path ? readFileSync(path, "utf8").trim() : "";
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("iam_field_encryption_key_invalid");
  return Buffer.from(value, "hex");
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function decryptSecret(value) {
  const data = Buffer.from(value, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

const authCss = `:root{font-family:system-ui,-apple-system,sans-serif;color:#172033;background:#f6f7f9}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem}.panel{width:min(100%,32rem);background:#fff;border:1px solid #d8dee7;border-radius:12px;padding:clamp(1.25rem,4vw,2rem);box-shadow:0 8px 30px rgb(15 23 41/.1)}h1{margin:.2rem 0 1rem;color:#0f1729}p{line-height:1.5}.muted{color:#5d6878}label{display:grid;gap:.35rem;margin:1rem 0;font-weight:650}input{width:100%;min-height:46px;padding:.7rem;border:1px solid #aeb8c6;border-radius:7px;font:inherit}button,.button{display:inline-block;min-height:46px;padding:.75rem 1rem;border:0;border-radius:7px;background:#087173;color:white;font:650 1rem system-ui;cursor:pointer;text-decoration:none}button[disabled]{opacity:.65}.error{color:#9b1c1c;background:#fff1f0;border-left:4px solid #b42318;padding:.75rem}.notice{background:#edf7f7;border-left:4px solid #087173;padding:.75rem}.qr{display:block;width:min(100%,256px);height:auto;margin:1rem auto;border:1px solid #d8dee7;border-radius:8px}.secret,.codes{font:600 .95rem ui-monospace,monospace;overflow-wrap:anywhere;background:#f2f4f7;padding:.75rem;border-radius:6px}details{margin:1rem 0}summary{cursor:pointer;font-weight:650}.hidden{display:none}a{color:#086f72}`;

const authJs = `(()=>{
  const base="/admin/ausschreibungen",api="/api/tender/auth",mode=document.body.dataset.mode;
  const status=document.querySelector("#status");
  const show=(message,error=false)=>{status.textContent=message;status.className=error?"error":"notice"};
  const post=async(path,body)=>{const response=await fetch(api+path,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(body)});let data={};try{data=await response.json()}catch{}if(!response.ok)throw new Error(data.message||data.error||"Anfrage fehlgeschlagen");return data};
  const safeReturn=()=>{const value=new URLSearchParams(location.search).get("returnTo")||base+"/";return value===base||value.startsWith(base+"/")?value:base+"/"};
  if(mode==="first"){
    const params=new URLSearchParams(location.search),firstToken=params.get("token")||"";
    history.replaceState({},"",base+"/first-login");
    document.querySelector("form").onsubmit=async event=>{event.preventDefault();const body=new FormData(event.target);try{event.submitter.disabled=true;await post("/first-login",{token:firstToken,password:body.get("password"),confirmation:body.get("confirmation")});show("Passwort gespeichert. Melden Sie sich jetzt an und richten Sie die Zwei-Faktor-Authentifizierung ein.");event.target.classList.add("hidden");document.querySelector("#login-link").classList.remove("hidden")}catch(error){show(error.message,true)}finally{if(event.submitter)event.submitter.disabled=false}};
    return;
  }
  let challenge=null;
  const target=safeReturn(),login=document.querySelector("#login-form"),mfa=document.querySelector("#mfa-form");
  login.onsubmit=async event=>{event.preventDefault();const body=new FormData(login);try{event.submitter.disabled=true;const data=await post("/login",{email:body.get("email"),password:body.get("password")});challenge=data.challenge;login.classList.add("hidden");mfa.classList.remove("hidden");if(data.mfaSetupRequired){const qrSource=String(data.qrCodeDataUrl||"");if(!/^data:image\\/png;base64,[A-Za-z0-9+/=]+$/.test(qrSource))throw new Error("Der MFA-QR-Code konnte nicht sicher geladen werden.");const qr=document.querySelector("#qr");qr.src=qrSource;qr.alt="QR-Code zur Einrichtung von WB Tender in der Authenticator-App";qr.classList.remove("hidden");document.querySelector("#setup").classList.remove("hidden");document.querySelector("#secret").textContent=data.secret;show("Passwort bestätigt. Scannen Sie den QR-Code und geben Sie anschließend den sechsstelligen Code ein.")}else show("Passwort bestätigt. Bitte den zweiten Faktor eingeben.")}catch(error){show(error.message,true)}finally{if(event.submitter)event.submitter.disabled=false}};
  mfa.onsubmit=async event=>{event.preventDefault();const body=new FormData(mfa);try{event.submitter.disabled=true;const data=await post("/mfa",{challenge,code:body.get("code")});if(data.recoveryCodes){mfa.classList.add("hidden");document.querySelector("#recovery").classList.remove("hidden");document.querySelector("#codes").textContent=data.recoveryCodes.join("\\n");document.querySelector("#continue").onclick=()=>location.assign(target);show("Zwei-Faktor-Authentifizierung ist aktiv. Bewahren Sie die Einmal-Wiederherstellungscodes sicher auf.")}else location.assign(target)}catch(error){show(error.message,true)}finally{if(event.submitter)event.submitter.disabled=false}};
})();`;

function page(mode, uiBase) {
  const first = mode === "first";
  const firstForm = `<form><label>Neues Passwort<input name="password" type="password" minlength="14" maxlength="256" autocomplete="new-password" required></label><label>Passwort bestätigen<input name="confirmation" type="password" minlength="14" maxlength="256" autocomplete="new-password" required></label><button type="submit">Passwort sicher speichern</button></form><a id="login-link" class="button hidden" href="${uiBase}/login">Zur Anmeldung</a>`;
  const loginForm = `<form id="login-form"><label>E-Mail<input name="email" type="email" maxlength="254" autocomplete="username" value="${TARGET_EMAIL}" required></label><label>Passwort<input name="password" type="password" minlength="14" maxlength="256" autocomplete="current-password" required></label><button type="submit">Weiter</button></form><form id="mfa-form" class="hidden"><section id="setup" class="hidden"><p>Öffnen Sie Ihre Authenticator-App und scannen Sie diesen QR-Code. Eine Sitzung entsteht erst nach erfolgreicher Prüfung des sechsstelligen Codes.</p><img id="qr" class="qr hidden" width="256" height="256" alt=""><details><summary>Manuellen Einrichtungsschlüssel anzeigen</summary><p>Nur verwenden, wenn Ihre Authenticator-App keinen QR-Code scannen kann.</p><p id="secret" class="secret"></p></details></section><label>Sechsstelliger Authenticator- oder Wiederherstellungscode<input name="code" minlength="6" maxlength="64" inputmode="numeric" autocomplete="one-time-code" required></label><button type="submit">Sicher anmelden</button></form><section id="recovery" class="hidden"><h2>Wiederherstellungscodes</h2><p>Jeder Code ist nur einmal verwendbar.</p><pre id="codes" class="codes"></pre><button id="continue" type="button">Zum Tender-System</button></section>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${first ? "Erster Zugang" : "Anmeldung"} · WB Tender</title><link rel="stylesheet" href="${uiBase}/auth.css"><script src="${uiBase}/auth.js" defer></script></head><body data-mode="${mode}"><main class="panel"><h1>${first ? "Sicheren Zugang einrichten" : "WB Tender anmelden"}</h1><p class="muted">Geschützter Eigentümerzugang. Externe Angebotsabgaben bleiben technisch gesperrt.</p><p id="status" class="muted" aria-live="polite">${first ? "Legen Sie jetzt Ihr persönliches Passwort fest." : "Melden Sie sich mit Ihrem persönlichen Passwort an."}</p>${first ? firstForm : loginForm}</main></body></html>`;
}

export function registerOwnerAuth(app, { pool, authenticate, csrf, uiBase, apiBase, sessionPepper }) {
  const hmac = (value) => crypto.createHmac("sha256", sessionPepper).update(value).digest("hex");
  let expectedOrigin;
  try {
    const configured = new URL(String(process.env.PUBLIC_ORIGIN || ""));
    if (
      configured.protocol !== "https:" ||
      configured.username ||
      configured.password ||
      configured.pathname !== "/" ||
      configured.search ||
      configured.hash
    ) throw new Error("invalid_origin");
    expectedOrigin = configured.origin;
  } catch {
    throw new Error("public_origin_must_be_canonical_tls_origin");
  }
  encryptionKey();

  const origin = async (req, reply) => {
    if (req.headers.origin !== expectedOrigin)
      return reply.code(403).send({ error: "origin_rejected" });
  };
  const browserAuth = { config: { browserAuth: true }, preHandler: null };

  app.get("/login", async (_, reply) => reply.type("text/html").send(page("login", uiBase)));
  app.get("/first-login", async (_, reply) => reply.type("text/html").send(page("first", uiBase)));
  app.get("/auth.css", async (_, reply) => reply.type("text/css").send(authCss));
  app.get("/auth.js", async (_, reply) => reply.type("text/javascript").send(authJs));

  app.post("/api/auth/first-login", { preHandler: origin, config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req, reply) => {
    const { token: rawToken, password, confirmation } = req.body || {};
    if (typeof rawToken !== "string" || rawToken.length < 32 || rawToken.length > 512 || typeof password !== "string" || password.length < 14 || password.length > 256 || password !== confirmation || password.toLowerCase().includes("admin@wb-tender.de"))
      return reply.code(400).send({ error: "invalid_request", message: "Token ungültig oder Passwortanforderungen nicht erfüllt." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reset = (await client.query("SELECT t.user_id FROM iam.password_reset_tokens t JOIN iam.users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.used_at IS NULL AND t.expires_at>now() AND lower(u.email)=$2 AND u.active=true FOR UPDATE", [hmac(rawToken), TARGET_EMAIL])).rows[0];
      if (!reset) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "invalid_or_expired_token", message: "Der Einmallink ist ungültig oder abgelaufen." });
      }
      await client.query("UPDATE iam.users SET password_hash=$1,failed_attempts=0,locked_until=NULL,updated_at=now() WHERE id=$2", [await passwordHash(password), reset.user_id]);
      await client.query("UPDATE iam.password_reset_tokens SET used_at=now() WHERE token_hash=$1", [hmac(rawToken)]);
      await client.query("UPDATE iam.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [reset.user_id]);
      await client.query("INSERT INTO iam.password_reset_events(user_id,actor_id) VALUES($1,$1)", [reset.user_id]);
      await client.query("COMMIT");
      return { ok: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/auth/login", { preHandler: origin, config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const accountHash = sha256(email), networkHash = sha256(ipPrefix(req.ip));
    if (email !== TARGET_EMAIL || password.length < 14 || password.length > 256)
      return reply.code(401).send({ error: "invalid_credentials" });
    const failures = await pool.query("SELECT count(*)::int count FROM iam.login_attempts WHERE account_hash=$1 AND network_hash=$2 AND success=false AND created_at>now()-interval '15 minutes'", [accountHash, networkHash]);
    if (Number(failures.rows[0]?.count || 0) >= 8)
      return reply.code(429).send({ error: "rate_limit_exceeded" });
    const user = (await pool.query("SELECT * FROM iam.users WHERE lower(email)=$1", [email])).rows[0];
    const passwordOk = Boolean(user?.active && (!user.locked_until || new Date(user.locked_until) < new Date()) && await passwordVerify(user.password_hash, password));
    if (!passwordOk) {
      await pool.query("INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES($1,$2,false)", [accountHash, networkHash]);
      if (user) await pool.query("UPDATE iam.users SET failed_attempts=failed_attempts+1,locked_until=CASE WHEN failed_attempts>=4 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1", [user.id]);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const rawChallenge = token();
    let setupSecret = null;
    if (!user.mfa_secret_encrypted) setupSecret = generateTotpSecret();
    await pool.query("DELETE FROM iam.login_challenges WHERE expires_at<=now() OR used_at IS NOT NULL");
    await pool.query("INSERT INTO iam.login_challenges(challenge_hash,user_id,user_agent_hash,network_hash,mfa_setup_secret_encrypted,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')", [hmac(rawChallenge), user.id, sha256(req.headers["user-agent"] || ""), networkHash, setupSecret ? encryptSecret(setupSecret) : null]);
    return setupSecret
      ? { mfaRequired: true, mfaSetupRequired: true, challenge: rawChallenge, ...await mfaEnrollmentPayload(setupSecret, user.email) }
      : { mfaRequired: true, challenge: rawChallenge };
  });

  app.post("/api/auth/mfa", { preHandler: origin, config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const rawChallenge = String(req.body?.challenge || ""), supplied = String(req.body?.code || "").trim().toUpperCase();
    if (rawChallenge.length < 32 || rawChallenge.length > 512 || supplied.length < 6 || supplied.length > 64)
      return reply.code(400).send({ error: "invalid_request" });
    const client = await pool.connect();
    let recoveryCodes = null, user, networkHash;
    try {
      await client.query("BEGIN");
      const challenge = (await client.query("SELECT * FROM iam.login_challenges WHERE challenge_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE", [hmac(rawChallenge)])).rows[0];
      if (
        !challenge ||
        challenge.user_agent_hash !== sha256(req.headers["user-agent"] || "") ||
        challenge.network_hash !== sha256(ipPrefix(req.ip))
      ) {
        await client.query("ROLLBACK");
        return reply.code(401).send({ error: "invalid_or_expired_mfa" });
      }
      if (challenge.attempts >= 8) {
        await client.query("ROLLBACK");
        return reply.code(429).send({ error: "rate_limit_exceeded" });
      }
      await client.query("UPDATE iam.login_challenges SET attempts=attempts+1 WHERE challenge_hash=$1", [challenge.challenge_hash]);
      user = (await client.query("SELECT * FROM iam.users WHERE id=$1 AND active=true FOR UPDATE", [challenge.user_id])).rows[0];
      let valid = false;
      const encrypted = challenge.mfa_setup_secret_encrypted || user?.mfa_secret_encrypted;
      if (user && encrypted && /^\d{6}$/.test(supplied)) {
        const counter = matchingTotpCounter(decryptSecret(encrypted), supplied);
        if (counter !== null && (user.mfa_last_counter === null || BigInt(user.mfa_last_counter) < BigInt(counter))) {
          valid = true;
          await client.query("UPDATE iam.users SET mfa_last_counter=$1 WHERE id=$2", [counter, user.id]);
        }
      } else if (user && !challenge.mfa_setup_secret_encrypted) {
        valid = Boolean((await client.query("UPDATE iam.recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id", [user.id, hmac(supplied)])).rowCount);
      }
      if (!valid) {
        await client.query("INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES($1,$2,false)", [sha256(user?.email?.toLowerCase() || TARGET_EMAIL), challenge.network_hash]);
        await client.query("COMMIT");
        return reply.code(401).send({ error: "invalid_mfa" });
      }
      if (challenge.mfa_setup_secret_encrypted) {
        const enrolled = await client.query("UPDATE iam.users SET mfa_required=true,mfa_secret_encrypted=$1,updated_at=now() WHERE id=$2 AND mfa_secret_encrypted IS NULL RETURNING id", [challenge.mfa_setup_secret_encrypted, user.id]);
        if (!enrolled.rowCount) throw new Error("mfa_setup_changed");
        recoveryCodes = Array.from({ length: 10 }, () => `${crypto.randomBytes(4).toString("hex")}-${crypto.randomBytes(4).toString("hex")}`);
        await client.query("DELETE FROM iam.recovery_codes WHERE user_id=$1", [user.id]);
        for (const code of recoveryCodes)
          await client.query("INSERT INTO iam.recovery_codes(user_id,code_hash) VALUES($1,$2)", [user.id, hmac(code.toUpperCase())]);
      }
      const session = token(), csrfToken = token();
      await client.query("UPDATE iam.login_challenges SET used_at=now() WHERE challenge_hash=$1", [challenge.challenge_hash]);
      await client.query("UPDATE iam.users SET failed_attempts=0,locked_until=NULL WHERE id=$1", [user.id]);
      await client.query("INSERT INTO iam.login_attempts(account_hash,network_hash,success) VALUES($1,$2,true)", [sha256(user.email.toLowerCase()), challenge.network_hash]);
      await client.query("INSERT INTO iam.sessions(id_hash,user_id,csrf_hash,ip_prefix_hash,user_agent_hash,mfa_verified_at,expires_at) VALUES($1,$2,$3,$4,$5,now(),now()+interval '8 hours')", [hmac(session), user.id, hmac(csrfToken), challenge.network_hash, sha256(req.headers["user-agent"] || "")]);
      await client.query("COMMIT");
      reply.setCookie("wb_session", session, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 28800 });
      reply.setCookie("wb_csrf", csrfToken, { httpOnly: false, secure: true, sameSite: "strict", path: "/", maxAge: 28800 });
      return { ok: true, recoveryCodes };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/auth/me", { preHandler: authenticate }, async (req) => ({ email: req.identity.email, roles: req.identity.roles, permissions: req.identity.permissions, csrf: req.cookies.wb_csrf || "" }));
  app.post("/api/auth/logout", { preHandler: [authenticate, csrf, origin] }, async (req, reply) => {
    await pool.query("UPDATE iam.sessions SET revoked_at=now() WHERE id_hash=$1", [hmac(req.cookies.wb_session)]);
    reply.clearCookie("wb_session", { path: "/", secure: true, sameSite: "strict" });
    reply.clearCookie("wb_csrf", { path: "/", secure: true, sameSite: "strict" });
    return { ok: true };
  });

  return { browserAuth };
}
