import crypto from "node:crypto";

export const SAAS_IAM_ORIGIN = "https://saas.wb-holding.ag";
export const SAAS_LOGIN_PATH = "/api/saas/iam/login";
export const SAAS_CALLBACK_PATH = "/api/saas/iam/callback";
export const SAAS_CALLBACK_URL = `${SAAS_IAM_ORIGIN}${SAAS_CALLBACK_PATH}`;
export const SAAS_LOGIN_COOKIE = "__Secure-wb_saas_login";
export const SAAS_SESSION_COOKIE = "__Host-wb_saas_session";
export const SAAS_CSRF_COOKIE = "__Host-wb_saas_csrf";

const b64u = (value) => Buffer.from(value).toString("base64url");
const unb64u = (value) => Buffer.from(String(value), "base64url");
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();
const hash = (value, pepper) => crypto.createHmac("sha256", pepper).update(String(value)).digest("hex");
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};
const json = (value, code) => {
  try { return JSON.parse(value); } catch { throw new Error(code); }
};

export function normalizeSaasReturnTo(input, origin = SAAS_IAM_ORIGIN) {
  const raw = String(input || "/saas/");
  if (/[\r\n\\]/.test(raw) || raw.startsWith("//")) throw new Error("saas_redirect_invalid");
  let target;
  try { target = new URL(raw, origin); } catch { throw new Error("saas_redirect_invalid"); }
  if (target.origin !== origin || target.username || target.password) throw new Error("saas_redirect_origin_forbidden");
  if (!/^\/saas(?:\/|$)/.test(target.pathname) || target.pathname === SAAS_CALLBACK_PATH) throw new Error("saas_redirect_path_forbidden");
  return `${target.pathname}${target.search}${target.hash}`;
}

function endpoint(value, { allowInsecureLoopback = false } = {}) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:"))) throw new Error("oidc_endpoint_invalid");
  return url.toString();
}

function seal(payload, pepper) {
  const key = sha256(`saas-login-cookie:${pepper}`), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return `${b64u(iv)}.${b64u(encrypted)}.${b64u(cipher.getAuthTag())}`;
}

function unseal(value, pepper) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) throw new Error("oidc_login_cookie_invalid");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", sha256(`saas-login-cookie:${pepper}`), unb64u(parts[0]));
    decipher.setAuthTag(unb64u(parts[2]));
    return json(Buffer.concat([decipher.update(unb64u(parts[1])), decipher.final()]).toString("utf8"), "oidc_login_cookie_invalid");
  } catch { throw new Error("oidc_login_cookie_invalid"); }
}

export class MemoryLoginStateStore {
  constructor() { this.items = new Map(); }
  async create(stateHash, expiresAt) { this.items.set(stateHash, expiresAt.getTime()); }
  async consume(stateHash, now = new Date()) {
    const expires = this.items.get(stateHash); this.items.delete(stateHash);
    return Boolean(expires && expires > now.getTime());
  }
}

export class MemorySaasSessionStore {
  constructor() { this.items = new Map(); }
  async create(tokenHash, record) { this.items.set(tokenHash, structuredClone(record)); }
  async get(tokenHash, now = new Date()) {
    const record = this.items.get(tokenHash);
    return record && new Date(record.expiresAt) > now && !record.revokedAt ? structuredClone(record) : null;
  }
  async revoke(tokenHash) { const item = this.items.get(tokenHash); if (item) item.revokedAt = new Date().toISOString(); }
}

export class PostgresLoginStateStore {
  constructor(pool) { this.pool = pool; }
  async create(stateHash, expiresAt) { await this.pool.query("INSERT INTO saas.iam_login_states(state_hash,expires_at) VALUES($1,$2)", [stateHash, expiresAt]); }
  async consume(stateHash) { return Boolean((await this.pool.query("DELETE FROM saas.iam_login_states WHERE state_hash=$1 AND expires_at>now() RETURNING state_hash", [stateHash])).rowCount); }
}

export class PostgresSaasSessionStore {
  constructor(pool) { this.pool = pool; }
  async create(tokenHash, record) {
    const created = await this.pool.query("SELECT saas.create_iam_session($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) created", [tokenHash, record.csrfHash, record.userId, record.tenantId, record.issuer, record.subject, record.email, record.userAgentHash, record.mfaVerifiedAt, record.emailVerifiedAt, record.expiresAt]);
    if (created.rows[0]?.created !== true) throw new Error("saas_iam_session_binding_invalid");
  }
  async get(tokenHash) { return (await this.pool.query(`SELECT token_hash,csrf_hash AS "csrfHash",user_id AS "userId",tenant_id AS "tenantId",issuer,subject,email,user_agent_hash AS "userAgentHash",mfa_verified_at AS "mfaVerifiedAt",email_verified_at AS "emailVerifiedAt",expires_at AS "expiresAt",revoked_at AS "revokedAt" FROM saas.get_iam_session($1)`, [tokenHash])).rows[0] || null; }
  async revoke(tokenHash) { await this.pool.query("SELECT saas.revoke_iam_session($1)", [tokenHash]); }
}

async function responseJson(response, code) {
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error(code);
  if (!response.ok) throw new Error(code);
  return json(text, code);
}

export class SaasOidcClient {
  constructor({ issuer, authorizationEndpoint, tokenEndpoint, jwksUri, clientId, clientSecret = "", sessionPepper, stateStore = new MemoryLoginStateStore(), sessionStore = new MemorySaasSessionStore(), resolveIdentity, publicOrigin = SAAS_IAM_ORIGIN, callbackUrl = SAAS_CALLBACK_URL, fetchImpl = fetch, now = () => new Date(), allowInsecureTestProvider = false }) {
    if (!clientId || !resolveIdentity || !sessionPepper || sessionPepper.length < 32) throw new Error("saas_oidc_configuration_incomplete");
    if (publicOrigin !== SAAS_IAM_ORIGIN || callbackUrl !== SAAS_CALLBACK_URL) throw new Error("saas_oidc_public_url_invalid");
    this.issuer = endpoint(issuer, { allowInsecureLoopback: allowInsecureTestProvider }).replace(/\/$/, "");
    this.authorizationEndpoint = endpoint(authorizationEndpoint, { allowInsecureLoopback: allowInsecureTestProvider });
    this.tokenEndpoint = endpoint(tokenEndpoint, { allowInsecureLoopback: allowInsecureTestProvider });
    this.jwksUri = endpoint(jwksUri, { allowInsecureLoopback: allowInsecureTestProvider });
    this.clientId = clientId; this.clientSecret = clientSecret; this.sessionPepper = sessionPepper;
    this.stateStore = stateStore; this.sessionStore = sessionStore; this.resolveIdentity = resolveIdentity;
    this.publicOrigin = publicOrigin; this.callbackUrl = callbackUrl;
    this.fetch = fetchImpl; this.now = now; this.jwks = null;
  }

  async begin({ returnTo = "/saas/", userAgent = "" } = {}) {
    const state = random(), nonce = random(), verifier = random(64), createdAt = this.now();
    const safeReturnTo = normalizeSaasReturnTo(returnTo, this.publicOrigin);
    await this.stateStore.create(hash(state, this.sessionPepper), new Date(createdAt.getTime() + 300_000));
    const loginCookie = seal({ state, nonce, verifier, returnTo: safeReturnTo, userAgentHash: hash(userAgent, this.sessionPepper), createdAt: createdAt.toISOString() }, this.sessionPepper);
    const url = new URL(this.authorizationEndpoint);
    url.search = new URLSearchParams({ client_id: this.clientId, response_type: "code", scope: "openid email", redirect_uri: this.callbackUrl, state, nonce, code_challenge: b64u(sha256(verifier)), code_challenge_method: "S256", prompt: "login", max_age: "300" });
    return { authorizationUrl: url.toString(), loginCookie };
  }

  async keys() {
    if (this.jwks && this.jwks.expires > this.now().getTime()) return this.jwks.keys;
    const result = await responseJson(await this.fetch(this.jwksUri, { headers: { accept: "application/json" }, redirect: "error" }), "oidc_jwks_failed");
    if (!Array.isArray(result.keys)) throw new Error("oidc_jwks_invalid");
    this.jwks = { keys: result.keys, expires: this.now().getTime() + 300_000 };
    return result.keys;
  }

  async validateIdToken(idToken, expectedNonce) {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3 || parts.some((part) => part.length > 16_384)) throw new Error("oidc_id_token_invalid");
    const header = json(unb64u(parts[0]).toString("utf8"), "oidc_id_token_invalid");
    const claims = json(unb64u(parts[1]).toString("utf8"), "oidc_id_token_invalid");
    if (header.alg !== "RS256" || !header.kid) throw new Error("oidc_id_token_algorithm_invalid");
    const jwk = (await this.keys()).find((item) => item.kid === header.kid && item.kty === "RSA" && (!item.use || item.use === "sig"));
    if (!jwk) throw new Error("oidc_signing_key_not_found");
    let valid = false;
    try { valid = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), unb64u(parts[2])); } catch {}
    if (!valid) throw new Error("oidc_id_token_signature_invalid");
    const now = Math.floor(this.now().getTime() / 1000), audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.issuer || !audiences.includes(this.clientId) || (audiences.length > 1 && claims.azp !== this.clientId)) throw new Error("oidc_id_token_audience_invalid");
    if (!Number.isInteger(claims.exp) || claims.exp <= now || !Number.isInteger(claims.iat) || claims.iat > now + 60 || !Number.isInteger(claims.auth_time) || claims.auth_time > now + 60 || claims.auth_time < now - 600) throw new Error("oidc_id_token_time_invalid");
    if (!safeEqual(claims.nonce, expectedNonce)) throw new Error("oidc_nonce_invalid");
    if (claims.email_verified !== true || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(claims.email || ""))) throw new Error("oidc_email_not_verified");
    const amr = Array.isArray(claims.amr) ? claims.amr.map((value) => String(value).toLowerCase()) : [];
    if (!amr.includes("mfa")) throw new Error("oidc_mfa_required");
    if (!claims.sub || String(claims.sub).length > 255) throw new Error("oidc_subject_invalid");
    return claims;
  }

  async complete({ code, state, loginCookie, userAgent = "" }) {
    if (!/^[A-Za-z0-9._~-]{8,2048}$/.test(String(code || "")) || !/^[A-Za-z0-9_-]{32,256}$/.test(String(state || ""))) throw new Error("oidc_callback_invalid");
    const login = unseal(loginCookie, this.sessionPepper), age = this.now().getTime() - new Date(login.createdAt).getTime();
    if (age < -60_000 || age > 300_000 || !safeEqual(state, login.state) || !safeEqual(hash(userAgent, this.sessionPepper), login.userAgentHash)) throw new Error("oidc_callback_binding_invalid");
    if (!await this.stateStore.consume(hash(state, this.sessionPepper), this.now())) throw new Error("oidc_state_invalid_or_replayed");
    const body = new URLSearchParams({ grant_type: "authorization_code", code: String(code), redirect_uri: this.callbackUrl, client_id: this.clientId, code_verifier: login.verifier });
    const headers = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
    if (this.clientSecret) headers.authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    const token = await responseJson(await this.fetch(this.tokenEndpoint, { method: "POST", headers, body, redirect: "error" }), "oidc_token_exchange_failed");
    if (token.token_type && String(token.token_type).toLowerCase() !== "bearer") throw new Error("oidc_token_response_invalid");
    const claims = await this.validateIdToken(token.id_token, login.nonce);
    const identity = await this.resolveIdentity({ issuer: claims.iss, subject: String(claims.sub), email: String(claims.email).toLowerCase(), claims });
    if (!identity?.userId || !identity?.tenantId || identity.emailVerified !== true || identity.mfaRequired !== true) throw new Error("saas_identity_not_eligible");
    const sessionToken = random(48), csrfToken = random(32), expiresAt = new Date(this.now().getTime() + 8 * 60 * 60 * 1000);
    await this.sessionStore.create(hash(sessionToken, this.sessionPepper), { ...identity, issuer: claims.iss, subject: String(claims.sub), email: String(claims.email).toLowerCase(), csrfHash: hash(csrfToken, this.sessionPepper), userAgentHash: hash(userAgent, this.sessionPepper), mfaVerifiedAt: this.now().toISOString(), emailVerifiedAt: this.now().toISOString(), expiresAt: expiresAt.toISOString(), revokedAt: null });
    return { sessionToken, csrfToken, returnTo: normalizeSaasReturnTo(login.returnTo, this.publicOrigin), expiresAt };
  }

  async authenticate({ sessionToken, userAgent = "" }) {
    if (!sessionToken) return null;
    const record = await this.sessionStore.get(hash(sessionToken, this.sessionPepper), this.now());
    if (!record || !safeEqual(record.userAgentHash, hash(userAgent, this.sessionPepper)) || !record.mfaVerifiedAt || !record.emailVerifiedAt) return null;
    const identity = await this.resolveIdentity({ issuer: record.issuer, subject: record.subject, email: record.email });
    if (!identity?.userId || !identity?.tenantId || identity.emailVerified !== true || identity.mfaRequired !== true) return null;
    return { ...record, ...identity, csrfHash: record.csrfHash };
  }

  async revoke(sessionToken) { if (sessionToken) await this.sessionStore.revoke(hash(sessionToken, this.sessionPepper)); }
  validCsrf(record, value) { return Boolean(record?.csrfHash && value && safeEqual(record.csrfHash, hash(value, this.sessionPepper))); }
}

export function registerSaasIamRoutes(app, { client, enabled = false }) {
  const guard = async (_, reply) => { if (!enabled) return reply.code(404).send({ error: "saas_disabled" }); };
  app.get(SAAS_LOGIN_PATH, { preHandler: guard }, async (req, reply) => {
    try {
      const result = await client.begin({ returnTo: req.query?.returnTo, userAgent: req.headers["user-agent"] || "" });
      reply.setCookie(SAAS_LOGIN_COOKIE, result.loginCookie, { httpOnly: true, secure: true, sameSite: "lax", path: SAAS_CALLBACK_PATH, maxAge: 300 });
      return reply.redirect(result.authorizationUrl);
    } catch { return reply.code(400).send({ error: "saas_login_request_invalid" }); }
  });
  app.get(SAAS_CALLBACK_PATH, { preHandler: guard }, async (req, reply) => {
    try {
      if (req.query?.error) throw new Error("oidc_provider_error");
      const result = await client.complete({ code: req.query?.code, state: req.query?.state, loginCookie: req.cookies[SAAS_LOGIN_COOKIE], userAgent: req.headers["user-agent"] || "" });
      reply.clearCookie(SAAS_LOGIN_COOKIE, { path: SAAS_CALLBACK_PATH });
      reply.setCookie(SAAS_SESSION_COOKIE, result.sessionToken, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 28800 });
      reply.setCookie(SAAS_CSRF_COOKIE, result.csrfToken, { httpOnly: false, secure: true, sameSite: "strict", path: "/", maxAge: 28800 });
      return reply.redirect(result.returnTo);
    } catch {
      reply.clearCookie(SAAS_LOGIN_COOKIE, { path: SAAS_CALLBACK_PATH });
      return reply.code(401).send({ error: "saas_authentication_failed" });
    }
  });
  const authenticate = async (req, reply) => {
    const identity = await client.authenticate({ sessionToken: req.cookies?.[SAAS_SESSION_COOKIE], userAgent: req.headers["user-agent"] || "" });
    if (!identity) return reply.code(401).send({ error: "saas_authentication_required" });
    req.identity = identity;
  };
  const csrf = async (req, reply) => {
    if (!client.validCsrf(req.identity, req.headers["x-csrf-token"])) return reply.code(403).send({ error: "csrf_invalid" });
  };
  app.post("/api/saas/iam/logout", { preHandler: [guard, authenticate, csrf] }, async (req, reply) => {
    await client.revoke(req.cookies?.[SAAS_SESSION_COOKIE]);
    reply.clearCookie(SAAS_SESSION_COOKIE, { path: "/" }); reply.clearCookie(SAAS_CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });
  return { authenticate, csrf };
}
