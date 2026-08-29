import { AsyncLocalStorage } from "node:async_hooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedScope(value = {}) {
  const tenantIds = [...new Set((value.tenantIds || []).map(String).filter((id) => UUID.test(id)))].sort();
  const companyIds = [...new Set((value.companyIds || []).map(String).filter((id) => UUID.test(id)))].sort();
  return Object.freeze({
    tenantIds,
    companyIds,
    actorUserId: UUID.test(String(value.actorUserId || "")) ? String(value.actorUserId) : "",
    permissions: [...new Set((value.permissions || []).map(String).filter(Boolean))].sort(),
  });
}

async function installScope(client, scope, local) {
  const values = normalizedScope(scope);
  await client.query("SELECT set_config('app.tenant_ids',$1,$6),set_config('app.tenant_id',$2,$6),set_config('app.company_ids',$3,$6),set_config('app.actor_user_id',$4,$6),set_config('app.permissions',$5,$6)", [
    values.tenantIds.join(","), values.tenantIds.length===1?values.tenantIds[0]:"", values.companyIds.join(","), values.actorUserId, values.permissions.join(","), local,
  ]);
}

export function createRequestScopedPool(rawPool) {
  const storage = new AsyncLocalStorage();
  const current = () => storage.getStore()?.scope || normalizedScope();
  const pool = {
    async query(text, params) {
      const client = await rawPool.connect();
      try {
        await client.query("BEGIN");
        await installScope(client, current(), true);
        const result = await client.query(text, params);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async connect() {
      const client = await rawPool.connect();
      await installScope(client, current(), false);
      const release = client.release.bind(client);
      let released = false;
      client.release = async () => {
        if (released) return;
        released = true;
        try {
          await client.query("RESET app.tenant_ids; RESET app.tenant_id; RESET app.company_ids; RESET app.actor_user_id; RESET app.permissions");
        } finally { release(); }
      };
      return client;
    },
    end: (...args) => rawPool.end(...args),
    on: (...args) => rawPool.on(...args),
    get totalCount() { return rawPool.totalCount; },
    get idleCount() { return rawPool.idleCount; },
    get waitingCount() { return rawPool.waitingCount; },
  };
  return {
    pool,
    rawPool,
    runRequest(callback) { return storage.run({ scope: normalizedScope() }, callback); },
    enterRequest() { storage.enterWith({ scope: normalizedScope() }); },
    setRequestScope(scope) {
      const store = storage.getStore();
      if (!store) throw new Error("request_database_scope_missing");
      store.scope = normalizedScope(scope);
      return store.scope;
    },
    withScope(scope, callback) { return storage.run({ scope: normalizedScope(scope) }, callback); },
  };
}

export function createFixedScopedPool(rawPool, scope) {
  const scoped = createRequestScopedPool(rawPool);
  const fixed = normalizedScope(scope);
  return {
    pool: {
      query: (text, params) => scoped.withScope(fixed, () => scoped.pool.query(text, params)),
      connect: () => scoped.withScope(fixed, () => scoped.pool.connect()),
      end: (...args) => rawPool.end(...args),
      on: (...args) => rawPool.on(...args),
      get totalCount() { return rawPool.totalCount; },
      get idleCount() { return rawPool.idleCount; },
      get waitingCount() { return rawPool.waitingCount; },
    },
    scope: fixed,
  };
}

export async function loadBackgroundScope(pool) {
  const rows = (await pool.query("SELECT tenant_id,company_id FROM tender.resolve_background_scope() ORDER BY tenant_id,company_id")).rows;
  const scope = normalizedScope({
    tenantIds: rows.map((row) => row.tenant_id),
    companyIds: rows.map((row) => row.company_id),
    permissions: ["tender.background"],
  });
  if (!scope.tenantIds.length || !scope.companyIds.length) throw new Error("background_database_scope_empty");
  return scope;
}

export { normalizedScope };
