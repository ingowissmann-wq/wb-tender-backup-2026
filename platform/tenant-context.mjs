const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validTenantId(value) {
  return UUID.test(String(value || ""));
}

export async function withTenantContext(pool, context, operation) {
  if (!validTenantId(context?.tenantId)) throw new Error("tenant_context_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [String(context.tenantId)]);
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [validTenantId(context.actorUserId) ? String(context.actorUserId) : ""]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function requireTenantContext(req, reply) {
  const tenantId = req.identity?.saas?.tenant_id;
  if (!validTenantId(tenantId)) return reply.code(403).send({ error: "tenant_context_required" });
  req.tenant = Object.freeze({ id: String(tenantId), actorUserId: String(req.identity.userId) });
}
