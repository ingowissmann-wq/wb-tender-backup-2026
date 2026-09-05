import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerAdminAuth } from "../platform/admin-auth.mjs";

const options = (overrides = {}) => ({
  pool: { query: async () => ({ rows: [], rowCount: 0 }) },
  sessionPepper: "p".repeat(48),
  fieldEncryptionKey: Buffer.alloc(32, 3),
  secureCookies: false,
  ...overrides,
});

const productionProxyPath = (externalPath) => {
  const url = new URL(externalPath, "https://tender.example.invalid");
  if (url.pathname.startsWith("/admin/ausschreibungen/")) {
    return `${url.pathname.slice("/admin/ausschreibungen".length) || "/"}${url.search}`;
  }
  if (url.pathname === "/api/tender" || url.pathname.startsWith("/api/tender/")) {
    return `/api${url.pathname.slice("/api/tender".length)}${url.search}`;
  }
  return `${url.pathname}${url.search}`;
};

test("production stripped and direct Tender proxy paths reach the same configured auth surface", async () => {
  const app = Fastify();
  registerAdminAuth(app, options());
  await app.ready();
  try {
    const publicLogin = "/admin/ausschreibungen/login?returnTo=%2Fadmin%2Fausschreibungen%2Ftasks";
    const proxied = await app.inject({ method: "GET", url: productionProxyPath(publicLogin) });
    const direct = await app.inject({ method: "GET", url: publicLogin });
    for (const response of [proxied, direct]) {
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /href="\/admin\/ausschreibungen\/login\.css"/);
      assert.match(response.body, /src="\/admin\/ausschreibungen\/login\.js"/);
    }
    assert.equal((await app.inject({ method: "GET", url: productionProxyPath("/admin/ausschreibungen/login.js") })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/admin/ausschreibungen/login.css" })).statusCode, 200);
    const js = (await app.inject({ method: "GET", url: "/admin/ausschreibungen/login.js" })).body;
    assert.match(js, /const UI="\/admin\/ausschreibungen",API="\/api\/tender"/);
    assert.match(js, /fetch\(API\+'\/iam\/login'/);
    assert.equal((await app.inject({ method: "POST", url: productionProxyPath("/api/tender/iam/login"), payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/tender/iam/login", payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/admin/login" })).statusCode, 404, "Tender must not claim the WB Admin login route");
  } finally {
    await app.close();
  }
});

test("unstripped rehearsal API configuration is executable, not schematic", async () => {
  const app = Fastify();
  registerAdminAuth(app, options({ apiBase: "/api" }));
  await app.ready();
  try {
    const js = (await app.inject({ method: "GET", url: "/admin/ausschreibungen/login.js" })).body;
    assert.match(js, /API="\/api"/);
    assert.equal((await app.inject({ method: "POST", url: "/api/iam/login", payload: {} })).statusCode, 400);
  } finally {
    await app.close();
  }
});

test("auth registration fails closed on malformed base paths", () => {
  for (const invalid of ["/admin/ausschreibungen/", "/admin//ausschreibungen", "https://example.invalid/admin/ausschreibungen"]) {
    const app = Fastify();
    assert.throws(() => registerAdminAuth(app, options({ uiBase: invalid })), /tender_ui_base_invalid/);
  }
  for (const conflicting of ["/admin", "/admin/login", "/admin/login/tender"]) {
    const app = Fastify();
    assert.throws(() => registerAdminAuth(app, options({ uiBase: conflicting })), /tender_ui_base_conflicts_with_wb_admin/);
  }
});
