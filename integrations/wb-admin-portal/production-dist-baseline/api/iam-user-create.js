import { z } from "zod";
import { pool } from "./db.js";
import { passwordHash } from "./security.js";
const createUserSchema = z.object({
    email: z.string().trim().email().max(254),
    password: z.string().min(12).max(1024),
    roles: z.array(z.string().min(1).max(100)).max(50).default([]),
    active: z.boolean().default(true)
});
const defaultDependencies = { connect: () => pool.connect(), hashPassword: passwordHash };
function response(reply, status, error, message, correlationId) {
    return reply.code(status).send({ error, message, correlationId });
}
export async function createIamUser(req, reply, dependencies = defaultDependencies) {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success)
        return response(reply, 400, "invalid_request", "Die Eingaben sind unvollständig oder ungültig.", req.id);
    const email = parsed.data.email.toLowerCase(), roleCodes = [...new Set(parsed.data.roles)];
    let client, transactionStarted = false;
    try {
        const passwordHashValue = await dependencies.hashPassword(parsed.data.password);
        client = await dependencies.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const roles = await client.query("SELECT id,code FROM iam.roles WHERE code=ANY($1::text[]) FOR SHARE", [roleCodes]);
        const foundCodes = new Set(roles.rows.map(role => role.code));
        if (roleCodes.some(code => !foundCodes.has(code))) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return response(reply, 400, "unknown_role", "Mindestens eine ausgewählte Rolle ist unbekannt oder unzulässig.", req.id);
        }
        const requiresMfa = roleCodes.includes("administrator");
        const user = await client.query("INSERT INTO iam.users(email,password_hash,active,mfa_required) VALUES($1,$2,$3,$4) RETURNING id,email,active,mfa_required", [email, passwordHashValue, parsed.data.active, requiresMfa]);
        if (roleCodes.length) {
            const assigned = await client.query("INSERT INTO iam.user_roles(user_id,role_id) SELECT $1,id FROM iam.roles WHERE code=ANY($2::text[]) RETURNING role_id", [user.rows[0].id, roleCodes]);
            if (assigned.rowCount !== roleCodes.length)
                throw Object.assign(new Error("role_assignment_incomplete"), { code: "role_assignment_incomplete" });
        }
        await client.query("INSERT INTO audit.events(actor_id,action,object_type,object_id,changed_fields,request_id) VALUES($1,$2,$3,$4,$5,$6)", [req.auth?.userId || null, "user_create", "user", user.rows[0].id, ["email", "active", "roles", "mfa_required"], req.id]);
        await client.query("COMMIT");
        transactionStarted = false;
        return reply.code(201).send(user.rows[0]);
    }
    catch (error) {
        if (client && transactionStarted)
            await client.query("ROLLBACK").catch(() => undefined);
        const databaseError = error;
        if (databaseError.code === "23505" && databaseError.constraint === "users_email_key")
            return response(reply, 409, "user_already_exists", "Ein Benutzer mit dieser E-Mail-Adresse existiert bereits.", req.id);
        req.log?.error({ err: { name: databaseError.name, code: databaseError.code }, correlationId: req.id }, "IAM user creation failed");
        return response(reply, 500, "internal_server_error", "Der Benutzer konnte nicht angelegt werden. Es wurden keine Änderungen gespeichert.", req.id);
    }
    finally {
        client?.release();
    }
}
