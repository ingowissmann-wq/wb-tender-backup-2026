import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { pool, query } from "./db.js";
const MAX_IMAGE_BYTES = 10_000_000;
const deliveryPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const signaturePattern = /^(?:sha256=)?([a-f0-9]{64})$/i;
const eventSchema = z.object({
    event: z.enum(["article.published", "article.updated", "test"]).optional(),
    type: z.enum(["article.published", "article.updated", "test"]).optional(),
    eventType: z.enum(["article.published", "article.updated", "test"]).optional(),
    article: z.record(z.unknown()).optional(),
    data: z.record(z.unknown()).optional(),
    payload: z.record(z.unknown()).optional()
}).passthrough();
const articleSchema = z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(200)),
    title: z.string().min(1).max(300),
    slug: z.string().max(240).optional().nullable(),
    shortDescription: z.string().max(2000).optional().nullable(),
    metaDescription: z.string().max(500).optional().nullable(),
    seoTitle: z.string().max(300).optional().nullable(),
    focusKeyword: z.string().max(300).optional().nullable(),
    category: z.string().max(300).optional().nullable(),
    author: z.string().max(300).optional().nullable(),
    content_html: z.string().max(2_000_000).optional().nullable(),
    content_markdown: z.string().max(2_000_000).optional().nullable(),
    heroImageUrl: z.string().url().max(2048).optional().nullable(),
    heroImageAlt: z.string().max(500).optional().nullable(),
    heroImageTitle: z.string().max(500).optional().nullable(),
    infographicImageUrl: z.string().url().max(2048).optional().nullable(),
    infographicImageAlt: z.string().max(500).optional().nullable(),
    infographicImageTitle: z.string().max(500).optional().nullable(),
    images: z.array(z.union([
        z.string().url().max(2048),
        z.object({
            url: z.string().url().max(2048),
            alt: z.string().max(500).optional().nullable(),
            title: z.string().max(500).optional().nullable()
        }).passthrough()
    ])).max(4).optional().nullable(),
    keywords: z.union([z.string(), z.array(z.string().max(150)).max(100)]).optional().nullable(),
    metaKeywords: z.union([z.string(), z.array(z.string().max(150)).max(100)]).optional().nullable(),
    wordpressTags: z.union([z.string(), z.array(z.string().max(150)).max(100)]).optional().nullable(),
    faqSchema: z.unknown().optional().nullable(),
    languageCode: z.string().max(20).optional().nullable(),
    publishedAt: z.string().datetime({ offset: true }).optional().nullable(),
    updatedAt: z.string().datetime({ offset: true }).optional().nullable()
}).passthrough();
const text = (value) => String(value ?? "").trim();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const constantEqual = (a, b) => {
    const left = crypto.createHash("sha256").update(a).digest(), right = crypto.createHash("sha256").update(b).digest();
    return crypto.timingSafeEqual(left, right);
};
const slugify = (value) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "artikel";
const arrayValue = (value) => Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? text(value).split(",").map(x => x.trim()).filter(Boolean) : [];
class JsonPayloadError extends Error {
}
function normalizeJson(value) {
    const seen = new WeakSet();
    const serialized = JSON.stringify(value ?? {}, (_key, item) => {
        if (typeof item === "bigint")
            return item.toString();
        if (typeof item === "string" && item.includes("\u0000"))
            throw new JsonPayloadError("json_string_invalid");
        if (item && typeof item === "object") {
            if (seen.has(item))
                throw new JsonPayloadError("json_cycle_invalid");
            seen.add(item);
        }
        return item;
    });
    if (serialized === undefined)
        throw new JsonPayloadError("json_value_invalid");
    try {
        return JSON.parse(serialized);
    }
    catch {
        throw new JsonPayloadError("json_value_invalid");
    }
}
function jsonb(value) { return JSON.stringify(normalizeJson(value)); }
function structuredData(value) {
    if (value === undefined || value === null || value === "")
        return {};
    if (typeof value === "string") {
        try {
            return normalizeJson(JSON.parse(value));
        }
        catch {
            throw new JsonPayloadError("faq_schema_invalid");
        }
    }
    if (Array.isArray(value))
        return normalizeJson(value.map(item => {
            if (typeof item !== "string")
                return item;
            try {
                return JSON.parse(item);
            }
            catch {
                throw new JsonPayloadError("faq_schema_invalid");
            }
        }));
    return normalizeJson(value);
}
function detectedImage(bytes) {
    if (bytes.subarray(0, 3).toString("hex") === "ffd8ff")
        return "image/jpeg";
    if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a")
        return "image/png";
    if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
        return "image/webp";
    return null;
}
function publicIp(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split(".").map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127);
    }
    if (net.isIPv6(address)) {
        const normalized = address.toLowerCase();
        return !(normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168."));
    }
    return false;
}
async function checkedUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password)
        throw new Error("image_url_forbidden");
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => !publicIp(item.address)))
        throw new Error("image_host_forbidden");
    return { url, address: addresses[0] };
}
async function fetchImage(value, redirects = 0) {
    if (redirects > 3)
        throw new Error("image_redirect_limit");
    const { url, address } = await checkedUrl(value);
    return new Promise((resolve, reject) => {
        const request = https.get({
            protocol: "https:", hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`,
            servername: url.hostname, headers: { accept: "image/jpeg,image/png,image/webp", "user-agent": "WB-AutoSEO-Importer/1.0" },
            lookup: ((_hostname, options, callback) => options?.all
                ? callback(null, [address])
                : callback(null, address.address, address.family))
        }, response => {
            const status = response.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
                response.resume();
                const location = response.headers.location;
                if (!location)
                    return reject(new Error("image_redirect_invalid"));
                return fetchImage(new URL(location, url).toString(), redirects + 1).then(resolve, reject);
            }
            if (status !== 200) {
                response.resume();
                return reject(new Error("image_download_failed"));
            }
            const declared = Number(response.headers["content-length"] || 0);
            if (declared > MAX_IMAGE_BYTES) {
                response.resume();
                return reject(new Error("image_too_large"));
            }
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => { size += chunk.length; if (size > MAX_IMAGE_BYTES) {
                request.destroy(new Error("image_too_large"));
                return;
            } chunks.push(chunk); });
            response.on("end", () => {
                const bytes = Buffer.concat(chunks), mimeType = detectedImage(bytes), header = text(response.headers["content-type"]).split(";")[0].toLowerCase();
                if (!mimeType || header !== mimeType)
                    return reject(new Error("image_signature_invalid"));
                resolve({ bytes, mimeType, finalUrl: url.toString() });
            });
        });
        request.setTimeout(10_000, () => request.destroy(new Error("image_timeout")));
        request.on("error", reject);
    });
}
function sanitized(value) {
    return sanitizeHtml(value, {
        allowedTags: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "strong", "b", "em", "i", "u", "s", "a", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "figure", "figcaption", "img", "hr", "code", "pre", "span", "div"],
        allowedAttributes: {
            a: ["href", "title", "target", "rel"], img: ["src", "alt", "title", "width", "height", "loading"], th: ["colspan", "rowspan", "scope"], td: ["colspan", "rowspan"], "*": ["id", "class"]
        },
        allowedSchemes: ["https", "mailto", "tel"], allowedSchemesByTag: { img: ["https"] }, allowProtocolRelative: false,
        transformTags: { a: (_tag, attrs) => ({ tagName: "a", attribs: { ...attrs, ...(attrs.target === "_blank" ? { rel: "noopener noreferrer" } : {}) } }) }
    });
}
async function importImage(urlValue, privateRoot) {
    if (!urlValue)
        return;
    const downloaded = await fetchImage(urlValue), sha256 = digest(downloaded.bytes);
    const client = await pool.connect();
    let created = false, storageName, previousDeletedAt, target, previousReferenceCount = 0;
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`autoseo-media:${sha256}:${downloaded.bytes.length}`]);
        let file = await client.query("SELECT id,storage_name,deleted_at FROM files.objects WHERE sha256=$1 AND size_bytes=$2 AND protection_class='public' FOR UPDATE", [sha256, downloaded.bytes.length]);
        if (file.rowCount) {
            const references = await client.query("SELECT count(*)::int count FROM app.resource_files WHERE file_id=$1", [file.rows[0].id]);
            previousReferenceCount = Number(references.rows[0]?.count || 0);
            const existingTarget = path.resolve(privateRoot, file.rows[0].storage_name);
            if (path.basename(file.rows[0].storage_name) !== file.rows[0].storage_name || !existingTarget.startsWith(path.resolve(privateRoot) + path.sep))
                throw new Error("image_storage_path_invalid");
            const existingBytes = await fsp.readFile(existingTarget).catch(() => undefined);
            if (!existingBytes || existingBytes.length !== downloaded.bytes.length || digest(existingBytes) !== sha256)
                throw new Error("image_stored_binary_invalid");
            if (file.rows[0].deleted_at) {
                previousDeletedAt = new Date(file.rows[0].deleted_at).toISOString();
                file = await client.query("UPDATE files.objects SET deleted_at=NULL,missing_binary=false,verified=true WHERE id=$1 RETURNING id,storage_name", [file.rows[0].id]);
            }
        }
        else {
            const extension = downloaded.mimeType === "image/jpeg" ? "jpg" : downloaded.mimeType === "image/png" ? "png" : "webp";
            storageName = `autoseo-${sha256}-${crypto.randomUUID()}.${extension}`;
            target = path.resolve(privateRoot, storageName);
            if (path.basename(storageName) !== storageName || !target.startsWith(path.resolve(privateRoot) + path.sep))
                throw new Error("image_storage_path_invalid");
            await fsp.writeFile(target, downloaded.bytes, { mode: 0o600, flag: "wx" });
            file = await client.query(`INSERT INTO files.objects(storage_name,original_name,mime_type,size_bytes,sha256,protection_class,verified)
    VALUES($1,$2,$3,$4,$5,'public',true) RETURNING id,storage_name`, [storageName, `autoseo-${sha256.slice(0, 16)}.${extension}`, downloaded.mimeType, downloaded.bytes.length, sha256]);
            created = true;
        }
        await client.query("COMMIT");
        return { fileId: file.rows[0].id, url: `/cms-media/${file.rows[0].id}`, sourceUrl: downloaded.finalUrl, sha256, mimeType: downloaded.mimeType, size: downloaded.bytes.length, created, storageName, previousDeletedAt, previousReferenceCount };
    }
    catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (target)
            await fsp.unlink(target).catch(() => undefined);
        throw error;
    }
    finally {
        client.release();
    }
}
async function secret() {
    const secretPath = process.env.AUTOSEO_SECRET_FILE || "/run/secrets/autoseo_webhook";
    const parsed = z.object({ token: z.string().min(32), hmacSecret: z.string().min(32).optional() }).parse(JSON.parse(await fsp.readFile(secretPath, "utf8")));
    return parsed;
}
export async function validateAutoSeoConfiguration() {
    await secret();
    const databasePath = process.env.CAREER_DATABASE_PATH || "/career-data/wb-cms.sqlite";
    await fsp.access(databasePath, fs.constants.R_OK | fs.constants.W_OK);
    const origin = new URL(process.env.AUTOSEO_PUBLIC_SITE_ORIGIN || "https://www.wb-holding.ag");
    if (!["http:", "https:"].includes(origin.protocol))
        throw new Error("autoseo_public_origin_invalid");
}
async function uniqueSlug(client, requested, resourceId, externalId) {
    const base = slugify(requested), suffix = digest(externalId).slice(0, 8);
    let candidate = base, index = 0;
    while (true) {
        const found = await client.query("SELECT id FROM app.resources WHERE resource_type='blogposts' AND deleted_at IS NULL AND lower(data->>'slug')=$1 AND ($2::uuid IS NULL OR id<>$2)", [candidate, resourceId || null]);
        if (!found.rowCount)
            return candidate;
        candidate = `${base.slice(0, Math.max(1, 170 - suffix.length))}-${suffix}${index ? `-${index}` : ""}`;
        index += 1;
    }
}
function publicItem(row) {
    const data = row.data || {};
    const publicId = data.slug || data.autoseoId || row.external_id || row.id;
    return { _id: publicId, internalId: row.id, _createdDate: row.created_at, _updatedDate: row.updated_at, title: row.title, slug: data.slug || publicId, autoseoId: row.external_id,
        shortDescription: data.shortDescription || data.metaDescription || "", fullContent: data.content_html || data.fullContent || "", content: data.content_markdown || data.content || "",
        coverImage: data.heroImageLocalUrl || data.coverImage || "", heroImageAlt: data.heroImageAlt || data.coverImageAlt || data.imageAlt || row.title,
        heroImageTitle: data.heroImageTitle || "", infographicImageUrl: data.infographicImageLocalUrl || "",
        infographicImageAlt: data.infographicImageAlt || "", infographicImageTitle: data.infographicImageTitle || "",
        images: data.images || [], keywords: data.keywords || [], metaKeywords: data.metaKeywords || [],
        wordpressTags: data.wordpressTags || [], faqSchema: data.faqSchema || null, languageCode: data.languageCode || "de",
        seoTitle: data.seoTitle || row.title, focusKeyword: data.focusKeyword || "", publicationDate: data.publishedAt || data.publicationDate || row.created_at,
        updatedAt: data.updatedAt || row.updated_at, author: data.author || "WB Holding AG", category: data.category || "Fachbeitrag" };
}
function publicCmsDatabase() {
    const databasePath = process.env.CAREER_DATABASE_PATH || "/career-data/wb-cms.sqlite";
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    return db;
}
function publicCmsPayload(row) {
    const item = publicItem(row);
    return { ...item, _id: item._id, status: "published", active: true, published: true };
}
function publishToPublicCms(row) {
    const db = publicCmsDatabase(), id = String(row.data.slug), now = new Date().toISOString();
    try {
        const existing = db.prepare("SELECT collection,id,payload,status,sort_order,created_at,updated_at FROM content_items WHERE collection='blogposts' AND id=?").get(id);
        const snapshot = existing ? { collection: existing.collection, id: existing.id, payload: existing.payload, status: existing.status, sortOrder: existing.sort_order, createdAt: existing.created_at, updatedAt: existing.updated_at } : null;
        db.prepare(`INSERT INTO content_items(collection,id,payload,status,sort_order,created_at,updated_at)
   VALUES('blogposts',?,?,'published',NULL,?,?)
   ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,status='published',updated_at=excluded.updated_at`)
            .run(id, jsonb(publicCmsPayload(row)), existing?.created_at || now, now);
        return snapshot;
    }
    finally {
        db.close();
    }
}
function restorePublicCms(slug, snapshot) {
    const db = publicCmsDatabase();
    try {
        db.exec("BEGIN IMMEDIATE");
        if (snapshot)
            db.prepare(`INSERT INTO content_items(collection,id,payload,status,sort_order,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,status=excluded.status,
   sort_order=excluded.sort_order,created_at=excluded.created_at,updated_at=excluded.updated_at`)
                .run(snapshot.collection, snapshot.id, snapshot.payload, snapshot.status, snapshot.sortOrder, snapshot.createdAt, snapshot.updatedAt);
        else
            db.prepare("DELETE FROM content_items WHERE collection='blogposts' AND id=?").run(slug);
        db.exec("COMMIT");
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { }
        throw error;
    }
    finally {
        db.close();
    }
}
async function compensateImportedImages(images, privateRoot) {
    for (const image of images) {
        if (!image || (!image.created && !image.previousDeletedAt))
            continue;
        const referenced = await query("SELECT count(*)::int count FROM app.resource_files WHERE file_id=$1", [image.fileId]);
        if (Number(referenced.rows[0]?.count || 0) > image.previousReferenceCount)
            throw new Error("autoseo_compensation_file_still_referenced");
        if (image.previousDeletedAt)
            await query("UPDATE files.objects SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL", [image.fileId, image.previousDeletedAt]);
        else
            await query("DELETE FROM files.objects WHERE id=$1", [image.fileId]);
        if (image.storageName) {
            const target = path.resolve(privateRoot, image.storageName);
            if (path.basename(image.storageName) !== image.storageName || !target.startsWith(path.resolve(privateRoot) + path.sep))
                throw new Error("image_storage_path_invalid");
            await fsp.unlink(target).catch(error => { if (error.code !== "ENOENT")
                throw error; });
        }
    }
}
async function importArticleImages(inputs, privateRoot) {
    const images = [];
    try {
        for (let index = 0; index < inputs.length; index++) {
            images[index] = await importImage(inputs[index].sourceUrl, privateRoot);
            inputs[index].imported = images[index];
        }
        return images;
    }
    catch (error) {
        await compensateImportedImages(images, privateRoot);
        throw error;
    }
}
async function publicationClient(images, privateRoot) {
    try {
        return await pool.connect();
    }
    catch (error) {
        await compensateImportedImages(images, privateRoot);
        throw error;
    }
}
async function snapshotResource(client, resource) {
    if (!resource)
        return { resource: null, files: [], seo: [] };
    const files = await client.query("SELECT resource_id,file_id,kind,metadata,created_at FROM app.resource_files WHERE resource_id=$1", [resource.id]);
    const seo = await client.query("SELECT id,resource_id,title,description,canonical_url,robots,structured_data,created_at,updated_at FROM cms.seo_metadata WHERE resource_id=$1", [resource.id]);
    return { resource, files: files.rows, seo: seo.rows };
}
async function restoreResource(client, snapshot, currentId) {
    if (!snapshot.resource) {
        await client.query("DELETE FROM cms.publication_events WHERE id=$1", [snapshot.publicationEventId || null]);
        await client.query("DELETE FROM cms.content_revisions WHERE id=$1", [snapshot.revisionId || null]);
        await client.query("DELETE FROM app.resources WHERE id=$1", [currentId]);
        return;
    }
    const row = snapshot.resource;
    await client.query(`UPDATE app.resources SET domain=$1,resource_type=$2,title=$3,status=$4,data=$5,raw_source=$6,source_system=$7,
  external_id=$8,source_hash=$9,owner_id=$10,version=$11,deleted_at=$12,created_at=$13,updated_at=$14,deleted_by=$15,
  delete_reason=$16,deletion_status=$17,previous_status=$18,restored_at=$19,restored_by=$20,scheduled_permanent_deletion_at=$21,
  legal_hold=$22,retention_until=$23,permanent_deletion_status=$24,original_area=$25 WHERE id=$26`, [row.domain, row.resource_type, row.title, row.status, row.data, row.raw_source, row.source_system, row.external_id, row.source_hash, row.owner_id, row.version,
        row.deleted_at, row.created_at, row.updated_at, row.deleted_by, row.delete_reason, row.deletion_status, row.previous_status, row.restored_at, row.restored_by,
        row.scheduled_permanent_deletion_at, row.legal_hold, row.retention_until, row.permanent_deletion_status, row.original_area, row.id]);
    await client.query("DELETE FROM app.resource_files WHERE resource_id=$1", [row.id]);
    for (const item of snapshot.files)
        await client.query("INSERT INTO app.resource_files(resource_id,file_id,kind,metadata,created_at) VALUES($1,$2,$3,$4,$5)", [item.resource_id, item.file_id, item.kind, item.metadata, item.created_at]);
    await client.query("DELETE FROM cms.seo_metadata WHERE resource_id=$1", [row.id]);
    for (const item of snapshot.seo)
        await client.query("INSERT INTO cms.seo_metadata(id,resource_id,title,description,canonical_url,robots,structured_data,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [item.id, item.resource_id, item.title, item.description, item.canonical_url, item.robots, item.structured_data, item.created_at, item.updated_at]);
    await client.query("DELETE FROM cms.publication_events WHERE id=$1", [snapshot.publicationEventId || null]);
    await client.query("DELETE FROM cms.content_revisions WHERE id=$1", [snapshot.revisionId || null]);
}
async function compensateCommittedPublication(client, state, resourceId) {
    await client.query("BEGIN");
    try {
        await restoreResource(client, state.article, resourceId);
        for (const media of state.media) {
            const currentId = media.resource?.id || text(media.currentId);
            if (currentId)
                await restoreResource(client, media, currentId);
        }
        if (state.redirectSlug) {
            if (state.redirect)
                await client.query(`INSERT INTO cms.slug_redirects(old_slug,resource_id,created_at) VALUES($1,$2,$3)
     ON CONFLICT(old_slug) DO UPDATE SET resource_id=EXCLUDED.resource_id,created_at=EXCLUDED.created_at`, [state.redirect.oldSlug, state.redirect.resourceId, state.redirect.createdAt]);
            else
                await client.query("DELETE FROM cms.slug_redirects WHERE old_slug=$1", [state.redirectSlug]);
        }
        await client.query("COMMIT");
    }
    catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    }
}
const verificationDelays = [0, 250, 750, 1500, 3000, 5000];
const publicVerificationErrors = new Set([
    "public_page_unavailable",
    "public_blog_api_unavailable",
    "public_blog_api_missing",
    "public_blog_api_mismatch",
    "public_blog_overview_unavailable",
    "public_canonical_missing",
    "public_sitemap_missing",
    "public_media_unavailable"
]);
const publicationErrorCode = (error) => {
    const systemCode = text(error?.code);
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "57P01", "57P02", "57P03"].includes(systemCode))
        return "database_unavailable";
    const candidate = text(error?.message).split(":")[0];
    return publicVerificationErrors.has(candidate) ? candidate : text(error?.message).slice(0, 120) || "processing_failed";
};
async function verifyPublication(slug, images, requestId, expected) {
    const origin = (process.env.AUTOSEO_PUBLIC_SITE_ORIGIN || "https://www.wb-holding.ag").replace(/\/$/, ""), url = `${origin}/blog/${encodeURIComponent(slug)}`;
    let lastError = "public_page_unavailable";
    for (let attempt = 0; attempt < verificationDelays.length; attempt++) {
        if (verificationDelays[attempt])
            await new Promise(resolve => setTimeout(resolve, verificationDelays[attempt]));
        try {
            const api = await fetch(`${origin}/api/cms/blogposts?limit=1000&autoseo_check=${encodeURIComponent(slug)}&attempt=${attempt + 1}`, { headers: { "cache-control": "no-cache", "x-wb-request-id": requestId }, signal: AbortSignal.timeout(15_000) });
            if (!api.ok) {
                lastError = "public_blog_api_unavailable";
                continue;
            }
            const apiPayload = await api.json(), matches = (Array.isArray(apiPayload?.items) ? apiPayload.items : []).filter((item) => item?.slug === slug);
            if (matches.length !== 1) {
                lastError = "public_blog_api_missing";
                continue;
            }
            const actual = matches[0];
            const exactFields = ["title", "shortDescription", "fullContent", "content", "author", "category", "heroImageAlt", "heroImageTitle", "infographicImageAlt", "infographicImageTitle", "seoTitle", "focusKeyword"];
            if (exactFields.some(field => text(actual[field]) !== text(expected[field])) || jsonb(actual.images || []) !== jsonb(expected.images || [])) {
                lastError = "public_blog_api_mismatch";
                continue;
            }
            const overview = await fetch(`${origin}/blog?autoseo_check=${encodeURIComponent(slug)}&attempt=${attempt + 1}`, { headers: { "cache-control": "no-cache", "x-wb-request-id": requestId }, signal: AbortSignal.timeout(15_000) });
            if (!overview.ok) {
                lastError = "public_blog_overview_unavailable";
                continue;
            }
            const page = await fetch(url, { headers: { "user-agent": "WB-AutoSEO-Publication-Check/2.0", "cache-control": "no-cache", "x-wb-request-id": requestId }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
            if (page.status !== 200) {
                lastError = "public_page_unavailable";
                continue;
            }
            const html = await page.text();
            if (!html.includes(`https://www.wb-holding.ag/blog/${slug}`)) {
                lastError = "public_canonical_missing";
                continue;
            }
            const sitemap = await fetch(`${origin}/sitemap.xml?autoseo_check=${encodeURIComponent(slug)}&attempt=${attempt + 1}`, { headers: { "cache-control": "no-cache", "x-wb-request-id": requestId }, signal: AbortSignal.timeout(15_000) });
            if (!sitemap.ok || !(await sitemap.text()).includes(`https://www.wb-holding.ag/blog/${slug}`)) {
                lastError = "public_sitemap_missing";
                continue;
            }
            let mediaOk = true;
            for (const image of images) {
                if (!image)
                    continue;
                const response = await fetch(`${origin}${image.url}`, { method: "HEAD", headers: { "cache-control": "no-cache", "x-wb-request-id": requestId }, signal: AbortSignal.timeout(15_000) });
                if (!response.ok || !text(response.headers.get("content-type")).startsWith("image/")) {
                    mediaOk = false;
                    lastError = "public_media_unavailable";
                    break;
                }
            }
            if (mediaOk)
                return `https://www.wb-holding.ag/blog/${slug}`;
        }
        catch (error) {
            lastError = text(error.message) || "public_page_unavailable";
        }
    }
    throw new Error(lastError);
}
export function registerAutoSeoRoutes(app, ctx) {
    app.post("/api/integrations/autoseo/webhook", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
        const rawBody = req.rawBody, authorization = text(req.headers.authorization), delivery = text(req.headers["x-autoseo-delivery"]), signatureHeader = text(req.headers["x-autoseo-signature"]);
        const credentials = await secret(), bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        const match = signaturePattern.exec(signatureHeader);
        if (!bearer || !match)
            return reply.code(401).send({ error: "unauthorized", correlationId: req.id });
        if (!rawBody)
            return reply.code(400).send({ error: "invalid_request", correlationId: req.id });
        const expected = crypto.createHmac("sha256", credentials.token).update(rawBody).digest("hex");
        if (!constantEqual(bearer, credentials.token) || !constantEqual(match[1].toLowerCase(), expected))
            return reply.code(401).send({ error: "unauthorized", correlationId: req.id });
        if (!deliveryPattern.test(delivery))
            return reply.code(400).send({ error: "invalid_request", correlationId: req.id });
        const envelope = eventSchema.safeParse(req.body);
        if (!envelope.success)
            return reply.code(422).send({ error: "schema_invalid", correlationId: req.id });
        const bodyEvent = envelope.data.event || envelope.data.type || envelope.data.eventType;
        const headerEvent = text(req.headers["x-autoseo-event"]);
        if (headerEvent && bodyEvent && headerEvent !== bodyEvent)
            return reply.code(422).send({ error: "event_type_mismatch", correlationId: req.id });
        const eventType = headerEvent || bodyEvent;
        if (!["article.published", "article.updated", "test"].includes(eventType || ""))
            return reply.code(422).send({ error: "event_type_invalid", correlationId: req.id });
        if (!eventType)
            return reply.code(422).send({ error: "event_type_missing", correlationId: req.id });
        if (eventType === "test")
            return { url: "https://www.wb-holding.ag/blog", status: "ok" };
        const payloadSha256 = digest(rawBody), articleValue = envelope.data.article || envelope.data.data || envelope.data.payload || envelope.data;
        const externalId = text(articleValue.id);
        let inserted;
        try {
            inserted = await query(`INSERT INTO integration.autoseo_deliveries(delivery_id,event_type,external_id,payload_sha256,status)
    VALUES($1,$2,$3,$4,'processing') ON CONFLICT(delivery_id) DO NOTHING RETURNING *`, [delivery, eventType, externalId, payloadSha256]);
        }
        catch (error) {
            return reply.code(503).send({ error: publicationErrorCode(error), correlationId: req.id });
        }
        if (!inserted.rowCount) {
            let waitedForProcessing = false;
            for (let attempt = 0; attempt < 400; attempt++) {
                const current = await query("SELECT * FROM integration.autoseo_deliveries WHERE delivery_id=$1", [delivery]);
                if (!current.rowCount) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    continue;
                }
                const prior = current.rows[0];
                if (prior.payload_sha256 !== payloadSha256)
                    return reply.code(409).send({ error: "delivery_payload_mismatch", correlationId: req.id });
                if (["published", "ok"].includes(prior.status))
                    return { url: prior.published_url, published_url: prior.published_url, status: "published" };
                if (prior.status === "failed") {
                    if (waitedForProcessing)
                        return reply.code(503).send({ error: publicationErrorCode(new Error(prior.last_error_code)), correlationId: req.id });
                    const claimed = await query(`UPDATE integration.autoseo_deliveries SET status='processing',attempts=attempts+1,last_error_code=NULL
      WHERE delivery_id=$1 AND status='failed' RETURNING delivery_id`, [delivery]);
                    if (claimed.rowCount)
                        break;
                }
                else
                    waitedForProcessing = true;
                await new Promise(resolve => setTimeout(resolve, 100));
                if (attempt === 399)
                    return reply.code(503).send({ error: "delivery_processing_timeout", correlationId: req.id });
            }
        }
        const parsed = articleSchema.safeParse(articleValue);
        if (!parsed.success) {
            await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code='article_schema_invalid' WHERE delivery_id=$1", [delivery]);
            return reply.code(422).send({ error: "article_schema_invalid", correlationId: req.id });
        }
        let faqStructuredData;
        try {
            faqStructuredData = structuredData(parsed.data.faqSchema);
        }
        catch (error) {
            await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code=$1 WHERE delivery_id=$2", [text(error.message).slice(0, 120) || "faq_schema_invalid", delivery]);
            return reply.code(422).send({ error: "article_schema_invalid", correlationId: req.id });
        }
        try {
            const article = parsed.data, html = sanitized(article.content_html || "");
            const articleImages = [
                ...(article.heroImageUrl ? [{ kind: "hero", sourceUrl: article.heroImageUrl, alt: article.heroImageAlt || "", title: article.heroImageTitle || "" }] : []),
                ...(article.infographicImageUrl ? [{ kind: "infographic", sourceUrl: article.infographicImageUrl, alt: article.infographicImageAlt || "", title: article.infographicImageTitle || "" }] : []),
                ...(article.images || []).map((value, index) => typeof value === "string"
                    ? { kind: `gallery-${index + 1}`, sourceUrl: value, alt: "", title: "" }
                    : { kind: `gallery-${index + 1}`, sourceUrl: value.url, alt: value.alt || "", title: value.title || "" })
            ];
            if (articleImages.length > 4) {
                await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code='article_image_limit_exceeded' WHERE delivery_id=$1", [delivery]);
                return reply.code(422).send({ error: "article_image_limit_exceeded", correlationId: req.id });
            }
            const importedImages = await importArticleImages(articleImages, ctx.privateRoot);
            const hero = articleImages.find(image => image.kind === "hero")?.imported, infographic = articleImages.find(image => image.kind === "infographic")?.imported;
            const client = await publicationClient(importedImages, ctx.privateRoot);
            let resourceId = "";
            let finalSlug = "";
            let publicSnapshot = null;
            let publicCmsWritten = false;
            let transactionOpen = false, mutationCommitted = false;
            const compensation = { article: { resource: null, files: [], seo: [] }, media: [], redirect: null };
            try {
                await client.query("BEGIN");
                transactionOpen = true;
                await client.query("SELECT pg_advisory_xact_lock(hashtext('autoseo-blog-slug'))");
                const existing = await client.query(`SELECT * FROM app.resources
     WHERE resource_type='blogposts' AND (source_system='autoseo' AND external_id=$1 OR data->>'autoseoId'=$1 OR data->>'id'=$1)
     ORDER BY (source_system='autoseo') DESC,created_at LIMIT 1 FOR UPDATE`, [article.id]);
                const previous = existing.rows[0], requested = article.slug || article.title;
                resourceId = previous?.id;
                compensation.article = await snapshotResource(client, previous || null);
                finalSlug = await uniqueSlug(client, requested, resourceId, article.id);
                if (previous?.data?.slug && previous.data.slug !== finalSlug) {
                    compensation.redirectSlug = previous.data.slug;
                    const redirect = await client.query("SELECT old_slug,resource_id,created_at FROM cms.slug_redirects WHERE old_slug=$1 FOR UPDATE", [previous.data.slug]);
                    if (redirect.rowCount)
                        compensation.redirect = { oldSlug: redirect.rows[0].old_slug, resourceId: redirect.rows[0].resource_id, createdAt: redirect.rows[0].created_at };
                    await client.query("INSERT INTO cms.slug_redirects(old_slug,resource_id) VALUES($1,$2) ON CONFLICT(old_slug) DO UPDATE SET resource_id=EXCLUDED.resource_id", [previous.data.slug, previous.id]);
                }
                const replaceUrls = (value) => articleImages.reduce((result, image) => result.replaceAll(image.sourceUrl, image.imported?.url || ""), value);
                const data = { id: article.id, autoseoId: article.id, title: article.title, slug: finalSlug, shortDescription: article.shortDescription ?? article.metaDescription ?? "", metaDescription: article.metaDescription || "",
                    seoTitle: article.seoTitle ?? article.title, focusKeyword: article.focusKeyword ?? "", author: article.author ?? "WB Holding AG", category: article.category ?? "Fachbeitrag",
                    content_html: replaceUrls(html), content_markdown: article.content_markdown || "",
                    heroImageUrl: article.heroImageUrl || null, heroImageLocalUrl: hero?.url || null, heroImageAlt: article.heroImageAlt || "", heroImageTitle: article.heroImageTitle || "",
                    infographicImageUrl: article.infographicImageUrl || null, infographicImageLocalUrl: infographic?.url || null,
                    infographicImageAlt: article.infographicImageAlt || "", infographicImageTitle: article.infographicImageTitle || "",
                    images: articleImages.filter(image => image.kind.startsWith("gallery-")).map(image => ({ url: image.sourceUrl, localUrl: image.imported?.url, alt: image.alt, title: image.title })),
                    keywords: arrayValue(article.keywords), metaKeywords: arrayValue(article.metaKeywords), wordpressTags: arrayValue(article.wordpressTags),
                    faqSchema: article.faqSchema ?? null, languageCode: article.languageCode || "de", publishedAt: article.publishedAt || new Date().toISOString(), updatedAt: article.updatedAt || new Date().toISOString() };
                if (previous) {
                    const revision = await client.query("INSERT INTO cms.content_revisions(resource_id,version,snapshot) VALUES($1,$2,$3::jsonb) RETURNING id", [previous.id, previous.version, jsonb({ title: previous.title, status: previous.status, data: previous.data })]);
                    compensation.article.revisionId = revision.rows[0].id;
                }
                const saved = previous
                    ? await client.query(`UPDATE app.resources SET title=$1,status='published',data=$2::jsonb,raw_source=$3::jsonb,source_system='autoseo',external_id=$4,
       source_hash=$5,deleted_at=NULL,version=version+1,updated_at=now() WHERE id=$6 RETURNING *`, [article.title, jsonb(data), jsonb(articleValue), article.id, payloadSha256, previous.id])
                    : await client.query(`INSERT INTO app.resources(domain,resource_type,title,status,data,raw_source,source_system,external_id,source_hash)
       VALUES('cms','blogposts',$1,'published',$2::jsonb,$3::jsonb,'autoseo',$4,$5) RETURNING *`, [article.title, jsonb(data), jsonb(articleValue), article.id, payloadSha256]);
                resourceId = saved.rows[0].id;
                await client.query("DELETE FROM cms.seo_metadata WHERE resource_id=$1", [resourceId]);
                await client.query("INSERT INTO cms.seo_metadata(resource_id,title,description,canonical_url,robots,structured_data) VALUES($1,$2,$3,$4,'index,follow',$5::jsonb)", [resourceId, article.seoTitle ?? article.title, article.metaDescription || "", `https://www.wb-holding.ag/blog/${finalSlug}`, jsonb(faqStructuredData)]);
                await client.query("DELETE FROM app.resource_files WHERE resource_id=$1 AND kind LIKE 'autoseo-%'", [resourceId]);
                for (const { kind, imported: image, alt, title } of articleImages) {
                    if (!image)
                        continue;
                    const mediaBefore = await client.query("SELECT * FROM app.resources WHERE source_system='autoseo' AND resource_type='media' AND external_id=$1 FOR UPDATE", [`${article.id}:${kind}`]);
                    const mediaSnapshot = await snapshotResource(client, mediaBefore.rows[0] || null);
                    const media = await client.query(`INSERT INTO app.resources(domain,resource_type,title,status,data,source_system,external_id,source_hash)
      VALUES('cms','media',$1,'published',$2,'autoseo',$3,$4)
      ON CONFLICT(source_system,resource_type,external_id) DO UPDATE SET title=EXCLUDED.title,status='published',data=EXCLUDED.data,source_hash=EXCLUDED.source_hash,
      deleted_at=NULL,deletion_status='active',delete_reason=NULL,scheduled_permanent_deletion_at=NULL,updated_at=now() RETURNING id`, [title || `AutoSEO ${kind} ${article.title}`, jsonb({ fileId: image.fileId, altText: alt, title, sourceUrl: image.sourceUrl, sha256: image.sha256 }), `${article.id}:${kind}`, image.sha256]);
                    mediaSnapshot.currentId = media.rows[0].id;
                    compensation.media.push(mediaSnapshot);
                    await client.query("DELETE FROM app.resource_files WHERE resource_id=$1 AND kind=$2", [media.rows[0].id, `autoseo-${kind}`]);
                    await client.query("INSERT INTO app.resource_files(resource_id,file_id,kind,metadata) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(resource_id,file_id) DO UPDATE SET kind=EXCLUDED.kind,metadata=EXCLUDED.metadata", [media.rows[0].id, image.fileId, `autoseo-${kind}`, jsonb({ altText: alt, title, sourceUrl: image.sourceUrl })]);
                    await client.query("INSERT INTO app.resource_files(resource_id,file_id,kind,metadata) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(resource_id,file_id) DO UPDATE SET kind=EXCLUDED.kind,metadata=EXCLUDED.metadata", [resourceId, image.fileId, `autoseo-${kind}`, jsonb({ altText: alt, title })]);
                }
                const publicationEvent = await client.query("INSERT INTO cms.publication_events(resource_id,action) VALUES($1,$2) RETURNING id", [resourceId, eventType]);
                compensation.article.publicationEventId = publicationEvent.rows[0].id;
                await client.query("COMMIT");
                transactionOpen = false;
                mutationCommitted = true;
                publicSnapshot = publishToPublicCms(saved.rows[0]);
                publicCmsWritten = true;
                const publishedUrl = await verifyPublication(finalSlug, importedImages, req.id, publicCmsPayload(saved.rows[0]));
                await client.query("BEGIN");
                transactionOpen = true;
                await client.query("UPDATE integration.autoseo_deliveries SET status='published',resource_id=$1,published_url=$2,processed_at=now(),last_error_code=NULL WHERE delivery_id=$3", [resourceId, publishedUrl, delivery]);
                await client.query("INSERT INTO audit.events(action,object_type,object_id,changed_fields,request_id,metadata) VALUES('autoseo_publish','blogposts',$1,$2,$3,$4::jsonb)", [resourceId, ["title", "slug", "status", "media"], req.id, jsonb({ eventType, externalId: article.id, deliveryHash: digest(delivery), hasHero: Boolean(hero), hasInfographic: Boolean(infographic), publicCms: "sqlite" })]);
                await client.query("COMMIT");
                transactionOpen = false;
                return { url: publishedUrl, published_url: publishedUrl, status: "published" };
            }
            catch (error) {
                if (transactionOpen) {
                    await client.query("ROLLBACK").catch(() => undefined);
                    transactionOpen = false;
                }
                let compensationError;
                try {
                    if (publicCmsWritten)
                        restorePublicCms(finalSlug, publicSnapshot);
                    if (mutationCommitted)
                        await compensateCommittedPublication(client, compensation, resourceId);
                    await compensateImportedImages(importedImages, ctx.privateRoot);
                    await query("INSERT INTO audit.events(action,object_type,object_id,changed_fields,request_id,metadata) VALUES('autoseo_publish_compensated','blogposts',$1,$2,$3,$4::jsonb)", [resourceId || null, ["publicCms", "media", "idempotency"], req.id, jsonb({ eventType, externalId: article.id, deliveryHash: digest(delivery), reason: text(error.message).slice(0, 120) })]);
                }
                catch (compensation) {
                    compensationError = compensation;
                }
                if (compensationError)
                    throw new Error(`autoseo_compensation_failed:${text(compensationError.message)}`);
                throw error;
            }
            finally {
                client.release();
            }
        }
        catch (error) {
            const errorCode = publicationErrorCode(error);
            await query("UPDATE integration.autoseo_deliveries SET status='failed',last_error_code=$1 WHERE delivery_id=$2", [errorCode, delivery]).catch(() => undefined);
            return reply.code(503).send({ error: errorCode, correlationId: req.id });
        }
    });
    app.get("/api/public/v1/autoseo/blogposts", async (req, reply) => {
        const pagination = z.object({ limit: z.coerce.number().int().min(1).max(100).default(12), skip: z.coerce.number().int().min(0).default(0) }).safeParse(req.query || {});
        if (!pagination.success)
            return reply.code(400).send({ error: "invalid_pagination" });
        const { limit, skip } = pagination.data;
        const rows = await query(`SELECT id,title,data,external_id,created_at,updated_at,count(*) OVER()::int total_count
   FROM app.resources WHERE resource_type='blogposts' AND status='published' AND deleted_at IS NULL
   ORDER BY COALESCE(NULLIF(data->>'publishedAt','')::timestamptz,updated_at,created_at) DESC,id DESC LIMIT $1 OFFSET $2`, [limit, skip]);
        const totalCount = rows.rows[0]?.total_count || 0;
        const returned = rows.rowCount || 0;
        reply.header("cache-control", "public,max-age=30,must-revalidate");
        return { items: rows.rows.map(publicItem), totalCount, hasNext: skip + returned < totalCount, nextSkip: skip + returned < totalCount ? skip + returned : null };
    });
    app.get("/api/public/v1/autoseo/blogposts/:slug", async (req, reply) => {
        const requested = text(req.params.slug), slug = slugify(requested), row = await query(`SELECT id,title,data,external_id,created_at,updated_at FROM app.resources
   WHERE resource_type='blogposts' AND status='published' AND deleted_at IS NULL
   AND (lower(data->>'slug')=$1 OR external_id=$2 OR id::text=$2) ORDER BY source_system='autoseo' DESC,updated_at DESC LIMIT 1`, [slug, requested]);
        if (row.rowCount) {
            reply.header("cache-control", "public,max-age=30,must-revalidate");
            return publicItem(row.rows[0]);
        }
        const redirect = await query("SELECT r.data->>'slug' slug FROM cms.slug_redirects sr JOIN app.resources r ON r.id=sr.resource_id WHERE sr.old_slug=$1 AND r.status='published' AND r.deleted_at IS NULL", [slug]);
        if (redirect.rowCount)
            return reply.code(301).header("location", `https://www.wb-holding.ag/blog/${redirect.rows[0].slug}`).send();
        return reply.code(404).send({ error: "not_found" });
    });
    app.get("/api/public/v1/autoseo/media/:id", async (req, reply) => {
        if (!z.string().uuid().safeParse(req.params.id).success)
            return reply.code(404).send({ error: "not_found" });
        const file = await query(`SELECT DISTINCT f.* FROM files.objects f JOIN app.resource_files rf ON rf.file_id=f.id JOIN app.resources r ON r.id=rf.resource_id
   WHERE f.id=$1 AND f.protection_class='public' AND f.verified AND f.deleted_at IS NULL AND r.source_system='autoseo' AND r.status='published' AND r.deleted_at IS NULL`, [req.params.id]);
        if (!file.rowCount)
            return reply.code(404).send({ error: "not_found" });
        const item = file.rows[0], target = ctx.assertStoragePath(item.storage_name);
        reply.header("content-type", item.mime_type).header("content-length", item.size_bytes).header("cache-control", "public,max-age=31536000,immutable").header("x-content-type-options", "nosniff");
        return reply.send(fs.createReadStream(target));
    });
}
