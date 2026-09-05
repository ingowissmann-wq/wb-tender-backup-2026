import { AsyncLocalStorage } from "node:async_hooks";

const SETTINGS_RESET =
  "RESET app.company_ids; RESET app.tenant_ids; RESET app.configuration_tenant_id; RESET app.actor_user_id";

export function createRequestScopedPool(rawPool) {
  const storage = new AsyncLocalStorage();

  const state = () => storage.getStore();
  const clientFor = async (context = state()) => {
    if (!context) return null;
    if (context.released) throw new Error("request_database_context_released");
    if (!context.clientPromise) context.clientPromise = rawPool.connect();
    return context.clientPromise;
  };
  const releaseContext = async (context, destroy = false) => {
    if (!context?.clientPromise || context.released) return;
    context.released = true;
    const client = await context.clientPromise;
    let discard = destroy;
    if (!discard) {
      try {
        await client.query(SETTINGS_RESET);
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  };
  const scopedClient = (client) => new Proxy(client, {
    get(target, property) {
      if (property === "release") return () => {};
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const pool = {
    async query(...args) {
      const context = state();
      if (!context) return rawPool.query(...args);
      return (await clientFor(context)).query(...args);
    },
    async connect() {
      const context = state();
      if (!context) return rawPool.connect();
      return scopedClient(await clientFor(context));
    },
    end: (...args) => rawPool.end(...args),
  };

  return {
    pool,
    runRequest(callback) {
      return storage.run({ clientPromise: null, released: false, identityBound: false }, callback);
    },
    async bindIdentity(identity) {
      const context = state();
      if (!context) throw new Error("request_database_context_required");
      if (context.identityBound) return;
      const client = await clientFor(context);
      try {
        const isAdmin = identity?.permissions?.includes("tender.admin") === true;
        const requestedCompanies = [...new Set((identity?.companyIds || []).map(String))].sort();
        let companyIds = requestedCompanies;
        let tenantIds;
        if (isAdmin) {
          const scope = await client.query(
            "SELECT tenant_id,company_id FROM tender.resolve_background_scope() ORDER BY tenant_id,company_id",
          );
          companyIds = [...new Set(scope.rows.map((row) => String(row.company_id)))].sort();
          tenantIds = [...new Set(scope.rows.map((row) => String(row.tenant_id)))].sort();
        } else if (companyIds.length) {
          const scope = await client.query(
            "SELECT tenant_id FROM tender.resolve_runtime_tenants($1::uuid[]) ORDER BY tenant_id",
            [companyIds],
          );
          tenantIds = [...new Set(scope.rows.map((row) => String(row.tenant_id)))].sort();
          if (!tenantIds.length) throw new Error("runtime_tenant_scope_unresolved");
        } else {
          tenantIds = [];
        }
        await client.query(
          "SELECT set_config('app.company_ids',$1,false),set_config('app.tenant_ids',$2,false),set_config('app.configuration_tenant_id',$3,false),set_config('app.actor_user_id',$4,false)",
          [companyIds.join(","), tenantIds.join(","), tenantIds.length === 1 ? tenantIds[0] : "", String(identity?.userId || "")],
        );
        context.identityBound = true;
      } catch (error) {
        await releaseContext(context, true);
        throw error;
      }
    },
    async releaseRequest() {
      await releaseContext(state());
    },
  };
}
