import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, statement_timeout: 10000 });
const requestQueries = new AsyncLocalStorage();

export async function query(text, values = []) {
  const scoped = requestQueries.getStore();
  return (scoped?.client || pool).query(text, values);
}

export async function beginTenantQueryContext(req, { actorUserId }) {
  if (req.tenantQueryContext) return req.tenantQueryContext;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_user_id',$1,true),set_config('app.tenant_id','',true)", [actorUserId || ""]);
    const context = {
      client,
      finished: false,
      async setTenant(tenantId) {
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
        requestQueries.enterWith({ client });
      },
    };
    req.tenantQueryContext = context;
    return context;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw error;
  }
}

export async function finishTenantQueryContext(req, successful) {
  const context = req.tenantQueryContext;
  if (!context || context.finished) return;
  context.finished = true;
  try { await context.client.query(successful ? "COMMIT" : "ROLLBACK"); }
  finally { context.client.release(); }
}
