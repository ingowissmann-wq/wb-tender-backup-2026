import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const payloadPath = process.argv[2] || "/tmp/wix-admin-restore.json";
const payload = JSON.parse(await fsp.readFile(payloadPath, "utf8"));
if (payload.version !== 1) throw new Error("unsupported_payload_version");
const privateRoot = path.resolve(process.env.PRIVATE_FILE_ROOT || "/data/private");
const careerPath = process.env.CAREER_DATABASE_PATH || "/data/career.db";
await fsp.mkdir(privateRoot, { recursive: true, mode: 0o700 });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const client = await pool.connect();
const db = new DatabaseSync(careerPath);
const createdFiles = [];
const stats = { services: 0, jobs: 0, team: 0, blogImages: 0, mediaDownloaded: 0, mediaReused: 0 };

function sourceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("wix:image://v1/")) {
    const media = raw.slice("wix:image://v1/".length).split("/")[0];
    return `https://static.wixstatic.com/media/${media}`;
  }
  const url = new URL(raw);
  if (!["static.wixstatic.com", "getautoseo.com"].includes(url.hostname)) throw new Error(`media_host_not_allowed:${url.hostname}`);
  return url.href;
}

function detect(bytes) {
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return ["image/jpeg", ".jpg"];
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return ["image/png", ".png"];
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return ["image/webp", ".webp"];
  throw new Error("unsupported_media_signature");
}

async function media(value, title) {
  const url = sourceUrl(value);
  if (!url) return null;
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`media_download_${response.status}:${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100 || bytes.length > 10_000_000) throw new Error(`invalid_media_size:${bytes.length}`);
  const [mime, extension] = detect(bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  let row = (await client.query("SELECT * FROM files.objects WHERE sha256=$1 AND size_bytes=$2 AND protection_class='public' AND deleted_at IS NULL LIMIT 1", [sha256, bytes.length])).rows[0];
  if (!row) {
    const id = crypto.randomUUID(), storageName = `${sha256}-${id}`;
    await fsp.writeFile(path.join(privateRoot, storageName), bytes, { mode: 0o600 });
    createdFiles.push(path.join(privateRoot, storageName));
    row = (await client.query(`INSERT INTO files.objects(id,storage_name,original_name,mime_type,size_bytes,sha256,protection_class,verified)
      VALUES($1,$2,$3,$4,$5,$6,'public',true) RETURNING *`, [id, storageName, `${String(title).slice(0,120)}${extension}`, mime, bytes.length, sha256])).rows[0];
    stats.mediaDownloaded++;
  } else {
    const target = path.join(privateRoot, row.storage_name);
    if (!fs.existsSync(target)) {
      await fsp.writeFile(target, bytes, { mode: 0o600 });
      createdFiles.push(target);
      stats.mediaDownloaded++;
    } else stats.mediaReused++;
  }
  return { id: row.id, url: `/cms-media/${row.id}` };
}

async function findResource(type, item) {
  const found = await client.query(`SELECT * FROM app.resources WHERE resource_type=$1 AND deleted_at IS NULL
    AND (external_id=$2 OR ($3<>'' AND data->>'slug'=$3) OR title=$4)
    ORDER BY CASE WHEN external_id=$2 THEN 0 WHEN data->>'slug'=$3 THEN 1 ELSE 2 END LIMIT 1`,
    [type, item.externalId, String(item.data?.slug || item.slug || ""), item.title]);
  return found.rows[0] || null;
}

async function link(resourceId, file, kind, altText) {
  if (!file) return;
  const exists = await client.query("SELECT 1 FROM app.resource_files WHERE resource_id=$1 AND file_id=$2 AND kind=$3", [resourceId, file.id, kind]);
  if (!exists.rowCount) await client.query("INSERT INTO app.resource_files(resource_id,file_id,kind,metadata) VALUES($1,$2,$3,$4)", [resourceId, file.id, kind, { altText, position: kind }]);
}

async function upsertCms(type, item, additions) {
  const current = await findResource(type, item);
  if (current) {
    return (await client.query(`UPDATE app.resources SET external_id=COALESCE(external_id,$1), data=data||$2::jsonb,
      title=$3, updated_at=GREATEST(updated_at,$4::timestamptz) WHERE id=$5 RETURNING *`,
      [item.externalId, JSON.stringify({ ...item.data, ...additions }), item.title, item.updatedAt || new Date().toISOString(), current.id])).rows[0];
  }
  const owner = (await client.query("SELECT id FROM iam.users WHERE lower(email)=lower($1) LIMIT 1", ["admin@wb-holding.ag"])).rows[0];
  if (!owner) throw new Error("isolated_admin_owner_missing");
  return (await client.query(`INSERT INTO app.resources(domain,resource_type,external_id,title,status,data,owner_id,created_at,updated_at)
    VALUES('cms',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [type, item.externalId, item.title, item.status || "published",
    JSON.stringify({ ...item.data, ...additions }), owner.id, item.createdAt || new Date().toISOString(), item.updatedAt || new Date().toISOString()])).rows[0];
}

try {
  await client.query("BEGIN");
  db.exec("BEGIN IMMEDIATE");
  db.exec(`CREATE TABLE IF NOT EXISTS content_items(
    collection TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',
    sort_order INTEGER NOT NULL DEFAULT 999,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(collection,id));
    CREATE INDEX IF NOT EXISTS content_items_collection_updated ON content_items(collection,updated_at DESC);
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,disk_name TEXT NOT NULL UNIQUE,original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,is_public INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL);`);

  for (const item of payload.services) {
    const cover = await media(item.media.cover, `${item.data.slug}-cover`);
    const logo = await media(item.media.logo, `${item.data.slug}-logo`);
    const og = await media(item.media.og, `${item.data.slug}-og`);
    const additions = {
      coverImageId: cover?.id || "", coverImage: cover?.url || "", coverImageUrl: cover?.url || "", coverImageAlt: item.title,
      logoImageId: logo?.id || "", logo: logo?.url || "", logoImageUrl: logo?.url || "",
      ogImageId: og?.id || "", ogImage: og?.url || "", ogImageUrl: og?.url || "", ogImageAlt: item.title
    };
    const resource = await upsertCms("services", item, additions);
    await link(resource.id, cover, "cover-image", item.title); await link(resource.id, logo, "logo", item.title); await link(resource.id, og, "og-image", item.title);
    stats.services++;
  }

  for (const item of payload.blogImages) {
    const current = await findResource("blogposts", item);
    if (!current) continue;
    const image = await media(item.coverUrl, `${item.slug || item.externalId}-cover`);
    if (!image) continue;
    await client.query(`UPDATE app.resources SET external_id=COALESCE(external_id,$1), data=data||$2::jsonb,updated_at=GREATEST(updated_at,$3::timestamptz) WHERE id=$4`,
      [item.externalId, JSON.stringify({ cardImageId: image.id, cardImageUrl: image.url, cardImageAlt: item.title,
        coverImageId: image.id, coverImage: image.url, coverImageUrl: image.url, coverImageAlt: item.title }), item.updatedAt, current.id]);
    await link(current.id, image, "card-image", item.title);
    stats.blogImages++;
  }

  const upsertContent = db.prepare(`INSERT INTO content_items(collection,id,payload,status,sort_order,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,status=excluded.status,
    sort_order=excluded.sort_order,updated_at=excluded.updated_at`);
  for (const item of payload.jobs) {
    const image = await media(item.media.image, `${item.externalId}-job`);
    const data = { ...item.data, imageId: image?.id || "", imageUrl: image?.url || "", cardImageId: image?.id || "",
      cardImageUrl: image?.url || "", cardImageAlt: item.data.title, detailImageId: image?.id || "", detailImageUrl: image?.url || "", detailImageAlt: item.data.title };
    upsertContent.run("jobangebote", item.externalId, JSON.stringify(data), data.status, data.sortOrder, item.createdAt, item.updatedAt); stats.jobs++;
  }
  for (const item of payload.team) {
    const image = await media(item.media.image, `${item.externalId}-team`);
    const data = { ...item.data, imageId: image?.id || "", imageUrl: image?.url || "", profilePicture: image?.url || "", imageAlt: item.data.name };
    upsertContent.run("teammembers", item.externalId, JSON.stringify(data), data.status, data.sortOrder, item.createdAt, item.updatedAt); stats.team++;
  }

  db.exec("COMMIT");
  await client.query("COMMIT");
  console.log(JSON.stringify({ ok: true, stats, sqliteIntegrity: db.prepare("PRAGMA integrity_check").get().integrity_check }));
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  try { await client.query("ROLLBACK"); } catch {}
  for (const file of createdFiles) try { await fsp.unlink(file); } catch {}
  throw error;
} finally {
  db.close(); client.release(); await pool.end();
}
