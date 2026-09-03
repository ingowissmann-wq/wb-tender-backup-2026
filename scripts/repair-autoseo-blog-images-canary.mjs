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
  const keys = ["coverImageId", "cardImageId", "imageId", "fileId", "assetId", "objectId", "mediaId"];
  const found = [];
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === "string" && uuid.test(value)) found.push(value);
  }
  return found;
}

function topicFor(title) {
  const value = normalize(title);
  if (/notruf|serviceleitstelle/.test(value)) return "notruf";
  if (/betriebssanit|notfallsanit|notfallmanagement/.test(value)) return "betriebssanit";
  if (/facility/.test(value)) return "facility";
  if (/reinig/.test(value)) return "reinig";
  if (/videoüberwach|sicherheitstechnik/.test(value)) return "sicherheitstechnik";
  if (/interventionsdienst|werkschutz|objektschutz/.test(value)) return "objektschutz";
  return "sicherheitsdienst";
}

function serviceTopic(resource) {
  const value = normalize(`${resource.title} ${resource.data?.slug || ""}`);
  if (/notruf|serviceleitstelle/.test(value)) return "notruf";
  if (/betriebssanit/.test(value)) return "betriebssanit";
  if (/facility/.test(value)) return "facility";
  if (/reinig/.test(value)) return "reinig";
  if (/sicherheitstechnik/.test(value)) return "sicherheitstechnik";
  if (/objektschutz/.test(value)) return "objektschutz";
  if (/sicherheitsdienst/.test(value)) return "sicherheitsdienst";
  return "";
}

async function resolveTenantId() {
  const userHasTenant = (await client.query(`SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='iam' AND table_name='users' AND column_name='tenant_id'
  ) AS present`)).rows[0].present;

  if (userHasTenant) {
    const owner = (await client.query(
      "SELECT tenant_id FROM iam.users WHERE lower(email)=lower($1) AND tenant_id IS NOT NULL LIMIT 1",
      ["admin@wb-holding.ag"]
    )).rows[0];
    if (owner?.tenant_id) return owner.tenant_id;
  }

  const tenants = (await client.query(`SELECT tenant_id,count(*)::int AS total
    FROM files.objects
    WHERE tenant_id IS NOT NULL
    GROUP BY tenant_id
    ORDER BY total DESC`)).rows;
  if (tenants.length !== 1) throw new Error(`isolated_canary_tenant_not_unique:${tenants.length}`);
  return tenants[0].tenant_id;
}

try {
  await client.query("BEGIN");
  const tenantId = await resolveTenantId();
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

  const services = (await client.query(`
    SELECT id,title,data
    FROM app.resources
    WHERE tenant_id=$1
      AND resource_type='services'
      AND deleted_at IS NULL
      AND status='published'
  `, [tenantId])).rows;

  const links = (await client.query(`
    SELECT resource_id,file_id,kind,metadata
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
    WHERE tenant_id=$1
      AND deleted_at IS NULL
      AND protection_class='public'
      AND verified=true
  `, [tenantId])).rows;
  const filesById = new Map(fileRows.map(row => [row.id, row]));

  async function validFile(resource) {
    const ids = [...candidateFileIds(resource.data), ...(linksByResource.get(resource.id) || [])];
    for (const id of [...new Set(ids)]) {
      const file = filesById.get(id);
      if (!file) continue;
      try {
        const stat = await fs.stat(path.join(privateRoot, file.storage_name));
        if (stat.isFile() && stat.size === Number(file.size_bytes)) return file;
      } catch {}
    }
    return null;
  }

  const serviceFiles = new Map();
  for (const service of services) {
    const topic = serviceTopic(service);
    if (!topic || serviceFiles.has(topic)) continue;
    const file = await validFile(service);
    if (file) serviceFiles.set(topic, { file, serviceId: service.id, serviceTitle: service.title });
  }

  const requiredTopics = [...new Set(blogs.map(blog => topicFor(blog.title)))];
  const missingTopics = requiredTopics.filter(topic => !serviceFiles.has(topic));
  if (missingTopics.length) throw new Error(`missing_verified_service_images:${missingTopics.join(",")}`);

  const plan = blogs.map(blog => {
    const topic = topicFor(blog.title);
    const source = serviceFiles.get(topic);
    return { blog, topic, ...source };
  });

  if (plan.length < 10 || plan.length !== blogs.length) {
    throw new Error(`incomplete_blog_image_plan:${plan.length}_of_${blogs.length}`);
  }

  const backup = {
    createdAt: new Date().toISOString(),
    tenantId,
    strategy: "verified-own-cms-service-images",
    changes: plan.map(({ blog, file, topic, serviceId, serviceTitle }) => ({
      resourceId: blog.id,
      title: blog.title,
      topic,
      sourceServiceId: serviceId,
      sourceServiceTitle: serviceTitle,
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

  if (verified !== plan.length) throw new Error(`verification_mismatch:${verified}_of_${plan.length}`);

  await client.query("COMMIT");
  console.log(JSON.stringify({
    ok: true,
    linked: plan.length,
    verified,
    strategy: "verified-own-cms-service-images",
    assignments: plan.map(item => ({ title: item.blog.title, image: item.serviceTitle }))
  }));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
