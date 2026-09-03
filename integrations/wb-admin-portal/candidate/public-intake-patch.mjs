import fs from "node:fs";

const target = process.argv[2];
if (!target) throw new Error("usage: node public-intake-patch.mjs /path/to/server.js");

let source = fs.readFileSync(target, "utf8");
const marker = "WB_PUBLIC_INTAKE_V1";
if (source.includes(marker)) process.exit(0);

const needle = 'app.get("/api/public/v1/:type", async (req, reply) => {';
const occurrences = source.split(needle).length - 1;
if (occurrences !== 1) throw new Error(`public_route_insertion_point_not_unique:${occurrences}`);

const routes = `// WB_PUBLIC_INTAKE_V1
const publicApplicationSchema = z.object({
    firstName: z.string().trim().min(2).max(100),
    lastName: z.string().trim().min(2).max(100),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().max(50).optional().default(""),
    jobInterest: z.string().trim().max(200).optional().default(""),
    message: z.string().trim().max(4000).optional().default(""),
    website: z.string().max(200).optional().default(""),
    privacyAccepted: z.literal(true),
});
const publicContactSchema = z.object({
    name: z.string().trim().min(2).max(200),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().max(50).optional().default(""),
    company: z.string().trim().max(200).optional().default(""),
    serviceInterest: z.string().trim().max(200).optional().default(""),
    message: z.string().trim().min(10).max(4000),
    website: z.string().max(200).optional().default(""),
    privacyAccepted: z.literal(true),
});
async function publicTenantId() {
    const result = await query("SELECT tenant_id FROM iam.users WHERE lower(email)=lower($1) AND tenant_id IS NOT NULL LIMIT 1", ["admin@wb-holding.ag"]);
    return result.rows[0]?.tenant_id || null;
}
app.post("/api/public/v1/applications", {
    config: { rateLimit: { max: 8, timeWindow: "1 hour" } },
}, async (req, reply) => {
    const parsed = publicApplicationSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(422).send({ error: "validation_failed", message: "Bitte prüfen Sie Ihre Angaben." });
    if (parsed.data.website)
        return reply.code(202).send({ ok: true });
    const id = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    const item = careerUpsert("applications", id, {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        email: parsed.data.email.toLowerCase(),
        phone: parsed.data.phone,
        jobInterest: parsed.data.jobInterest,
        jobTitleSnapshot: parsed.data.jobInterest,
        message: parsed.data.message,
        status: "Neu",
        source: "wb_website",
        submittedAt,
        applicationDate: submittedAt,
        privacyAcceptedAt: submittedAt,
        notes: [],
        communications: [],
        auditTrail: [{ action: "Bewerbung eingegangen", at: submittedAt, actor: "wb_website" }],
    }, "published");
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ ok: true, item: { _id: item._id, status: item.status } });
});
app.post("/api/public/v1/contact-submissions", {
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
}, async (req, reply) => {
    const parsed = publicContactSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.code(422).send({ error: "validation_failed", message: "Bitte prüfen Sie Ihre Angaben." });
    if (parsed.data.website)
        return reply.code(202).send({ ok: true });
    const tenantId = await publicTenantId();
    if (!tenantId)
        return reply.code(503).send({ error: "tenant_context_unavailable", correlationId: req.id });
    const id = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    const data = {
        name: parsed.data.name,
        email: parsed.data.email.toLowerCase(),
        phone: parsed.data.phone,
        company: parsed.data.company,
        serviceInterest: parsed.data.serviceInterest,
        message: parsed.data.message,
        submittedAt,
        privacyAcceptedAt: submittedAt,
        source: "wb_website",
    };
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
        const inserted = await client.query(\`INSERT INTO app.resources(
            id,tenant_id,domain,resource_type,title,status,data,source_system,external_id
        ) VALUES($1,$2,'cms','contact_submissions',$3,'draft',$4,'wb_website',$1::text)
        RETURNING id\`, [id, tenantId, \`Website-Anfrage – \${data.name}\`, data]);
        await client.query(\`INSERT INTO audit.events(
            tenant_id,action,object_type,object_id,changed_fields,request_id,metadata
        ) VALUES($1,'public_contact_received','contact_submission',$2,$3,$4,$5)\`,
        [tenantId, inserted.rows[0].id, ["name","email","message"], req.id, { source: "wb_website" }]);
        await client.query("COMMIT");
    }
    catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
    finally {
        client.release();
    }
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ ok: true, item: { _id: id, status: "received" } });
});

`;

fs.writeFileSync(target, source.replace(needle, routes + needle));
