import pg from "pg";
import { readFileSync } from "node:fs";
import { resolvePortalEvidence, safeEvidenceUrl } from "../platform/portal-evidence.mjs";

const args = new Set(process.argv.slice(2)), apply = args.has("--apply"), numberArg = (name, fallback) => {
  const item = process.argv.find((value) => value.startsWith(`${name}=`));
  return item ? Number(item.slice(name.length + 1)) : fallback;
};
const batchSize = Math.max(10, Math.min(1000, numberArg("--batch-size", 250))), maxRows = Math.max(0, numberArg("--max-rows", 0));
const connectionString = process.env.DATABASE_URL || (process.env.DATABASE_URL_FILE ? readFileSync(process.env.DATABASE_URL_FILE, "utf8").toString().trim() : null);
const pool = new pg.Pool(connectionString ? { connectionString, max: 2 } : {
  host: process.env.RECOVERY_DB_HOST, port: Number(process.env.RECOVERY_DB_PORT || 5432),
  user: process.env.RECOVERY_DB_USER || "postgres", database: process.env.RECOVERY_DB_NAME || "postgres",
  password: readFileSync(process.env.RECOVERY_DB_PASSWORD_FILE, "utf8").toString().trim(), max: 2,
});
const json = (value) => JSON.stringify(value ?? {});
const stats = { examined: 0, changed: 0, unique: 0, review: 0, notFound: 0, links: 0, lots: 0 };

const persist = async (client, row, resolution) => {
  const chosen = resolution.portalLink;
  const saved = await client.query(`INSERT INTO tender.tender_portal_resolutions
    (tender_id,tender_version_id,portal_id,exact_host,evidence_url,evidence_role,evidence_priority,resolution_status,evidence,evidence_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
    ON CONFLICT(tender_version_id) DO UPDATE SET portal_id=excluded.portal_id,exact_host=excluded.exact_host,
      evidence_url=excluded.evidence_url,evidence_role=excluded.evidence_role,evidence_priority=excluded.evidence_priority,
      resolution_status=excluded.resolution_status,evidence=excluded.evidence,evidence_sha256=excluded.evidence_sha256,updated_at=now()
    WHERE tender.tender_portal_resolutions.evidence_sha256<>excluded.evidence_sha256
       OR tender.tender_portal_resolutions.resolution_status<>excluded.resolution_status
       OR tender.tender_portal_resolutions.portal_id IS DISTINCT FROM excluded.portal_id`,
    [row.tender_id,row.tender_version_id,resolution.portal?.id||null,chosen?.host||null,chosen?.url||null,chosen?.role||null,chosen?.priority||null,resolution.status,json({sourceCode:row.source_code,sourceUrl:row.source_url,candidates:resolution.candidates.map(item=>({portalId:item.portal.id,host:item.host,url:item.url,role:item.role,priority:item.priority,path:item.path}))}),resolution.evidenceSha256]);
  stats.changed += saved.rowCount;
  for (const link of resolution.links) {
    const url=safeEvidenceUrl(link.url); if(!url) continue;
    const host=new URL(url).hostname.toLowerCase(), role=link.role==="PARTICIPATION"?"BUYER_COMMUNICATION":link.role;
    if(role==="UNKNOWN_REVIEW_REQUIRED")continue;
    const evidence={path:link.evidencePath,priority:link.priority,sourceCode:row.source_code,backfill:"full-platform-recovery-20260821"};
    const evidenceSha=(await client.query("select encode(digest($1,'sha256'),'hex') hash",[json(evidence)])).rows[0].hash;
    const inserted=await client.query(`INSERT INTO tender.tender_external_links
      (tender_id,tender_version_id,role,original_url,original_host,public_access,verification_status,evidence,evidence_sha256)
      VALUES($1,$2,$3,$4,$5,$6,'DISCOVERED',$7::jsonb,$8)
      ON CONFLICT(tender_version_id,source_lot_id,role,original_url) DO NOTHING`,
      [row.tender_id,row.tender_version_id,role,url,host,["NOTICE","NOTICE_VIEW","PUBLIC_DOCUMENT","PROCUREMENT_DOCUMENT"].includes(role),json(evidence),evidenceSha]);
    stats.links += inserted.rowCount;
  }
};

try {
  const portals=(await pool.query("select * from tender.portal_registry order by id")).rows;
  if(apply){
    const lots=await pool.query(`INSERT INTO tender.lots(tender_id,external_id,title,deadline,source_reference_id)
      SELECT lifecycle.tender_id,lifecycle.lot_key,lifecycle.lot_key,lifecycle.offer_deadline,source.id
      FROM tender.tender_lot_lifecycles lifecycle
      JOIN LATERAL(SELECT reference.id FROM tender.source_references reference WHERE reference.tender_id=lifecycle.tender_id ORDER BY reference.retrieved_at DESC,reference.id DESC LIMIT 1)source ON true
      WHERE lifecycle.is_current AND lifecycle.deadline_quality='EXACT' AND lifecycle.offer_deadline IS NOT NULL
      ON CONFLICT(tender_id,external_id) WHERE external_id IS NOT NULL DO NOTHING`);
    stats.lots=lots.rowCount;
  }
  let cursor="00000000-0000-0000-0000-000000000000";
  while(!maxRows || stats.examined<maxRows){
    const limit=maxRows?Math.min(batchSize,maxRows-stats.examined):batchSize;
    const rows=(await pool.query(`SELECT tender.id tender_id,tender.source_code,tender.source_url,version.id tender_version_id,version.normalized_data
      FROM tender.tenders tender
      JOIN LATERAL(SELECT item.id,item.normalized_data FROM tender.tender_versions item WHERE item.tender_id=tender.id ORDER BY item.version DESC LIMIT 1)version ON true
      WHERE tender.id>$1 AND tender.data_class='PUBLIC_REAL' AND tender.source_code='DOE' ORDER BY tender.id LIMIT $2`,[cursor,limit])).rows;
    if(!rows.length)break;
    const client=apply?await pool.connect():null;
    try{
      if(client)await client.query("begin");
      for(const row of rows){
        const resolution=resolvePortalEvidence({sourceCode:row.source_code,sourceUrl:row.source_url,normalizedData:row.normalized_data,portals});
        stats.examined++; if(resolution.status==="UNIQUE_EVIDENCE")stats.unique++; else if(resolution.status==="REVIEW_REQUIRED")stats.review++; else stats.notFound++;
        if(client)await persist(client,row,resolution);
      }
      if(client)await client.query("commit");
    }catch(error){if(client)await client.query("rollback");throw error}finally{client?.release()}
    cursor=rows.at(-1).tender_id;
    console.log(JSON.stringify({progress:true,cursor,...stats}));
  }
  console.log(JSON.stringify({completed:true,apply,...stats}));
} finally { await pool.end(); }
