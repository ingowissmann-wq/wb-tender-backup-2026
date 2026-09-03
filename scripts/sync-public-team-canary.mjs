import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const client=await pool.connect();
const db=new DatabaseSync(process.env.CAREER_DATABASE_PATH || "/data/career.db",{readOnly:true});

try {
  const rows=db.prepare("SELECT id,payload,status,sort_order,created_at,updated_at FROM content_items WHERE collection='teammembers' ORDER BY sort_order,id").all();
  if(rows.length!==6) throw new Error(`expected_6_sqlite_team_rows_found_${rows.length}`);
  const items=rows.map(row=>({row,data:JSON.parse(row.payload)}));
  const expected=["Inna Bohuslavska","Swen Ahlgrimm","Kateryna Wissmann","Simon Bayer","Karl Heinz Krenke","Dr. Ingo Wissmann"];
  const names=items.map(item=>String(item.data.name || item.data.fullName || ""));
  for(const name of expected) if(!names.includes(name)) throw new Error(`sqlite_team_missing_${name}`);

  await client.query("BEGIN");
  const tenants=(await client.query("SELECT tenant_id,count(*)::int AS total FROM files.objects WHERE tenant_id IS NOT NULL GROUP BY tenant_id ORDER BY total DESC")).rows;
  if(tenants.length!==1) throw new Error(`isolated_canary_tenant_not_unique:${tenants.length}`);
  const tenantId=tenants[0].tenant_id;
  const owner=(await client.query("SELECT id FROM iam.users WHERE lower(email)=lower($1) LIMIT 1",["admin@wb-holding.ag"])).rows[0];
  if(!owner) throw new Error("isolated_admin_owner_missing");

  for(const {row,data} of items) {
    const name=String(data.name || data.fullName || "").trim();
    const imageId=String(data.imageId || "").trim();
    const profilePicture=String(data.profilePicture || data.imageUrl || "").trim();
    if(!name || !imageId || profilePicture!==`/cms-media/${imageId}`) throw new Error(`invalid_sqlite_team_payload:${name}`);
    const media=(await client.query("SELECT id FROM files.objects WHERE id=$1 AND tenant_id=$2 AND protection_class='public' AND deleted_at IS NULL",[imageId,tenantId])).rows[0];
    if(!media) throw new Error(`team_media_missing:${name}`);

    const normalized={...data,name,fullName:name,imageId,imageUrl:profilePicture,profilePicture,imageAlt:String(data.imageAlt || name),status:"published",sortOrder:Number(data.sortOrder)};
    const current=(await client.query(`SELECT id FROM app.resources
      WHERE tenant_id=$1 AND resource_type='team' AND deleted_at IS NULL
        AND (external_id=$2 OR lower(title)=lower($3))
      ORDER BY CASE WHEN external_id=$2 THEN 0 ELSE 1 END LIMIT 1`,[tenantId,row.id,name])).rows[0];

    let resourceId;
    if(current) {
      resourceId=(await client.query(`UPDATE app.resources SET external_id=$1,title=$2,status='published',data=$3::jsonb,
        owner_id=COALESCE(owner_id,$4),updated_at=now(),deleted_at=NULL WHERE id=$5 RETURNING id`,
        [row.id,name,JSON.stringify(normalized),owner.id,current.id])).rows[0].id;
    } else {
      resourceId=(await client.query(`INSERT INTO app.resources(domain,resource_type,external_id,title,status,data,owner_id,created_at,updated_at,tenant_id)
        VALUES('cms','team',$1,$2,'published',$3::jsonb,$4,$5,$6,$7) RETURNING id`,
        [row.id,name,JSON.stringify(normalized),owner.id,row.created_at,row.updated_at,tenantId])).rows[0].id;
    }
    await client.query(`INSERT INTO app.resource_files(resource_id,file_id,kind,metadata,tenant_id)
      VALUES($1,$2,'profile-image',$3::jsonb,$4)
      ON CONFLICT(resource_id,file_id) DO UPDATE SET kind=EXCLUDED.kind,metadata=EXCLUDED.metadata,tenant_id=EXCLUDED.tenant_id`,
      [resourceId,imageId,JSON.stringify({altText:name,position:"profile-image"}),tenantId]);
  }

  const verify=await client.query(`SELECT title,data->>'profilePicture' AS image
    FROM app.resources WHERE tenant_id=$1 AND resource_type='team' AND status='published' AND deleted_at IS NULL
      AND external_id=ANY($2::text[])`,[tenantId,rows.map(row=>row.id)]);
  if(verify.rowCount!==6) throw new Error(`expected_6_public_team_rows_found_${verify.rowCount}`);
  for(const row of verify.rows) if(!String(row.image || "").startsWith("/cms-media/")) throw new Error(`public_team_image_missing:${row.title}`);
  await client.query("COMMIT");
  console.log(JSON.stringify({ok:true,team:6,media:6,sqliteIntegrity:db.prepare("PRAGMA integrity_check").get().integrity_check}));
} catch(error) {
  try { await client.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  db.close();
  client.release();
  await pool.end();
}
