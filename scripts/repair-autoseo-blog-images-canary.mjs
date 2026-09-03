import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const privateRoot = path.resolve(process.env.PRIVATE_FILE_ROOT || "/data/private");
const backupPath = process.argv[2] || "/tmp/wb-autoseo-blog-images.before.json";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const normalize = value => String(value || "").trim().toLocaleLowerCase("de-DE");

function candidateFileIds(data) {
  const keys = ["fileId", "imageId", "assetId", "objectId", "mediaId", "coverImageId", "cardImageId"];
  const found = [];
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === "string" && uuid.test(value)) found.push(value);
  }
  return found;
}

try {
  await client.query("BEGIN");

  const userHasTenant = (await client.query(`SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='iam' AND table_name='users' AND column_name='tenant_id'
  ) AS present`)).rows[0].present;

  let tenantId = null;
  if (userHasTenant) {
    tenantId = (await client.query(
      "SELECT tenant_id FROM iam.users WHERE lower(email)=lower($1) AND tenant_id IS NOT NULL LIMIT 1",
      ["admin@wb-holding.ag"]
    )).rows[0]?.tenant_id || null;
  }
  if (!tenantId) {
    const tenants = (await client.query(`SELECT tenant_id,count(*)::int AS total
      FROM files.objects
      WHERE tenant_id IS NOT NULL
      GROUP BY tenant_id
      ORDER BY total DESC`)).rows;
    if (tenants.length !== 1) throw new Error(`isolated_canary_tenant_not_unique:${tenants.length}`);
    tenantId = tenants[0].tenant_id;
  }
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);

  const blogs = (await client.query(`
    SELECT id,title,data
    FROM app.resources
    WHERE tenant_id=$1
      AND resource_type='blogposts'
      AND deleted_at IS NULL
      AND status='published'
      AND COALESCE(data->>'cardImageId',data->>'coverImageId','')=''
    ORDER BY updated_at DESC
  `, [tenantId])).rows;

  const mediaResources = (await client.query(`
    SELECT id,title,data
    FROM app.resources
    WHERE tenant_id=$1
      AND deleted_at IS NULL
      AND title LIKE 'AutoSEO hero %'
  `, [tenantId])).rows;

  const links = (await client.query(`
    SELECT resource_id,file_id,kind
    FROM app.resource_files
    WHERE tenant_id=$1
  `, [tenantId])).rows;

  const linksByResource = new Map();
  for (const link of links) {
    if (!linksByResource.has(link.resource_id)) linksByResource.set(link.resource_id, []);
    linksByResource.get(link.resource_id).push(link.file_id);
  }

  const fileRows = (await client.query(`
    SELECT id,storage_name,mime_type,size_bytes
    FROM files.objects
    WHERE tenant_id=$1 AND deleted_at IS NULL AND protection_class='public'
  `, [tenantId])).rows;
  const filesById = new Map(fileRows.map(row => [row.id, row]));

  const heroes = new Map();
  for (const media of mediaResources) {
    const title = String(media.title || "").replace(/^AutoSEO hero\s+/i, "");
    const candidates = [...(linksByResource.get(media.id) || []), ...candidateFileIds(media.data)];
    const file = candidates.map(id => filesById.get(id)).find(Boolean);
    if (!file) continue;
    const key = normalize(title);
    if (!heroes.has(key)) heroes.set(key, []);
    heroes.get(key).push({ mediaId: media.id, file });
  }

  const plan = [];
  for (const blog of blogs) {
    const matches = heroes.get(normalize(blog.title)) || [];
    if (matches.length !== 1) continue;
    const [{ file }] = matches;
    const binary = path.join(privateRoot, file.storage_name);
    const stat = await fs.stat(binary);
    if (!stat.isFile() || stat.size !== Number(file.size_bytes)) {
      throw new Error(`invalid_media_binary:${file.id}`);
    }
    plan.push({ blog, file });
  }

  if (plan.length < 10) {
    throw new Error(`expected_at_least_10_unambiguous_blog_image_links_found_${plan.length}`);
  }

  const backup = {
    createdAt: new Date().toISOString(),
    tenantId,
    changes: plan.map(({ blog, file }) => ({
      resourceId: blog.id,
      title: blog.title,
      previousData: blog.data,
      fileId: file.id,
      previousLinks: links.filter(link => link.resource_id === blog.id)
    }))
  };
  await fs.writeFile(backupPath, JSON.stringify(backup, null, 2), { mode: 0o600 });

  for (const { blog, file } of plan) {
    const url = `/cms-media/${file.id}`;
    const additions = {
      cardImageId: file.id,
      cardImageUrl: url,
      cardImageAlt: blog.title,
      coverImageId: file.id,
      coverImage: url,
      coverImageUrl: url,
      coverImageAlt: blog.title
    };
    await client.query(
      "UPDATE app.resources SET data=data||$1::jsonb,updated_at=now() WHERE id=$2 AND tenant_id=$3",
      [JSON.stringify(additions), blog.id, tenantId]
    );
    await client.query(`
      INSERT INTO app.resource_files(resource_id,file_id,kind,metadata,tenant_id)
      VALUES($1,$2,'card-image',$3,$4)
      ON CONFLICT(resource_id,file_id)
      DO UPDATE SET kind=EXCLUDED.kind,metadata=EXCLUDED.metadata
    `, [blog.id, file.id, { altText: blog.title, position: "card-image" }, tenantId]);
  }

  const verified = (await client.query(`
    SELECT count(*)::int AS total
    FROM app.resources
    WHERE tenant_id=$1
      AND id=ANY($2::uuid[])
      AND COALESCE(data->>'cardImageId','')<>''
      AND COALESCE(data->>'cardImageUrl','') LIKE '/cms-media/%'
  `, [tenantId, plan.map(item => item.blog.id)])).rows[0].total;

  if (verified !== plan.length) throw new Error(`verification_mismatch_${verified}_of_${plan.length}`);

  await client.query("COMMIT");
  console.log(JSON.stringify({ ok: true, linked: plan.length, verified, titles: plan.map(item => item.blog.title) }));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
