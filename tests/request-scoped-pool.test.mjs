import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { createRequestScopedPool } from "../platform/request-scoped-pool.mjs";

test("request database context binds RLS scope and never leaks pooled settings", async () => {
  const events = [];
  let sequence = 0;
  const rawPool = {
    async connect() {
      const id = ++sequence;
      return {
        async query(text, values = []) {
          events.push({ id, text, values });
          if (text.includes("resolve_runtime_tenants")) return { rows: [{ tenant_id: values[0][0].replace("company", "tenant") }] };
          return { rows: [{ id }] };
        },
        release(destroy) { events.push({ id, release: true, destroy: Boolean(destroy) }); },
      };
    },
  };
  const database = createRequestScopedPool(rawPool);
  const execute = (companyId) => database.runRequest(async () => {
    await database.bindIdentity({ userId: "actor", companyIds: [companyId], permissions: ["tender.view_assigned"] });
    const first = await database.pool.query("SELECT 1");
    const connected = await database.pool.connect();
    const second = await connected.query("SELECT 2");
    connected.release();
    await database.releaseRequest();
    return [first.rows[0].id, second.rows[0].id];
  });
  const [a, b] = await Promise.all([execute("company-a"), execute("company-b")]);
  assert.equal(a[0], a[1]);
  assert.equal(b[0], b[1]);
  assert.notEqual(a[0], b[0]);
  assert.equal(events.filter((event) => event.release).length, 2);
  assert.equal(events.filter((event) => event.release && event.destroy).length, 0);
  const settings = events.filter((event) => String(event.text).includes("set_config('app.company_ids'"));
  assert.deepEqual(settings.map((event) => event.values[0]).sort(), ["company-a", "company-b"]);
  assert.deepEqual(settings.map((event) => event.values[2]).sort(), ["tenant-a", "tenant-b"]);
  assert.equal(events.filter((event) => String(event.text).includes("RESET app.company_ids")).length, 2);
  assert.equal(events.filter((event) => String(event.text).includes("RESET app.tenant_id;")).length, 2);
});

test("request database context resolves all background scope only for tender admin", async () => {
  const queries = [];
  const rawPool = { async connect() { return { async query(text, values = []) {
    queries.push({ text, values });
    if (text.includes("resolve_background_scope")) return { rows: [{ tenant_id: "tenant-a", company_id: "company-a" }] };
    return { rows: [] };
  }, release() {} }; } };
  const database = createRequestScopedPool(rawPool);
  await database.runRequest(async () => {
    await database.bindIdentity({ userId: "actor", companyIds: [], permissions: ["tender.admin"] });
    await database.releaseRequest();
  });
  assert.equal(queries.filter(({ text }) => text.includes("resolve_background_scope")).length, 1);
  const settings = queries.find(({ text }) => text.includes("set_config('app.company_ids'"));
  assert.deepEqual(settings.values.slice(0, 2), ["company-a", "tenant-a"]);
});

test("unbound company scope fails closed", async () => {
  let destroyed = false;
  const rawPool = { async connect() { return { async query(text) {
    if (text.includes("resolve_runtime_tenants")) return { rows: [] };
    return { rows: [] };
  }, release(value) { destroyed = Boolean(value); } }; } };
  const database = createRequestScopedPool(rawPool);
  await assert.rejects(
    database.runRequest(() => database.bindIdentity({ userId: "actor", companyIds: ["company-a"], permissions: [] })),
    /runtime_tenant_scope_unresolved/,
  );
  await database.runRequest(async () => {});
  assert.equal(destroyed, true);
});

test("Fastify request lifecycle retains and releases the async database context", async (t) => {
  const events = [];
  let sequence = 0;
  const rawPool = { async connect() { const id = ++sequence; return {
    async query(text, values = []) {
      events.push({ id, text, values });
      if (text.includes("resolve_runtime_tenants")) return { rows: [{ tenant_id: `tenant-${values[0][0]}` }] };
      return { rows: [{ id }] };
    },
    release(destroy) { events.push({ id, release: true, destroy: Boolean(destroy) }); },
  }; } };
  const database = createRequestScopedPool(rawPool);
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  app.addHook("onRequest", (_request, _reply, done) => database.runRequest(done));
  app.addHook("onResponse", async () => database.releaseRequest());
  app.addHook("onError", async () => database.releaseRequest());
  app.get("/:company", async (request) => {
    await database.bindIdentity({ userId: "actor", companyIds: [request.params.company], permissions: [] });
    await new Promise((resolve) => setTimeout(resolve, request.params.company === "a" ? 15 : 1));
    return (await database.pool.query("SELECT route_scope")).rows[0];
  });
  const [a, b] = await Promise.all([app.inject("/a"), app.inject("/b")]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.notEqual(a.json().id, b.json().id);
  assert.equal(events.filter((event) => event.release).length, 2);
  assert.equal(events.filter((event) => String(event.text).includes("RESET app.company_ids")).length, 2);
});
