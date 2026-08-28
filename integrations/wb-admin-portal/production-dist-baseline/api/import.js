import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pool, query } from "./db.js";
const cmsRoot = process.env.RC5_CMS || "/source/rc5-cms";
const runtimeRoot = process.env.RC5_RUNTIME || "/source/rc5-runtime";
const fileRoot = process.env.PRIVATE_FILE_ROOT || "/data/private";
const mapping = { services: "services", blogposts: "blogposts", Jobangebote: "jobs", locations: "locations", industries: "industries", teammembers: "team", employees: "team" };
const report = { startedAt: new Date().toISOString(), cms: {}, application: {}, files: [], errors: [] };
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
function records(value) { if (Array.isArray(value))
    return value; if (Array.isArray(value?.records))
    return value.records; if (Array.isArray(value?.items))
    return value.items; if (Array.isArray(value?.data))
    return value.data; return []; }
function title(row) { return String(row.title || row.name || row.jobTitle || row.position || row.slug || row._id || row.id); }
try {
    for (const [source, target] of Object.entries(mapping)) {
        const filename = path.join(cmsRoot, `${source}.json`);
        const raw = await fs.readFile(filename);
        const parsed = JSON.parse(raw.toString());
        const rows = records(parsed);
        for (const row of rows) {
            const external = String(row._id || row.id);
            const sourceHash = hash(JSON.stringify(row));
            await query(`INSERT INTO app.resources(domain,resource_type,title,status,data,raw_source,source_system,external_id,source_hash)
   VALUES('cms',$1,$2,'published',$3,$3,'rc5',$4,$5)
   ON CONFLICT(source_system,resource_type,external_id) DO UPDATE SET title=excluded.title,data=excluded.data,raw_source=excluded.raw_source,source_hash=excluded.source_hash,updated_at=now()`, [target, title(row), row, external, sourceHash]);
        }
        report.cms[target] = (report.cms[target] || 0) + rows.length;
    }
    const appFiles = (await fs.readdir(path.join(runtimeRoot, "applications"))).filter(x => x.endsWith(".json")).sort();
    const genuine = appFiles.find(x => x.includes("08-01-45-861Z")) || appFiles[0];
    if (!genuine)
        throw new Error("no RC5 application found");
    const application = JSON.parse(await fs.readFile(path.join(runtimeRoot, "applications", genuine), "utf8"));
    const appHash = hash(JSON.stringify(application));
    const ar = await query(`INSERT INTO app.resources(domain,resource_type,title,status,data,raw_source,source_system,external_id,source_hash)
 VALUES('recruiting','applications',$1,'new',$2,$2,'rc5',$3,$4)
 ON CONFLICT(source_system,resource_type,external_id) DO UPDATE SET data=excluded.data,raw_source=excluded.raw_source,source_hash=excluded.source_hash,updated_at=now() RETURNING id`, ["RC5 Bewerbung", application, application.id, appHash]);
    const applicationId = ar.rows[0].id;
    report.application = { externalId: application.id, sourceHash: appHash, count: 1 };
    const sourceDir = path.join(runtimeRoot, "uploads", application.id);
    await fs.mkdir(fileRoot, { recursive: true });
    for (const attachment of application.attachments || []) {
        const src = path.join(sourceDir, attachment.storedName);
        const bytes = await fs.readFile(src);
        const actual = hash(bytes);
        if (actual !== attachment.sha256 || bytes.length !== attachment.sizeBytes)
            throw new Error(`attachment integrity mismatch: ${attachment.field}`);
        const found = await query("SELECT id,storage_name FROM files.objects WHERE sha256=$1 AND size_bytes=$2 AND protection_class='private'", [actual, bytes.length]);
        let fr = found;
        if (!found.rowCount) {
            const storageName = `${actual}-${crypto.randomUUID()}`;
            await fs.writeFile(path.join(fileRoot, storageName), bytes, { mode: 0o600 });
            fr = await query(`INSERT INTO files.objects(storage_name,original_name,mime_type,size_bytes,sha256,protection_class,verified)
     VALUES($1,$2,$3,$4,$5,'private',true) RETURNING id,storage_name`, [storageName, attachment.originalName, attachment.mimeType, bytes.length, actual]);
        }
        await query("INSERT INTO recruiting.application_files(application_id,file_id,field_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [applicationId, fr.rows[0].id, attachment.field]);
        report.files.push({ field: attachment.field, sizeBytes: bytes.length, sha256: actual, verified: true });
    }
    await query("INSERT INTO audit.events(action,object_type,object_id,metadata) VALUES('import','migration',$1,$2)", [application.id, { cms: report.cms, applicationCount: 1, fileCount: report.files.length }]);
    report.completedAt = new Date().toISOString();
    report.status = "ok";
    await fs.mkdir("/app/runtime/reports", { recursive: true });
    await fs.writeFile("/app/runtime/reports/import-report.json", JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, cms: report.cms, applicationCount: 1, fileCount: report.files.length, hashesVerified: report.files.every((x) => x.verified) }));
}
catch (error) {
    report.status = "failed";
    report.errors.push(error.message);
    console.error(JSON.stringify(report));
    process.exitCode = 1;
}
finally {
    await pool.end();
}
