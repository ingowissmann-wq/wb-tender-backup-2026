import pg from "pg";
import { readFileSync } from "node:fs";
import { resolvePortalEvidence, safeEvidenceUrl } from "../platform/portal-evidence.mjs";

const apply = process.argv.includes("--apply");
const connectionString = process.env.DATABASE_URL || (process.env.DATABASE_URL_FILE
  ? readFileSync(process.env.DATABASE_URL_FILE, "utf8").toString().trim() : null);
const pool = new pg.Pool(connectionString ? { connectionString, max: 2 } : {
  host: process.env.RECOVERY_DB_HOST, port: Number(process.env.RECOVERY_DB_PORT || 5432),
  user: process.env.RECOVERY_DB_USER || "postgres", database: process.env.RECOVERY_DB_NAME || "postgres",
  password: readFileSync(process.env.RECOVERY_DB_PASSWORD_FILE, "utf8").toString().trim(), max: 2,
});
const fields = ["publication-number", "links", "document-url-lot", "document-restricted-url-lot", "submission-url-lot", "buyer-profile"];
const json = (value) => JSON.stringify(value ?? {}), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = { days: 0, notices: 0, matched: 0, unique: 0, review: 0, notFound: 0, changed: 0, links: 0 };

async function request(body) {
  for (let attempt = 0; attempt < 7; attempt++) {
    const response = await fetch("https://api.ted.europa.eu/v3/notices/search", {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "WB-Tender-Recovery/1.0" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return response.json();
    if (response.status !== 429 && response.status < 500) throw new Error(`TED_HTTP_${response.status}`);
    const retry = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(60_000, retry * 1000) : Math.min(30_000, 1000 * 2 ** attempt));
  }
  throw new Error("TED_RETRY_EXHAUSTED");
}

async function persist(client, row, resolution) {
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
    [row.tender_id, row.tender_version_id, resolution.portal?.id || null, chosen?.host || null, chosen?.url || null,
      chosen?.role || null, chosen?.priority || null, resolution.status,
      json({ sourceCode: "TED", officialSearchApiV3: true, candidates: resolution.candidates.map((item) => ({ portalId: item.portal.id, host: item.host, url: item.url, role: item.role, priority: item.priority, path: item.path })) }), resolution.evidenceSha256]);
  stats.changed += saved.rowCount;
  for (const link of resolution.links) {
    const url = safeEvidenceUrl(link.url); if (!url) continue;
    const role = link.role === "PARTICIPATION" ? "BUYER_COMMUNICATION" : link.role,
      host = new URL(url).hostname.toLowerCase(),
      evidence = { path: link.evidencePath, priority: link.priority, sourceCode: "TED", officialSearchApiV3: true },
      evidenceSha = (await client.query("select encode(digest($1,'sha256'),'hex') hash", [json(evidence)])).rows[0].hash;
    const inserted = await client.query(`INSERT INTO tender.tender_external_links
      (tender_id,tender_version_id,role,original_url,original_host,public_access,verification_status,evidence,evidence_sha256)
      VALUES($1,$2,$3,$4,$5,true,'DISCOVERED',$6::jsonb,$7)
      ON CONFLICT(tender_version_id,source_lot_id,role,original_url) DO NOTHING`,
    [row.tender_id, row.tender_version_id, role, url, host, json(evidence), evidenceSha]);
    stats.links += inserted.rowCount;
  }
}

try {
  const portals = (await pool.query("select * from tender.portal_registry order by id")).rows;
  const days = (await pool.query("select distinct publication_date::text publication_day from tender.tenders where source_code='TED' and data_class='PUBLIC_REAL' and publication_date is not null order by publication_day")).rows.map((row) => row.publication_day);
  for (const day of days) {
    let token = null;
    do {
      const payload = await request({ query: `publication-date = ${day.replaceAll("-", "")} AND place-of-performance IN (DE*)`, fields, limit: 250, scope: "ALL", checkQuerySyntax: false, paginationMode: "ITERATION", ...(token ? { iterationNextToken: token } : {}) });
      const notices = payload.notices || []; stats.notices += notices.length;
      for (let offset = 0; offset < notices.length; offset += 100) {
        const batch = notices.slice(offset, offset + 100), ids = batch.map((item) => String(item["publication-number"] || "")).filter(Boolean);
        const rows = (await pool.query(`select tender.id tender_id,tender.external_id,version.id tender_version_id
          from tender.tenders tender join lateral(select item.id from tender.tender_versions item where item.tender_id=tender.id order by item.version desc limit 1)version on true
          where tender.source_code='TED' and tender.external_id=any($1::text[])`, [ids])).rows;
        const byId = new Map(rows.map((row) => [row.external_id, row])), client = apply ? await pool.connect() : null;
        try {
          if (client) await client.query("begin");
          for (const notice of batch) {
            const row = byId.get(String(notice["publication-number"] || "")); if (!row) continue;
            stats.matched++;
            const resolution = resolvePortalEvidence({ sourceCode: "TED", sourceUrl: "https://api.ted.europa.eu/v3/notices/search", normalizedData: notice, portals });
            if (resolution.status === "UNIQUE_EVIDENCE") stats.unique++; else if (resolution.status === "REVIEW_REQUIRED") stats.review++; else stats.notFound++;
            if (client) await persist(client, row, resolution);
          }
          if (client) await client.query("commit");
        } catch (error) { if (client) await client.query("rollback"); throw error; } finally { client?.release(); }
      }
      token = notices.length ? payload.iterationNextToken || null : null;
    } while (token);
    stats.days++; console.log(JSON.stringify({ progress: true, day, ...stats }));
  }
  console.log(JSON.stringify({ completed: true, apply, ...stats }));
} finally { await pool.end(); }
