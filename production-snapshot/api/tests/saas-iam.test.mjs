import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import {
  MemoryLoginStateStore, MemorySaasSessionStore, SaasOidcClient,
  SAAS_CALLBACK_URL, SAAS_CSRF_COOKIE, SAAS_LOGIN_COOKIE, SAAS_SESSION_COOKIE,
  normalizeSaasReturnTo, registerSaasIamRoutes,
} from "../platform/saas-iam.mjs";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
Object.assign(jwk, { kid: "isolated-key", use: "sig", alg: "RS256" });
const encoded = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims, key = privateKey) => {
  const signing = `${encoded({ alg: "RS256", typ: "JWT", kid: "isolated-key" })}.${encoded(claims)}`;
  return `${signing}.${crypto.sign("RSA-SHA256", Buffer.from(signing), key).toString("base64url")}`;
};

let expectedChallenge = "", expectedNonce = "", issuer = "";
const server = http.createServer(async (req, res) => {
  if (req.url === "/jwks") {
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); return;
  }
  if (req.url === "/token" && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body), challenge = crypto.createHash("sha256").update(form.get("code_verifier") || "").digest("base64url");
    if (challenge !== expectedChallenge || form.get("redirect_uri") !== SAAS_CALLBACK_URL || form.get("grant_type") !== "authorization_code") { res.statusCode = 400; res.end("{}"); return; }
    const code = form.get("code"), now = Math.floor(Date.now() / 1000);
    const amr = code === "code-nomfa" ? ["pwd"] : code === "code-otponly" ? ["pwd", "otp", "totp"] : code === "code-acronly" ? ["pwd"] : ["pwd", "mfa"];
    const claims = { iss: issuer, sub: "subject-1", aud: code === "code-badaudience" ? "foreign-client" : "saas-client", iat: now, auth_time: now, exp: now + 300, nonce: code === "code-badnonce" ? "wrong" : expectedNonce, email: "owner@example.invalid", email_verified: code !== "code-unverified", amr, acr: code === "code-acronly" ? "urn:wb:mfa" : undefined };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ token_type: "Bearer", id_token: jwt(claims) })); return;
  }
  res.statusCode = 404; res.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
issuer = `http://127.0.0.1:${server.address().port}`;

const makeClient = () => new SaasOidcClient({
  issuer, authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`,
  clientId: "saas-client", clientSecret: "isolated-client-secret", sessionPepper: "isolated-session-pepper-with-at-least-32-characters",
  stateStore: new MemoryLoginStateStore(), sessionStore: new MemorySaasSessionStore(), allowInsecureTestProvider: true,
  resolveIdentity: async ({ issuer: claimIssuer, subject, email }) => claimIssuer === issuer && subject === "subject-1" && email === "owner@example.invalid"
    ? { userId: "22222222-2222-4222-8222-222222222222", tenantId: "11111111-1111-4111-8111-111111111111", emailVerified: true, mfaRequired: true, saas: { tenant_id: "11111111-1111-4111-8111-111111111111", role: "OWNER" } }
    : null,
});

async function flow(client, code = "code-good", userAgent = "isolated-browser") {
  const begin = await client.begin({ returnTo: "/saas/app/control?tab=members", userAgent });
  const url = new URL(begin.authorizationUrl);
  expectedChallenge = url.searchParams.get("code_challenge"); expectedNonce = url.searchParams.get("nonce");
  return { begin, url, result: await client.complete({ code, state: url.searchParams.get("state"), loginCookie: begin.loginCookie, userAgent }) };
}

test("SaaS login uses exact callback, state, nonce and PKCE S256 without leaking verifier", async () => {
  const client = makeClient(), begin = await client.begin({ returnTo: "/saas/app/control", userAgent: "browser-a" }), url = new URL(begin.authorizationUrl);
  assert.equal(url.searchParams.get("redirect_uri"), "https://saas.wb-holding.ag/api/saas/iam/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("state").length >= 32); assert.ok(url.searchParams.get("nonce").length >= 32);
  assert.equal(begin.loginCookie.includes(url.searchParams.get("nonce")), false);
  assert.equal(begin.authorizationUrl.includes("code_verifier"), false);
});

test("successful callback creates only a dedicated MFA and email-verified SaaS session", async () => {
  const client = makeClient(), completed = await flow(client);
  assert.equal(completed.result.returnTo, "/saas/app/control?tab=members");
  const identity = await client.authenticate({ sessionToken: completed.result.sessionToken, userAgent: "isolated-browser" });
  assert.equal(identity.emailVerified, true); assert.equal(identity.mfaRequired, true); assert.ok(identity.mfaVerifiedAt); assert.ok(identity.emailVerifiedAt);
  assert.equal(await client.authenticate({ sessionToken: completed.result.sessionToken, userAgent: "foreign-browser" }), null);
  assert.notEqual(SAAS_SESSION_COOKIE, "wb_session"); assert.notEqual(SAAS_CSRF_COOKIE, "wb_csrf"); assert.notEqual(SAAS_LOGIN_COOKIE, "wb_session");
});

test("state is one-time and callback remains bound to the initiating user agent", async () => {
  const client = makeClient(), begin = await client.begin({ userAgent: "browser-a" }), url = new URL(begin.authorizationUrl);
  expectedChallenge = url.searchParams.get("code_challenge"); expectedNonce = url.searchParams.get("nonce");
  await assert.rejects(client.complete({ code: "code-good", state: url.searchParams.get("state"), loginCookie: begin.loginCookie, userAgent: "browser-b" }), /callback_binding/);
  await client.complete({ code: "code-good", state: url.searchParams.get("state"), loginCookie: begin.loginCookie, userAgent: "browser-a" });
  await assert.rejects(client.complete({ code: "code-good", state: url.searchParams.get("state"), loginCookie: begin.loginCookie, userAgent: "browser-a" }), /state_invalid_or_replayed/);
});

test("only Auth0 amr=mfa is accepted; OTP-only, ACR-only, unverified email, audience, and nonce failures close access", async () => {
  for (const [code, pattern] of [["code-nomfa", /mfa_required/], ["code-otponly", /mfa_required/], ["code-acronly", /mfa_required/], ["code-unverified", /email_not_verified/], ["code-badaudience", /audience_invalid/], ["code-badnonce", /nonce_invalid/]]) {
    const client = makeClient(), begin = await client.begin({ userAgent: "browser" }), url = new URL(begin.authorizationUrl);
    expectedChallenge = url.searchParams.get("code_challenge"); expectedNonce = url.searchParams.get("nonce");
    await assert.rejects(client.complete({ code, state: url.searchParams.get("state"), loginCookie: begin.loginCookie, userAgent: "browser" }), pattern);
  }
});

test("foreign origins, scheme-relative URLs, callback targets, and non-SaaS paths are rejected", () => {
  assert.equal(normalizeSaasReturnTo("https://saas.wb-holding.ag/saas/app/control?x=1"), "/saas/app/control?x=1");
  for (const target of ["https://evil.invalid/saas/", "//evil.invalid/saas/", "/admin/", "/api/saas/iam/callback", "/saas\\@evil.invalid"]) assert.throws(() => normalizeSaasReturnTo(target), /redirect/);
});

test("route cookies are host-separated, secure, and callback-scoped", async () => {
  const routes = new Map(), app = {};
  for (const method of ["get", "post"]) app[method] = (path, _options, handler) => routes.set(`${method}:${path}`, handler);
  const fake = {
    async begin() { return { authorizationUrl: `${issuer}/authorize`, loginCookie: "opaque-login" }; },
    async complete() { return { sessionToken: "opaque-session", csrfToken: "opaque-csrf", returnTo: "/saas/", expiresAt: new Date() }; },
    async authenticate() { return null; }, validCsrf() { return false; }, async revoke() {},
  };
  registerSaasIamRoutes(app, { client: fake, enabled: true });
  const cookies = [], reply = { setCookie(name, value, options) { cookies.push({ name, value, options }); return this; }, clearCookie() { return this; }, redirect(value) { this.location = value; return this; }, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
  await routes.get("get:/api/saas/iam/login")({ query: {}, headers: { "user-agent": "test" } }, reply);
  assert.deepEqual(cookies[0], { name: SAAS_LOGIN_COOKIE, value: "opaque-login", options: { httpOnly: true, secure: true, sameSite: "lax", path: "/api/saas/iam/callback", maxAge: 300 } });
  cookies.length = 0;
  await routes.get("get:/api/saas/iam/callback")({ query: { code: "code-good", state: "state" }, cookies: { [SAAS_LOGIN_COOKIE]: "opaque-login" }, headers: { "user-agent": "test" } }, reply);
  assert.equal(cookies.find((item) => item.name === SAAS_SESSION_COOKIE).options.sameSite, "strict");
  assert.equal(cookies.find((item) => item.name === SAAS_SESSION_COOKIE).options.httpOnly, true);
  assert.equal(cookies.find((item) => item.name === SAAS_CSRF_COOKIE).options.httpOnly, false);
  assert.ok(cookies.every((item) => item.options.secure === true && item.options.path === "/"));
});

test("database and server contracts keep SaaS IAM separate and fail closed", async () => {
  const migration = await readFile(new URL("../migrations/086_saas_iam_oidc.sql", import.meta.url), "utf8");
  const serverSource = await readFile(new URL("../platform/server.mjs", import.meta.url), "utf8");
  const routes = await readFile(new URL("../platform/saas-platform.mjs", import.meta.url), "utf8");
  assert.match(migration, /saas\.iam_login_states/); assert.match(migration, /saas\.iam_sessions/); assert.match(migration, /REVOKE ALL .* FROM PUBLIC/);
  assert.match(serverSource, /SAAS_IAM_CLIENT_SECRET_FILE/); assert.match(serverSource, /SAAS_IAM_SESSION_PEPPER_FILE/);
  assert.match(serverSource, /saas\.resolve_iam_subject_binding/); assert.doesNotMatch(serverSource, /FROM saas\.iam_subject_bindings b JOIN/);
  assert.match(serverSource, /authenticate: saasAuthenticate/); assert.doesNotMatch(serverSource, /registerTenantPortalRoutes\(app, \{ pool, authenticate: auth/);
  assert.match(routes, /loadInternalIdentity, saasCsrf/); assert.match(routes, /checkout.*loadInternalIdentity, saasCsrf/);
});

test("IAM subject bindings use forced RLS and a narrow runtime resolver", async () => {
  const migration = await readFile(new URL("../migrations/087_saas_iam_binding_rls.sql", import.meta.url), "utf8");
  assert.match(migration, /ALTER TABLE saas\.iam_subject_bindings FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /REVOKE ALL ON saas\.iam_subject_bindings FROM saas_runtime/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION saas\.resolve_iam_subject_binding/);
});

test("IAM sessions use forced RLS and narrow create/get/revoke functions", async () => {
  const migration = await readFile(new URL("../migrations/088_saas_iam_session_rls.sql", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../platform/saas-iam.mjs", import.meta.url), "utf8");
  assert.match(migration, /ALTER TABLE saas\.iam_sessions FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON saas\.iam_sessions FROM saas_runtime/);
  for (const name of ["create_iam_session", "get_iam_session", "revoke_iam_session"]) {
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION saas\\.${name}`));
    assert.match(runtime, new RegExp(`saas\\.${name}`));
  }
  assert.doesNotMatch(runtime, /INSERT INTO saas\.iam_sessions|UPDATE saas\.iam_sessions/);
});

test.after(() => server.close());
