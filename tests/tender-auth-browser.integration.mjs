import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { chromium } from "playwright";
import { encryptTotpSecret, hashTenderPassword, registerAdminAuth, totpFor } from "../platform/admin-auth.mjs";

const password = `B-${crypto.randomBytes(30).toString("base64url")}!4x`;
const totpSecret = "JBSWY3DPEHPK3PXP", fieldKey = crypto.randomBytes(32), pepper = crypto.randomBytes(48).toString("base64url");
const user = { id: crypto.randomUUID(), email: "browser-proxy-canary@example.invalid", password_hash: await hashTenderPassword(password), active: true, mfa_required: true, mfa_secret_encrypted: encryptTotpSecret(totpSecret, fieldKey), locked_until: null, mfa_last_counter: null };
let challengeRow;
const query = async (sql, parameters = []) => {
  if (sql.includes("count(*)::int count FROM iam.login_attempts")) return { rows: [{ count: 0 }] };
  if (sql.includes("FROM iam.users WHERE lower(email)")) return { rows: [user] };
  if (sql.startsWith("DELETE FROM iam.tender_login_challenges WHERE expires_at")) { challengeRow = undefined; return { rows: [] }; }
  if (sql.startsWith("INSERT INTO iam.tender_login_challenges")) { challengeRow = { hash: parameters[0], user_id: parameters[1], user_agent_hash: parameters[2], network_hash: parameters[3] }; return { rows: [] }; }
  if (sql.startsWith("DELETE FROM iam.tender_login_challenges WHERE challenge_hash")) {
    if (!challengeRow || challengeRow.hash !== parameters[0] || challengeRow.user_agent_hash !== parameters[1]) return { rows: [] };
    const row = challengeRow; challengeRow = undefined; return { rows: [{ user_id: row.user_id, network_hash: row.network_hash }] };
  }
  if (sql.includes("FROM iam.users WHERE id=$1 AND active FOR UPDATE")) return { rows: [user] };
  if (sql.startsWith("UPDATE iam.users SET mfa_last_counter")) { user.mfa_last_counter = parameters[1]; return { rows: [] }; }
  if (/^(?:BEGIN|COMMIT|ROLLBACK|INSERT INTO iam\.sessions|INSERT INTO iam\.login_attempts)/.test(sql)) return { rows: [] };
  throw new Error("unexpected_browser_fixture_query");
};
const pool = { query, connect: async () => ({ query, release() {} }) };
const app = Fastify();
await app.register(cookie);
registerAdminAuth(app, { pool, sessionPepper: pepper, fieldEncryptionKey: fieldKey, secureCookies: false, uiBase: "/admin/ausschreibungen", apiBase: "/api/tender" });
app.get("/", async (_, reply) => reply.type("text/html").send("<!doctype html><title>Tender root</title><h1>Authenticated Tender root</h1>"));
await app.listen({ host: "127.0.0.1", port: 0 });
const internal = new URL(app.listeningOrigin);
const observed = [];
const proxy = http.createServer((request, response) => {
  observed.push(request.url);
  const incoming = new URL(request.url, "http://proxy.invalid");
  let forwardedPath = `${incoming.pathname}${incoming.search}`;
  if (incoming.pathname.startsWith("/admin/ausschreibungen/")) forwardedPath = `${incoming.pathname.slice("/admin/ausschreibungen".length)}${incoming.search}`;
  if (incoming.pathname.startsWith("/api/tender/")) forwardedPath = `/api${incoming.pathname.slice("/api/tender".length)}${incoming.search}`;
  const forwarded = http.request({ hostname: internal.hostname, port: internal.port, method: request.method, path: forwardedPath, headers: request.headers }, (upstream) => {
    response.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(response);
  });
  request.pipe(forwarded);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address(), base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const returnTo = "/admin/ausschreibungen/?journey=proxy";
  await page.goto(`${base}/admin/ausschreibungen/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByLabel("E-Mail").fill(user.email);
  await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Weiter" }).click();
  await page.getByLabel("Authenticator-Code").fill(totpFor(totpSecret));
  await Promise.all([
    page.waitForURL(`${base}${returnTo}`),
    page.getByRole("button", { name: "Sicher anmelden" }).click(),
  ]);
  assert.equal(await page.getByRole("heading", { name: "Authenticated Tender root" }).isVisible(), true);
  assert.ok(observed.some((value) => value.startsWith("/admin/ausschreibungen/login.js")));
  assert.ok(observed.some((value) => value.startsWith("/api/tender/iam/login")));
  assert.ok(observed.some((value) => value.startsWith("/api/tender/iam/mfa")));
  assert.equal(observed.some((value) => value.startsWith("/admin/login") || value.startsWith("/api/admin/")), false);
  console.log(JSON.stringify({ passed: true, realChromium: true, realFastify: true, strippingProxy: true, passwordMfaReturnTo: true, noManualReload: true, configuredApiPrefix: true, wbAdminUntouched: true }));
} finally {
  await browser.close();
  await new Promise((resolve) => proxy.close(resolve));
  await app.close();
}
