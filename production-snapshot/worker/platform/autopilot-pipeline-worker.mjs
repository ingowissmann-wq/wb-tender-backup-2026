import crypto from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import pg from "pg";
import { createFixedScopedPool, loadBackgroundScope } from "./scoped-pg-pool.mjs";
import { readFileSync } from "node:fs";
import {
  parseDoe,
  extractNoticePortalLinkEvidence,
  parseInternalAcceptanceFixture,
  parseNotice,
  scopeFromText,
} from "./enrichment-core.mjs";
import {
  materializeAuthoritativePortalAssignments,
  persistAuthoritativePortalEvidence,
} from "./authoritative-portal-resolution.mjs";
import { parseBinaryDocumentIsolated } from "./parser-sandbox.mjs";
import { extractArchiveDocuments,inspectArchive } from "./binary-parsers.mjs";
import { buildFullTenderReview } from "./full-tender-review.mjs";
import {
  classifyTenderServices,
  relevanceSnapshotHash,
} from "./service-relevance.mjs";
import {
  canonicalPortalUrl,
  credentialJobEligibility,
  credentialPortalEligibility,
  decryptSecret,
  encryptSecret,
  testReadOnlyPortal,
} from "./portal-credentials.mjs";
import {
  authenticatePortalWithBrowser,
  classifyDeutscheEvergabeWorkflow,
  cookieHeaderForUrl,
  downloadAuthenticatedDeutscheEvergabeEvaArchive,
  downloadPublicAIBietercockpitArchive,
  downloadPublicDuesseldorfNetServerArchive,
  downloadPublicNetServerArchive,
  downloadPublicEvergabeOnlineArchive,
  restorePortalSessionWithBrowser,
} from "./semantic-browser-auth.mjs";
import {
  truthfulDocumentTest,
  safeDiagnostic,
} from "./portal-connector-platform.mjs";
import {
  buildCalculationInput,
  classifyNoticeType,
  classifyProcurementDocument,
  isExplicitlySupplied,
  nextPipelineTransition,
  resolveEffectiveParameters,
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_STEPS,
} from "./canonical-truth.mjs";
import {
  buildEffectiveCompanyProfile,
  profileParameterRows,
} from "./effective-company-profile.mjs";
import {
  buildManagementOutput,
  calculateSectorTender,
} from "./sector-calculation.mjs";
import { deriveRibSecurityLvFacts } from "./rib-security-lv.mjs";
import {
  deriveCleaningContractFacts,
  deriveCleaningRoomBookFacts,
  selectLotAuthoritativeDocuments,
  selectLotEnrichmentFields,
} from "./cleaning-room-book.mjs";
import { approvalBinding, manifestHash } from "./bid-workflow.mjs";
import { scanBuffer, scannerVersion } from "./malware-scanner.mjs";
import { enqueueVerifiedSessionFanout } from "./verified-session-fanout.mjs";
import { startRegionRecalculationWorker } from "./region-recalculation-worker.mjs";

process.env.PORTAL_CREDENTIAL_KEY_FILE ||=
  "/run/secrets/tender_portal_credential_key";

export const PIPELINE_VERSION =
  "wb-full-autopilot/6.4.0-direct-eforms-lot-identity";
const json = (value) => JSON.stringify(value ?? null).replaceAll("\\u0000", "");
const canonicalJson = (value) =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((item) => JSON.parse(canonicalJson(item)))
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, JSON.parse(canonicalJson(value[key]))]),
          )
      : (value ?? null),
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DOCUMENT_EXTENSIONS =
  /\.(pdf|docx?|xlsx?|ods|csv|xml|json|html?|zip|dwg|log|gaeb|[xdp]8[123])(?:$|[?#])/i;
const mimeExtension = new Map([
  ["application/pdf", ".pdf"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
  ],
  ["application/msword", ".doc"],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
  ],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.oasis.opendocument.spreadsheet", ".ods"],
  ["text/csv", ".csv"],
  ["application/xml", ".xml"],
  ["text/xml", ".xml"],
  ["application/json", ".json"],
  ["text/html", ".html"],
  ["application/zip", ".zip"],
  ["image/vnd.dwg", ".dwg"],
  ["text/plain", ".log"],
]);
const procurementMimeByExtension = new Map([
  [".pdf", "application/pdf"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [".doc", "application/msword"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [".xls", "application/vnd.ms-excel"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"],
  [".csv", "text/csv"],
  [".xml", "application/xml"],
  [".json", "application/json"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".zip", "application/zip"],
  [".dwg", "image/vnd.dwg"],
  [".log", "text/plain"],
  [".gaeb", "application/xml"],
  [".x81", "application/xml"],
  [".x82", "application/xml"],
  [".x83", "application/xml"],
  [".d81", "application/xml"],
  [".d82", "application/xml"],
  [".d83", "application/xml"],
  [".p81", "application/xml"],
  [".p82", "application/xml"],
  [".p83", "application/xml"],
]);
const RIB_PUBLIC_DOWNLOAD_HOSTS = new Set([
  "my.vergabe.rib.de",
  "my.vergabe.bayern.de",
  "my.vergabeplattform.berlin.de",
  "www.vergabe.stuttgart.de",
  "evergabe.hannover-stadt.de",
]);
const isRibPublicDownload = (url) =>
  url.protocol === "https:" &&
  RIB_PUBLIC_DOWNLOAD_HOSTS.has(url.hostname) &&
  /^\/remote\/download(?:_sonstige_unterlagen)?\.php$/i.test(url.pathname);
const cleanMime = (value) => {
  const mime = String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return mime.endsWith("+json")
    ? "application/json"
    : mime.endsWith("+xml")
      ? "application/xml"
      : mime;
};
const decodeHtml = (value) =>
  String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
const responseCookies = (response) =>
  (
    response.headers.getSetCookie?.() ||
    [response.headers.get("set-cookie")].filter(Boolean)
  )
    .map((value) => String(value).split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
export function validDocumentSignature(buffer, mime, name = "") {
  const head = buffer.subarray(0, 8),
    lower = String(name).toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf"))
    return head.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "application/zip" || /\.(?:docx|xlsx|ods|zip)$/.test(lower))
    return head[0] === 0x50 && head[1] === 0x4b;
  if (
    mime === "application/vnd.ms-excel" ||
    mime === "application/msword" ||
    /\.(?:xls|doc)$/.test(lower)
  )
    return head.equals(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    );
  return buffer.length > 0;
}
const safeName = (url, mime, disposition = "") => {
  const named = disposition.match(
    /filename\*?=(?:UTF-8''|["']?)([^"';]+)/i,
  )?.[1];
  let name = decodeURIComponent(
    named || new URL(url).pathname.split("/").pop() || "document",
  ).replace(/[^\p{L}\p{N}._ -]/gu, "_");
  if (!path.extname(name) && mimeExtension.has(mime))
    name += mimeExtension.get(mime);
  return name.slice(0, 240);
};
async function fetchBounded(
  url,
  { maxBytes = 50_000_000, headers = {}, method = "GET", body = null } = {},
) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method,
      body,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "WB-Tender-Autopilot/3.0 (read-only)",
        ...headers,
      },
    });
    if ([401, 403].includes(response.status))
      return {
        status: "PORTALZUGANG_ERFORDERLICH",
        httpStatus: response.status,
      };
    if (response.status === 404)
      return { status: "DOKUMENT_NOCH_NICHT_VERÖFFENTLICHT", httpStatus: 404 };
    if (!response.ok)
      return { status: "DOWNLOAD_FEHLGESCHLAGEN", httpStatus: response.status };
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes)
      return {
        status: "DOWNLOAD_FEHLGESCHLAGEN",
        httpStatus: response.status,
        error: "document_size_invalid",
      };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes)
      return {
        status: "DOWNLOAD_FEHLGESCHLAGEN",
        httpStatus: response.status,
        error: "document_size_invalid",
      };
    return {
      status: "FETCHED",
      httpStatus: response.status,
      url: response.url,
      mime: cleanMime(response.headers.get("content-type")),
      disposition: response.headers.get("content-disposition") || "",
      cookie: responseCookies(response),
      buffer,
    };
  } catch (error) {
    return {
      status: "DOWNLOAD_FEHLGESCHLAGEN",
      error:
        error.name === "AbortError"
          ? "download_timeout"
          : String(error.message).slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}
let nextTedNoticeFetchAt=0;
const waitFor=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fetchTedNoticeBounded(url,{maxBytes=20_000_000}={}){
  let fetched;
  for(let attempt=0;attempt<4;attempt+=1){
    const pacingDelay=Math.max(0,nextTedNoticeFetchAt-Date.now());
    if(pacingDelay)await waitFor(pacingDelay);
    nextTedNoticeFetchAt=Date.now()+1_100;
    fetched=await fetchBounded(url,{maxBytes});
    if(fetched.status==="FETCHED")return fetched;
    const transient=!fetched.httpStatus||[408,425,429,500,502,503,504].includes(fetched.httpStatus);
    if(!transient)break;
    await waitFor(1_500*(attempt+1));
  }
  return fetched;
}
async function fetchRibDownload(
  url,
  { maxBytes = 50_000_000, cookie = "" } = {},
) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "my.vergabe.rib.de" ||
    !/^\/remote\/download(?:_sonstige_unterlagen)?\.php$/i.test(target.pathname)
  )
    return fetchBounded(url, { maxBytes });
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const first = await fetch(target, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": "WB-Tender-Autopilot/3.0 (read-only)",
        ...(cookie ? { cookie } : {}),
      },
    });
    if (![301, 302, 303, 307, 308].includes(first.status)) {
      const buffer = Buffer.from(await first.arrayBuffer());
      return {
        status: first.ok ? "FETCHED" : "DOWNLOAD_FEHLGESCHLAGEN",
        httpStatus: first.status,
        url: first.url,
        mime: cleanMime(first.headers.get("content-type")),
        disposition: first.headers.get("content-disposition") || "",
        buffer,
      };
    }
    const location = new URL(first.headers.get("location") || "", target);
    if (
      location.protocol !== "https:" ||
      location.hostname !== "my.vergabe.rib.de"
    )
      return {
        status: "DOWNLOAD_FEHLGESCHLAGEN",
        httpStatus: first.status,
        error: "rib_redirect_domain_invalid",
      };
    const redirectCookie = responseCookies(first),
      effectiveCookie = redirectCookie || cookie;
    return fetchBounded(location.href, {
      maxBytes,
      headers: effectiveCookie ? { cookie: effectiveCookie } : {},
    });
  } catch (error) {
    return {
      status: "DOWNLOAD_FEHLGESCHLAGEN",
      error:
        error.name === "AbortError"
          ? "download_timeout"
          : String(error.message).slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}
export function htmlLinks(buffer, base) {
  const html = buffer.toString("utf8"),
    linkHtml = html.replaceAll("\\/", "/").replaceAll('\\"', '"');
  const links = [];
  for (const match of linkHtml.matchAll(
    /(?:href|data-download-url)=["']([^"']+)["']/gi,
  )) {
    try {
      const url = new URL(decodeHtml(match[1]), base);
      url.pathname = url.pathname.replace(/;jsessionid=[^/?#]+/i, "");
      const ribDownload = isRibPublicDownload(url),
        evergabeDownload =
          url.protocol === "https:" &&
          url.hostname === "www.evergabe.de" &&
          /^\/unterlagen\/\d+\/download\/\d+/i.test(url.pathname),
        aumassDownload =
          url.protocol === "https:" &&
          url.hostname === "plattform.aumass.de" &&
          url.pathname === "/Document/GetDocument" &&
          url.searchParams.get("doctype") === "allfiles" &&
          /^[A-Z0-9._-]{3,80}$/i.test(url.searchParams.get("aumassid") || "");
      if (DOCUMENT_EXTENSIONS.test(url.href) || ribDownload || evergabeDownload || aumassDownload)
        links.push(url.href);
    } catch {}
  }
  const projectId =
      html.match(/<th>VerfahrensID<\/th>\s*<td>([^<]+)/i)?.[1]?.trim() || null,
    procurementId =
      html.match(/<th>Vergabe-Nr\.<\/th>\s*<td>([^<]+)/i)?.[1]?.trim() || null;
  const orderRequired =
      /Vergabeunterlagen anfordern|Unterlagen zur Ansicht herunterladen/i.test(
        html,
      ),
    externalRequestRequired =
      /<form\b[^>]*\bid=["']purchase["'][^>]*>/i.test(html) && orderRequired;
  return {
    protected:
      links.length === 0 &&
      /(?:<input\b[^>]*\btype=["']password["']|<input\b[^>]*\bname=["'][^"']*(?:passwort|password)[^"']*["']|captcha)/i.test(
        html,
      ),
    links: [...new Set(links)].slice(0, 100),
    projectId,
    procurementId,
    directKiosk: /Vergabe24 Direkt-Kiosk/i.test(html),
    orderRequired,
    externalRequestRequired,
    expired: /Verfahren ist bereits abgelaufen/i.test(html),
  };
}
const normalizedWords = (value) =>
  new Set(
    String(value || "")
      .toLocaleLowerCase("de")
      .normalize("NFKD")
      .replace(/[^a-z0-9äöüß]+/gi, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
async function locateRibPublicTender(pool, enrichment, landing) {
  const direct = new URL(landing.url),
    html = landing.buffer.toString("utf8");
  if (
    direct.hostname !== "www.meinauftrag.rib.de" ||
    direct.pathname !== "/public/publications"
  )
    return {
      status: "DIRECT_DETAIL",
      fetched: landing,
      evidence: { directUrl: landing.url },
    };
  const tender =
    (
      await pool.query(
        "SELECT title,notice_number,external_id,buyer FROM tender.tenders WHERE id=$1",
        [enrichment.tender_id],
      )
    ).rows[0] || {};
  const csrf = html.match(
    /value=["']([a-f0-9]{32,})["']\s+name=["']YII_CSRF_TOKEN["']/i,
  )?.[1];
  if (!csrf)
    return {
      status: "SEARCH_UNAVAILABLE",
      evidence: {
        directReferenceRedirected: true,
        searchEndpoint: "/public/publications",
        reason: "CSRF_TOKEN_NOT_FOUND",
      },
    };
  const candidates = [
    tender.notice_number,
    tender.external_id,
    String(tender.title || "").replace(
      /^Deutschland\s*[–-]\s*[^–-]+\s*[–-]\s*/i,
      "",
    ),
  ].filter(Boolean);
  const targetWords = normalizedWords(tender.title),
    attempts = [];
  for (const keyword of candidates) {
    const form = new URLSearchParams({
      YII_CSRF_TOKEN: csrf,
      "TenderSearchForm[keyword]": String(keyword),
      "TenderSearchForm[hideTrial]": "1",
      "TenderSearchForm[orderBy]": "created desc",
    });
    const searched = await fetchBounded(
      "https://www.meinauftrag.rib.de/public/publications",
      {
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(landing.cookie ? { cookie: landing.cookie } : {}),
        },
        method: "POST",
        body: form,
      },
    );
    if (searched.status !== "FETCHED") {
      attempts.push({ keyword, result: searched.status });
      continue;
    }
    const resultHtml = searched.buffer.toString("utf8"),
      matches = [
        ...resultHtml.matchAll(
          /href=["'](\/public\/publications\/(\d+))["']/gi,
        ),
      ].map((match) => ({
        href: match[1],
        id: match[2],
        offset: match.index || 0,
      }));
    const unique = [
      ...new Map(matches.map((match) => [match.id, match])).values(),
    ];
    attempts.push({ keyword, result: "FETCHED", matches: unique.length });
    let best = null;
    for (const match of unique) {
      const fragment = resultHtml.slice(
          Math.max(0, match.offset - 2500),
          match.offset + 1000,
        ),
        words = normalizedWords(fragment),
        overlap = [...targetWords].filter((word) => words.has(word)).length,
        score = targetWords.size ? overlap / targetWords.size : 0;
      if (!best || score > best.score) best = { ...match, score };
    }
    if (best && best.score >= 0.45) {
      const detailUrl = new URL(best.href, "https://www.meinauftrag.rib.de")
          .href,
        detail = await fetchBounded(detailUrl, {
          headers: landing.cookie ? { cookie: landing.cookie } : {},
        });
      if (
        detail.status === "FETCHED" &&
        new URL(detail.url).pathname !== "/public/publications"
      )
        return {
          status: "TENDER_LOCATED_BY_SEARCH",
          fetched: detail,
          evidence: {
            directReferenceRedirected: true,
            detailUrl,
            score: best.score,
            attempts,
          },
        };
    }
  }
  return {
    status: "DOCUMENT_NOT_FOUND",
    evidence: {
      directReferenceRedirected: true,
      originalTenderReference: direct.href,
      searchEndpoint: "https://www.meinauftrag.rib.de/public/publications",
      searchAttempts: attempts,
      identifiers: {
        noticeNumber: tender.notice_number || null,
        externalId: tender.external_id || null,
        title: tender.title || null,
        buyer: tender.buyer || null,
      },
    },
  };
}
export async function parseFetched(fetchResult) {
  let mime =
    fetchResult.mime === "application/octet-stream"
      ? cleanMime(
          [...mimeExtension].find(([, ext]) =>
            fetchResult.url.toLowerCase().includes(ext),
          )?.[0],
        )
      : fetchResult.mime;
  const name = safeName(fetchResult.url, mime, fetchResult.disposition),
    lower = name.toLowerCase();
  if (!mime)
    mime = [...mimeExtension].find(([, ext]) => lower.endsWith(ext))?.[0] || "";
  const extension = path.extname(lower);
  if (
    (!mime || mime === "application/octet-stream") &&
    procurementMimeByExtension.has(extension)
  )
    mime = procurementMimeByExtension.get(extension);
  if (
    lower.endsWith(".xlsx") &&
    [
      "application/x-msexcel",
      "application/vnd.ms-excel",
      "application/vnd.ms-office",
      "application/octet-stream",
    ].includes(mime)
  )
    mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (
    lower.endsWith(".docx") &&
    ["application/msword", "application/vnd.ms-office", "application/octet-stream"].includes(mime)
  )
    mime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (!mimeExtension.has(mime))
    throw Object.assign(Error("downloaded document type is not accepted"), {
      code: "DOCUMENT_TYPE_REJECTED",
    });
  if(mime==="application/zip"&&fetchResult.buffer.length>100*1024*1024){
    try{
      const archive=await inspectArchive(fetchResult.buffer);
      return {status:"QUARANTINED_PENDING_LEAF_SCAN",name,mime,buffer:fetchResult.buffer,
        malwareScan:{status:"PENDING_LEAF_SCAN",engine:"clamd"},parsed:{type:"ZIP",archive,manualReview:false}};
    }catch(error){throw Object.assign(Error("large archive failed bounded structural validation"),{code:"ARCHIVE_STRUCTURAL_VALIDATION_FAILED",cause:error})}
  }
  const malwareScan = await scanBuffer(fetchResult.buffer);
  if (malwareScan.status !== "CLEAN")
    throw Object.assign(
      Error("downloaded document failed fail-closed malware validation"),
      {
        code:
          malwareScan.status === "INFECTED"
            ? "MALWARE_DETECTED"
            : "MALWARE_SCANNER_UNAVAILABLE",
      },
    );
  try {
    return {
      status: "VORHANDEN",
      name,
      mime,
      buffer: fetchResult.buffer,
      malwareScan,
      parsed: await parseBinaryDocumentIsolated(
        { buffer: fetchResult.buffer, name, mediaType: mime },
        { timeoutMs: 30_000, maxOldGenerationSizeMb: 256 },
      ),
    };
  } catch (error) {
    return {
      status: "PARSER_FEHLER",
      name,
      mime,
      buffer: fetchResult.buffer,
      error: String(error.message).slice(0, 120),
    };
  }
}
export async function recoverStoredParserFailures(
  pool,
  enrichmentId = null,
  { parse = parseFetched, verifiedOnly = false, safeRelevantOnly = false, batchSize = 4 } = {},
) {
  const rows = (
    await pool.query(
      `SELECT id,enrichment_version_id,source_url,filename,mime_type,payload_sha256,content,extracted_data
    FROM tender.enrichment_documents
    WHERE fetch_status='PARSER_FEHLER' AND content IS NOT NULL AND payload_sha256 IS NOT NULL
      AND ($1::uuid IS NULL OR enrichment_version_id=$1)
      AND ($2::boolean=false OR (procurement_relevant AND procurement_verification_status='VERIFIED'))
      AND ($3::boolean=false OR (procurement_relevant AND tender_association_verified AND magic_bytes_verified
        AND EXISTS(SELECT 1 FROM tender.document_malware_scans scan
          WHERE scan.document_id=enrichment_documents.id
            AND scan.payload_sha256=enrichment_documents.payload_sha256 AND scan.status='CLEAN')))
      AND coalesce(CASE WHEN provenance#>>'{parserRecoveryLastAttempt,at}' ~ '^\\d{4}-\\d{2}-\\d{2}T'
          THEN (provenance#>>'{parserRecoveryLastAttempt,at}')::timestamptz END,'epoch'::timestamptz)
        < now()-interval '6 hours'
    ORDER BY id LIMIT $4 FOR UPDATE`,
      [enrichmentId, verifiedOnly, safeRelevantOnly, Math.max(1, Math.min(16, Number(batchSize) || 4))],
    )
  ).rows;
  const summary = {
    attempted: rows.length,
    recovered: 0,
    failed: 0,
    hashMismatch: 0,
    failureCodes: {},
  };
  for (const row of rows) {
    const actualHash = crypto
      .createHash("sha256")
      .update(row.content)
      .digest("hex");
    if (actualHash !== row.payload_sha256) {
      summary.hashMismatch++;
      summary.failed++;
      continue;
    }
    try {
      const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(row.filename || "document")}`;
      const parsed = await parse({
        url: row.source_url,
        mime: row.mime_type,
        disposition,
        buffer: row.content,
      });
      if (
        parsed.status !== "VORHANDEN" ||
        !parsed.parsed ||
        !parsed.parsed.type
      )
        throw new Error(parsed.error || "parser_recovery_failed");
      const update = await pool.query(
        `UPDATE tender.enrichment_documents SET
        fetch_status='VORHANDEN',resolution_status='DOWNLOAD_SUCCEEDED',extracted_data=$2::jsonb,
        parser=$3,parser_version=$4,retrieved_at=now(),
        provenance=provenance||$5::jsonb
        WHERE id=$1 AND fetch_status='PARSER_FEHLER'`,
        [
          row.id,
          json(parsed.parsed),
          parsed.parsed.type,
          parsed.parsed.parserVersion || PIPELINE_VERSION,
          json({
            parserRecovery: {
              previousError: row.extracted_data?.error || "PARSER_FEHLER",
              recoveredAt: new Date().toISOString(),
              contentHashVerified: true,
              malwareScanStatus: parsed.malwareScan?.status || null,
              externalWrite: false,
            },
          }),
        ],
      );
      if (update.rowCount === 1) summary.recovered++;
    } catch (error) {
      summary.failed++;
      const rawCode=String(error.code||error.message||"parser_recovery_failed").slice(0,80);
      const safeCode=/^[A-Za-z0-9_ -]+$/.test(rawCode)?rawCode:"PARSER_RECOVERY_FAILED";
      summary.failureCodes[safeCode]=(summary.failureCodes[safeCode]||0)+1;
      await pool.query(
        `UPDATE tender.enrichment_documents SET provenance=provenance||$2::jsonb
        WHERE id=$1 AND fetch_status='PARSER_FEHLER'`,
        [
          row.id,
          json({
            parserRecoveryLastAttempt: {
              at: new Date().toISOString(),
              safeError: String(
                error.code || error.message || "parser_recovery_failed",
              ).slice(0, 120),
              externalWrite: false,
            },
          }),
        ],
      );
    }
  }
  return summary;
}
export function resolveSingleLotBinding(existingLotId, selected = []) {
  if (existingLotId) {
    const matched = selected.find(
      (item) =>
        String(item?.lot?.id || item?.lotId || "") === String(existingLotId),
    );
    return {
      lotId: existingLotId,
      lotKey: matched?.lotKey || matched?.lot?.lot_key || null,
      source: "PARENT_DOCUMENT",
    };
  }
  if (selected.length !== 1)
    return { lotId: null, lotKey: null, source: "UNRESOLVED" };
  return {
    lotId: selected[0]?.lot?.id || null,
    lotKey: selected[0]?.lotKey || selected[0]?.lot?.lot_key || null,
    source: "SINGLE_SELECTED_LOT",
  };
}
export function resolveArchiveChildLotBinding(
  archivePath,
  existingLotId,
  selected = [],
) {
  const base = resolveSingleLotBinding(existingLotId, selected),
    text = String(archivePath || "");
  const explicit = explicitArchiveLotNumber(text);
  if (!explicit) return base;
  if (selected.length !== 1)
    return existingLotId
      ? { ...base, source: "PARENT_DOCUMENT_EXPLICIT_PATH" }
      : { lotId: null, lotKey: null, source: "EXPLICIT_LOT_UNRESOLVED" };
  const selectedNumber = String(
    selected[0]?.lotKey ||
      selected[0]?.lot?.lot_key ||
      selected[0]?.lot?.lot_number ||
      "",
  ).match(/(\d+)$/)?.[1];
  if (selectedNumber && Number(selectedNumber) === Number(explicit))
    return { ...base, source: "EXPLICIT_PATH_MATCHED_SELECTED_LOT" };
  return { lotId: null, lotKey: null, source: "EXPLICIT_PATH_CONFLICT" };
}
export function resolveAuthoritativeArchiveLotBinding(
  archivePath,
  availableLots = [],
) {
  const explicit = explicitArchiveLotNumber(archivePath);
  if (!explicit) return { lotId: null, lotKey: null, source: "TENDER_GLOBAL" };
  const matches = availableLots.filter(
    (item) =>
      Number(
        String(item.lotKey || item.lot_key || item.lot?.lot_key || "").match(
          /(\d+)$/,
        )?.[1],
      ) === Number(explicit),
  );
  return matches.length === 1
    ? {
        lotId: matches[0].lotId || matches[0].id || matches[0].lot?.id || null,
        lotKey:
          matches[0].lotKey ||
          matches[0].lot_key ||
          matches[0].lot?.lot_key ||
          null,
        source: "AUTHORITATIVE_EXPLICIT_LOT",
      }
    : { lotId: null, lotKey: null, source: "EXPLICIT_LOT_UNRESOLVED" };
}
export const explicitArchiveLotNumber = (archivePath) =>
  String(archivePath || "").match(
    /(?:^|[\\/_\s-])(?:los|lot|l)[\s_-]*0*(\d{1,4})(?=$|[\\/_\s.-])/i,
  )?.[1] || null;
const archiveLotTokens = (value) =>
  new Set(
    String(value || "")
      .toLocaleLowerCase("de")
      .normalize("NFKD")
      .replace(/[^a-z0-9äöüß]+/gi, " ")
      .split(/\s+/)
      .filter(
        (token) =>
          (token.length > 2 || /^\d+$/.test(token)) &&
          !/^(?:los|lot|objektdatenblatt|gebaeudereinigung|gebäudereinigung|raumbuch|fin|xlsx|pdf|leistungsbeschreibungen|vom|unternehmen|auszufuellende|dokumente)$/.test(
            token,
          ),
      ),
  );
export function inferArchiveLotNumber(archivePath, allArchivePaths = []) {
  if (explicitArchiveLotNumber(archivePath))
    return explicitArchiveLotNumber(archivePath);
  const tokens = archiveLotTokens(archivePath),
    byLot = new Map();
  for (const candidate of allArchivePaths) {
    const lot = explicitArchiveLotNumber(candidate);
    if (!lot) continue;
    const overlap = [...archiveLotTokens(candidate)].filter((token) =>
      tokens.has(token),
    ).length;
    if (overlap >= 1) byLot.set(lot, Math.max(overlap, byLot.get(lot) || 0));
  }
  const scores = [...byLot]
    .map(([lot, overlap]) => ({ lot, overlap }))
    .sort((a, b) => b.overlap - a.overlap);
  return scores[0] && (!scores[1] || scores[0].overlap > scores[1].overlap)
    ? scores[0].lot
    : null;
}
async function materializeArchiveChildren(pool, enrichmentId, selected = []) {
  const availableLots = (
    await pool.query(
      "SELECT id,lot_key FROM tender.enrichment_lots WHERE enrichment_version_id=$1",
      [enrichmentId],
    )
  ).rows.map((row) => ({ lotId: row.id, lotKey: row.lot_key }));
  const archives = (
    await pool.query(
      `SELECT a.id,a.lot_id,a.source_url,a.filename,a.content,a.payload_sha256,a.provenance FROM tender.enrichment_documents a WHERE a.enrichment_version_id=$1 AND lower(a.filename) LIKE '%.zip' AND a.content IS NOT NULL AND a.payload_sha256 IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tender.enrichment_documents child WHERE child.enrichment_version_id=a.enrichment_version_id AND child.provenance->>'parentDocumentHash'=a.payload_sha256)`,
      [enrichmentId],
    )
  ).rows;
  for (const archive of archives) {
    let children;
    try {
      children = await extractArchiveDocuments(archive.content);
    } catch (error) {
      await pool.query(
        "UPDATE tender.enrichment_documents SET fetch_status='PARSER_FEHLER',provenance=provenance||$2::jsonb WHERE id=$1",
        [
          archive.id,
          json({
            archiveExtractionError: String(error.message).slice(0, 120),
            archiveExtractionVersion: PIPELINE_VERSION,
          }),
        ],
      );
      continue;
    }
    const archivePaths = children.map((child) => child.archivePath);
    for (const child of children) {
      const inferredLot = inferArchiveLotNumber(
          child.archivePath,
          archivePaths,
        ),
        binding = resolveAuthoritativeArchiveLotBinding(
          inferredLot && !explicitArchiveLotNumber(child.archivePath)
            ? `Los ${inferredLot}/${child.archivePath}`
            : child.archivePath,
          availableLots,
        );
      const parsed = await parseFetched({
          url: `https://archive.invalid/${encodeURIComponent(child.name)}`,
          mime: child.mediaType,
          disposition: `attachment; filename*=UTF-8''${encodeURIComponent(child.name)}`,
          buffer: child.buffer,
        }),
        hash = crypto.createHash("sha256").update(child.buffer).digest("hex"),
        sourceUrl = `archive://${archive.payload_sha256}/${encodeURIComponent(child.archivePath)}`;
      await pool.query(
        `INSERT INTO tender.enrichment_documents(enrichment_version_id,lot_id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,content,extracted_data,parser,parser_version,retrieved_at,provenance,resolution_status) VALUES($1,$2,$3,'PORTAL_TENDER_DOCUMENT',$4,$5,200,$6,$7,$8,$9::jsonb,$10,$11,now(),$12::jsonb,'DOWNLOAD_SUCCEEDED') ON CONFLICT(enrichment_version_id,source_url) DO UPDATE SET lot_id=excluded.lot_id,filename=excluded.filename,fetch_status=excluded.fetch_status,mime_type=excluded.mime_type,payload_sha256=excluded.payload_sha256,content=excluded.content,extracted_data=excluded.extracted_data,parser=excluded.parser,parser_version=excluded.parser_version,retrieved_at=excluded.retrieved_at,provenance=excluded.provenance,resolution_status=excluded.resolution_status`,
        [
          enrichmentId,
          binding.lotId,
          sourceUrl,
          child.name,
          parsed.status,
          parsed.mime,
          hash,
          child.buffer,
          json(parsed.parsed || { error: parsed.error }),
          parsed.parsed?.type || null,
          parsed.parsed?.parserVersion || PIPELINE_VERSION,
          json({
            ...archive.provenance,
            lotKey: binding.lotKey,
            lotScope:
              binding.source === "TENDER_GLOBAL" ? "TENDER_GLOBAL" : "LOT",
            lotBindingSource: binding.source,
            inferredArchiveLotNumber: inferredLot,
            parentDocumentId: archive.id,
            parentDocumentHash: archive.payload_sha256,
            archivePath: child.archivePath,
            archiveDepth: child.depth,
            signatureVerified: validDocumentSignature(
              child.buffer,
              parsed.mime,
              child.name,
            ),
            extractedFromArchive: true,
            malwareScanStatus:parsed.malwareScan?.status||null,
            malwareScanEngine:parsed.malwareScan?.engine||null,
            externalWrite: false,
          }),
        ],
      );
    }
    const materialized=(await pool.query(`SELECT count(*)::int count,
      bool_and(provenance->>'malwareScanStatus'='CLEAN') all_clean
      FROM tender.enrichment_documents WHERE enrichment_version_id=$1
        AND provenance->>'parentDocumentHash'=$2`,[enrichmentId,archive.payload_sha256])).rows[0];
    const leafValidated=archive.provenance?.malwareScanStatus==="PENDING_LEAF_SCAN"&&
      Number(materialized?.count||0)===children.length&&materialized?.all_clean===true;
    const archiveEvidence=json({archiveExtractionVersion:PIPELINE_VERSION,
      archiveChildrenMaterialized:children.length,archiveExtractedAt:new Date().toISOString(),
      ...(leafValidated?{malwareScanStatus:"CLEAN_BY_BOUNDED_LEAF_SCAN",malwareScanEngine:"clamd",leafScanCount:children.length}:{}),
    });
    if(leafValidated)await pool.query(`WITH parent AS(
      UPDATE tender.enrichment_documents SET fetch_status='VORHANDEN',resolution_status='DOWNLOAD_SUCCEEDED',
        procurement_relevant=false,procurement_verification_status='GENERAL_PORTAL_DOCUMENT',
        provenance=provenance||$2::jsonb WHERE id=$1 RETURNING id,payload_sha256)
      UPDATE tender.document_malware_scans scan SET status='QUARANTINED',
        detail_code='CONTAINER_REPLACED_BY_CLEAN_LEAF_SCANS',next_retry_at='infinity'::timestamptz
      FROM parent WHERE scan.document_id=parent.id AND scan.payload_sha256=parent.payload_sha256
        AND scan.status IN('PENDING','SCAN_ERROR','QUARANTINED')`,[archive.id,archiveEvidence]);
    else await pool.query("UPDATE tender.enrichment_documents SET provenance=provenance||$2::jsonb WHERE id=$1",[archive.id,archiveEvidence]);
  }
}
async function rebindMaterializedArchiveChildren(
  pool,
  enrichmentId,
  selected = [],
) {
  const rows = (
    await pool.query(
      "SELECT id,lot_id,provenance FROM tender.enrichment_documents WHERE enrichment_version_id=$1 AND provenance->>'extractedFromArchive'='true'",
      [enrichmentId],
    )
  ).rows;
  const availableLots = (
      await pool.query(
        "SELECT id,lot_key FROM tender.enrichment_lots WHERE enrichment_version_id=$1",
        [enrichmentId],
      )
    ).rows.map((row) => ({ lotId: row.id, lotKey: row.lot_key })),
    archivePaths = rows
      .map((row) => row.provenance?.archivePath)
      .filter(Boolean);
  for (const row of rows) {
    const explicit = explicitArchiveLotNumber(row.provenance?.archivePath),
      inferred = inferArchiveLotNumber(
        row.provenance?.archivePath,
        archivePaths,
      ),
      pathForBinding =
        inferred && !explicit
          ? `Los ${inferred}/${row.provenance?.archivePath}`
          : row.provenance?.archivePath,
      binding = resolveAuthoritativeArchiveLotBinding(
        pathForBinding,
        availableLots,
      );
    if (
      String(row.lot_id || "") === String(binding.lotId || "") &&
      row.provenance?.lotBindingSource === binding.source &&
      String(row.provenance?.inferredArchiveLotNumber || "") ===
        String(inferred || "")
    )
      continue;
    await pool.query(
      "UPDATE tender.enrichment_documents SET lot_id=$2::uuid,lot_association_verified=($2::uuid IS NOT NULL),provenance=provenance||$3::jsonb WHERE id=$1",
      [
        row.id,
        binding.lotId,
        json({
          lotKey: binding.lotKey,
          lotScope:
            binding.source === "TENDER_GLOBAL" ? "TENDER_GLOBAL" : "LOT",
          lotBindingSource: binding.source,
          inferredArchiveLotNumber: inferred,
          lotBindingRevalidatedAt: new Date().toISOString(),
        }),
      ],
    );
  }
}
async function loadNotice(pool, tender) {
  if (tender.data_class === "INTERNAL_ACCEPTANCE_FIXTURE") {
    const fixture = (
      await pool.query(
        "SELECT manifest,manifest_sha256 FROM tender.internal_acceptance_fixtures WHERE tender_id=$1",
        [tender.id],
      )
    ).rows[0];
    if (!fixture) throw new Error("internal_acceptance_fixture_missing");
    const actual = crypto
      .createHash("sha256")
      .update(canonicalJson(fixture.manifest))
      .digest("hex");
    if (actual !== fixture.manifest_sha256)
      throw new Error("internal_acceptance_manifest_hash_mismatch");
    return parseInternalAcceptanceFixture(fixture.manifest, {
      url: tender.source_url,
    });
  }
  const prior = (
    await pool.query(
      "SELECT raw_payload,raw_content_type,source_url FROM tender.enrichment_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1",
      [tender.id],
    )
  ).rows[0];
  if (prior)
    return tender.source_code === "DOE"
      ? parseDoe(JSON.parse(prior.raw_payload.toString("utf8")), {
          url: prior.source_url,
        })
      : parseNotice(prior.raw_payload, {
          source: "TED",
          url: prior.source_url,
          contentType: prior.raw_content_type,
          fallback: tender,
        });
  if (tender.source_code === "DOE") {
    const retained = (
      await pool.query(
        "SELECT raw_json,retrieved_at FROM tender.import_raw_payloads WHERE source_code='DOE' AND external_id=$1 ORDER BY retrieved_at DESC LIMIT 1",
        [tender.external_id],
      )
    ).rows[0];
    if (retained)
      return parseDoe(retained.raw_json, { url: tender.source_url });
    const fetched = await fetchBounded(tender.source_url, {
      maxBytes: 20_000_000,
    });
    if (fetched.status !== "FETCHED")
      throw new Error(`notice_${fetched.status}`);
    return parseDoe(JSON.parse(fetched.buffer.toString("utf8")), {
      url: tender.source_url,
    });
  }
  const url = `https://ted.europa.eu/en/notice/${encodeURIComponent(tender.external_id)}/xml`,
    fetched = await fetchTedNoticeBounded(url, { maxBytes: 20_000_000 });
  if (fetched.status !== "FETCHED") throw new Error(`notice_${fetched.status}_${fetched.httpStatus||fetched.error||"UNKNOWN"}`);
  return parseNotice(fetched.buffer, {
    source: "TED",
    url,
    contentType: fetched.mime,
    fallback: tender,
  });
}
async function persistEnrichment(pool, runId, tender, result) {
  const portalLinkEvidence = Array.isArray(result?.portalLinkEvidence)
    ? result.portalLinkEvidence
    : extractNoticePortalLinkEvidence(result?.rawPayload, {
        source: tender.source_code,
        url: tender.source_url,
        contentType: result?.contentType,
      });
  result = {
    ...result,
    fields: Array.isArray(result?.fields) ? result.fields : [],
    lots: Array.isArray(result?.lots) ? result.lots : [],
    documentLinks: portalLinkEvidence.length
      ? portalLinkEvidence
          .filter((link) => link.role === "PROCUREMENT_DOCUMENT")
          .map((link) => link.url)
      : Array.isArray(result?.documentLinks) ? result.documentLinks : [],
    structured: result?.structured || {},
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      String(tender.id),
    ]);
    const version = Number(
      (
        await client.query(
          "SELECT coalesce(max(version),0)+1 v FROM tender.enrichment_versions WHERE tender_id=$1",
          [tender.id],
        )
      ).rows[0].v,
    );
    const row = (
      await client.query(
        `INSERT INTO tender.enrichment_versions(run_id,tender_id,version,source_code,notice_identifier,notice_version,change_state,retrieved_at,source_url,payload_sha256,raw_payload,raw_content_type,structured_data,quality_summary,mapper_version,parser_version) VALUES($1,$2,$3,$4,$5,$6,'AUTOPILOT',now(),$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$13) ON CONFLICT(tender_id,payload_sha256,parser_version) DO UPDATE SET retrieved_at=excluded.retrieved_at RETURNING *`,
        [
          runId,
          tender.id,
          version,
          tender.source_code,
          tender.external_id,
          String(version),
          tender.source_url,
          result.payloadSha256,
          result.rawPayload,
          tender.source_code === "TED" ? "application/xml" : "application/json",
          json(result.structured),
          json({
            fieldCount: result.fields.length,
            lotCount: result.lots.length,
            deduplicated: true,
          }),
          PIPELINE_VERSION,
        ],
      )
    ).rows[0];
    const tenderVersion = (
      await client.query(
        "SELECT id FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC,created_at DESC,id DESC LIMIT 1",
        [tender.id],
      )
    ).rows[0];
    if (!tenderVersion)
      throw Object.assign(new Error("current tender version missing"), {
        code: "TENDER_VERSION_MISSING",
      });
    await persistAuthoritativePortalEvidence(client, {
      tenderId: tender.id,
      tenderVersionId: tenderVersion.id,
      sourceUrl: tender.source_url,
      linkEvidence: portalLinkEvidence,
    });
    for (const lot of result.lots)
      await client.query(
        "INSERT INTO tender.enrichment_lots(enrichment_version_id,lot_key,lot_number,title,structured_data,provenance) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT DO NOTHING",
        [
          row.id,
          lot.lotKey,
          lot.lotNumber,
          lot.title,
          json(lot),
          json(lot.provenance),
        ],
      );
    const fields = [
      ...result.fields,
      ...Object.entries(result.structured.scope || {}).map(
        ([fieldKey, value]) => ({
          fieldKey,
          value,
          qualityStatus: value?.length
            ? "VORHANDEN"
            : result.documentLinks.length
              ? "DOKUMENT_NOCH_NICHT_ABGERUFEN"
              : "QUELLE_ENTHÄLT_KEINE_ANGABE",
          provenance: {
            tenderId: tender.id,
            sourceDocument: tender.source_code,
            filename: new URL(tender.source_url).pathname.split("/").pop(),
            documentVersion: version,
            location: `structured.scope.${fieldKey}`,
            extractedAt: new Date().toISOString(),
            parser: "scope-regex",
            parserVersion: PIPELINE_VERSION,
          },
          confidence: value?.length ? 0.9 : null,
        }),
      ),
    ];
    for (const field of fields)
      await client.query(
        "INSERT INTO tender.enrichment_fields(enrichment_version_id,field_key,value,quality_status,provenance,confidence) VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING",
        [
          row.id,
          field.fieldKey,
          json(field.value),
          field.qualityStatus,
          json({ ...field.provenance, tenderId: tender.id }),
          field.confidence,
        ],
      );
    for (const link of result.documentLinks)
      await client.query(
        "INSERT INTO tender.enrichment_documents(enrichment_version_id,source_url,document_type,filename,fetch_status,provenance) VALUES($1,$2,'TENDER_DOCUMENT',$3,'DOKUMENT_NOCH_NICHT_ABGERUFEN',$4::jsonb) ON CONFLICT DO NOTHING",
        [
          row.id,
          link,
          new URL(link).pathname.split("/").pop() || null,
          json({
            tenderId: tender.id,
            sourceNotice: tender.source_url,
            discoveredAt: new Date().toISOString(),
          }),
        ],
      );
    if (
      tender.data_class === "INTERNAL_ACCEPTANCE_FIXTURE" &&
      result.fixtureDocument
    )
      await client.query(
        `INSERT INTO tender.enrichment_documents(enrichment_version_id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,content,extracted_data,parser,parser_version,retrieved_at,provenance,resolution_status,document_class,procurement_relevant,tender_association_verified,lot_association_verified,magic_bytes_verified,content_size,procurement_verification_status)
      VALUES($1,$2,'INTERNAL_ACCEPTANCE_DOCUMENT',$3,'VORHANDEN',200,'application/json',$4,$5,$6::jsonb,'INTERNAL_ACCEPTANCE_MANIFEST',$7,now(),$8::jsonb,'DOWNLOAD_SUCCEEDED','SPECIFICATION',true,true,true,true,$9,'VERIFIED') ON CONFLICT(enrichment_version_id,source_url) DO NOTHING`,
        [
          row.id,
          `${tender.source_url}/document`,
          result.fixtureDocument.filename,
          result.fixtureDocument.payloadSha256,
          result.fixtureDocument.content,
          json(result.structured),
          PIPELINE_VERSION,
          json({
            classification: "INTERNAL_ACCEPTANCE_FIXTURE",
            tenderId: tender.id,
            lotKey: "LOT-ACCEPTANCE-001",
            source: "INTERNAL_CONTROLLED_TEST_DATA",
            externalWrite: false,
            transmitted: false,
          }),
          result.fixtureDocument.content.length,
        ],
      );
    await client.query(
      `WITH prior_documents AS (
      SELECT DISTINCT ON(d.source_url) d.*,old_lot.lot_key,ev.version source_enrichment_version
      FROM tender.enrichment_documents d
      JOIN tender.enrichment_versions ev ON ev.id=d.enrichment_version_id
      LEFT JOIN tender.enrichment_lots old_lot ON old_lot.id=d.lot_id
      WHERE ev.tender_id=$1 AND ev.id<>$2 AND d.procurement_verification_status='VERIFIED' AND d.content IS NOT NULL AND d.payload_sha256 IS NOT NULL
      ORDER BY d.source_url,ev.version DESC,d.retrieved_at DESC NULLS LAST
    ) INSERT INTO tender.enrichment_documents(enrichment_version_id,lot_id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,content,extracted_data,parser,parser_version,retrieved_at,provenance,resolution_status,document_class,procurement_relevant,tender_association_verified,lot_association_verified,magic_bytes_verified,content_size,procurement_verification_status)
      SELECT $2,new_lot.id,d.source_url,d.document_type,d.filename,d.fetch_status,d.http_status,d.mime_type,d.payload_sha256,d.content,d.extracted_data,d.parser,d.parser_version,d.retrieved_at,d.provenance||jsonb_build_object('carriedForwardFromEnrichmentVersion',d.source_enrichment_version,'carriedForwardAt',now(),'externalWrite',false),d.resolution_status,d.document_class,d.procurement_relevant,d.tender_association_verified,CASE WHEN d.lot_key IS NULL THEN d.lot_association_verified ELSE new_lot.id IS NOT NULL AND d.lot_association_verified END,d.magic_bytes_verified,d.content_size,d.procurement_verification_status
      FROM prior_documents d LEFT JOIN tender.enrichment_lots new_lot ON new_lot.enrichment_version_id=$2 AND new_lot.lot_key=d.lot_key
      ON CONFLICT(enrichment_version_id,source_url) DO NOTHING`,
      [tender.id, row.id],
    );
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function bindExactEnrichmentContext(pool,{tender,enrichment,company,lotKey}){
  if(!lotKey)return null;
  const result=await pool.query(`WITH exact_context AS(
      SELECT $1::uuid enrichment_version_id,scope.tenant_id,scope.company_id,$2::uuid tender_id,
        version.id tender_version_id,lot.id lot_id,$4::text source_lot_id,
        scope.canonical_service,$5::char(64) source_manifest_sha256
      FROM tender.configuration_scopes scope
      JOIN tender.enterprise_company_links enterprise ON enterprise.company_id=scope.company_id
        AND enterprise.tender_profile_id=scope.profile_id AND enterprise.active=true
      JOIN tender.lots lot ON lot.tender_id=$2 AND lot.external_id=$4
      JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate
        WHERE candidate.tender_id=$2 ORDER BY candidate.version DESC,candidate.created_at DESC,candidate.id DESC LIMIT 1)version ON true
      WHERE scope.tenant_id=$3 AND scope.company_id=$6 AND scope.profile_id=$7
    ),inserted AS(
      INSERT INTO tender.enrichment_context_bindings(enrichment_version_id,tenant_id,company_id,
        tender_id,tender_version_id,lot_id,source_lot_id,canonical_service,source_manifest_sha256)
      SELECT enrichment_version_id,tenant_id,company_id,tender_id,tender_version_id,lot_id,
        source_lot_id,canonical_service,source_manifest_sha256 FROM exact_context
      ON CONFLICT DO NOTHING RETURNING id,enrichment_version_id,tenant_id,company_id,tender_id,
        tender_version_id,lot_id,source_lot_id,canonical_service
    )
    SELECT * FROM inserted
    UNION ALL
    SELECT binding.id,binding.enrichment_version_id,binding.tenant_id,binding.company_id,
      binding.tender_id,binding.tender_version_id,binding.lot_id,binding.source_lot_id,binding.canonical_service
    FROM tender.enrichment_context_bindings binding JOIN exact_context exact
      ON exact.enrichment_version_id=binding.enrichment_version_id AND exact.tenant_id=binding.tenant_id
      AND exact.company_id=binding.company_id AND exact.tender_id=binding.tender_id
      AND exact.lot_id=binding.lot_id AND exact.source_lot_id=binding.source_lot_id
    LIMIT 1`,[enrichment.id,tender.id,company.tenant_id,lotKey,enrichment.payload_sha256,
      company.company_id,company.profile_id]);
  if(result.rows.length!==1)throw Object.assign(Error("exact enrichment context could not be bound"),{
    code:"EXACT_ENRICHMENT_CONTEXT_REQUIRED",
  });
  return result.rows[0];
}
async function authenticatePortal(
  portal,
  credential,
  { targetUrl = null, documentTest = false } = {},
) {
  if (portal.login_strategy === "RESOLVER_ONLY") {
    const target =
      targetUrl ||
      new URL(portal.document_path || "/", `https://${portal.canonical_domain}`)
        .href;
    const fetched = await fetchBounded(target, { maxBytes: 2_000_000 });
    if (fetched.status === "FETCHED")
      return {
        resultCode: "LOGIN_ERFOLGREICH",
        session: null,
        sessionExpiresAt: null,
        documentAccess: true,
        publicResolver: true,
        authenticatedUrl: fetched.url,
        verifiedAt: new Date().toISOString(),
      };
    return {
      resultCode:
        fetched.error === "download_timeout"
          ? "PORTAL_NICHT_ERREICHBAR"
          : "TECHNISCHER_CONNECTORFEHLER",
      publicResolver: true,
    };
  }
  const decrypted = decryptSecret(credential);
  if (portal.adapter_id === "deutsche-evergabe")
    return authenticatePortalWithBrowser({
      portal,
      credential: decrypted,
      targetUrl,
    });
  const http = await testReadOnlyPortal({
    portal,
    credential: decrypted,
    documentTest,
  });
  if (["MFA_BESTÄTIGUNG_ERFORDERLICH","CAPTCHA_MANUELL_ERFORDERLICH"].includes(http.resultCode)) return http;
  if (http.resultCode === "LOGIN_ERFOLGREICH" && http.session) return http;
  return authenticatePortalWithBrowser({
    portal,
    credential: decrypted,
    targetUrl,
  });
}
async function persistPortalSession(
  pool,
  portal,
  credential,
  companyId,
  result,
) {
  if (!result.session) return null;
  if (!companyId)
    throw Object.assign(Error("company-scoped portal session required"), {
      code: "COMPANY_SCOPE_MISMATCH",
    });
  const cookieCount = Number(
    result.session.storageState?.cookies?.length ||
      result.session.cookies?.length ||
      (result.session.cookie ? 1 : 0),
  );
  if (cookieCount < 1)
    throw Object.assign(
      Error("verified portal session has no reusable cookie"),
      { code: "SESSION_COOKIE_FEHLT" },
    );
  const encrypted = encryptSecret(result.session),
    expires =
      result.sessionExpiresAt || new Date(Date.now() + 3600000).toISOString(),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM tender.portal_registry WHERE id=$1 FOR UPDATE",
      [portal.id],
    );
    const current = (
      await client.query(
        "SELECT credential.id,scope.tenant_id FROM tender.portal_credential_secrets credential JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id AND scope.company_id=$3 AND scope.active WHERE credential.id=$2 AND credential.portal_id=$1 AND credential.status='ACTIVE' AND credential.revoked_at IS NULL FOR UPDATE OF credential",
        [portal.id, credential.id, companyId],
      )
    ).rows[0];
    if (!current)
      throw Object.assign(
        Error("credential version superseded before session persistence"),
        { code: "CREDENTIAL_VERSION_SUPERSEDED" },
      );
    await client.query(
      "UPDATE tender.portal_read_sessions SET status='REVOKED',revoked_at=now() WHERE portal_id=$1 AND credential_id=$2 AND company_id=$3 AND status='ACTIVE'",
      [portal.id, credential.id, companyId],
    );
    const row = (
      await client.query(
        `INSERT INTO tender.portal_read_sessions(portal_id,credential_id,tenant_id,company_id,ciphertext,iv,auth_tag,key_version,status,expires_at,last_verified_at,verification_status,storage_state_version,cookie_count,origin_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,now(),'VERIFIED_IN_CREATING_BROWSER',$10,$11,$12) RETURNING *`,
        [
          portal.id,
          credential.id,
          current.tenant_id,
          companyId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyVersion,
          expires,
          Number(result.session.formatVersion || 1),
          cookieCount,
          Number(result.session.storageState?.origins?.length || 0),
        ],
      )
    ).rows[0];
    await client.query(
      "UPDATE tender.portal_registry SET last_successful_login_at=now(),last_error_code=NULL,updated_at=now() WHERE id=$1",
      [portal.id],
    );
    await client.query("COMMIT");
    return { ...row, session_id: row.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function expireFailedPortalSession(
  pool,
  {
    portal,
    credential,
    companyId,
    saved,
    tenderId = null,
    lotKey = null,
    resultCode = "SESSION_RESTORE_FAILED",
  },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE tender.portal_read_sessions SET status='EXPIRED',revoked_at=coalesce(revoked_at,now()),verification_status='RESTORE_FAILED' WHERE id=$1 AND portal_id=$2 AND credential_id=$3 AND company_id=$4",
      [saved.session_id || saved.id, portal.id, credential.id, companyId],
    );
    await client.query(
      `UPDATE tender.portal_login_continuations SET status='SESSION_EXPIRED' WHERE portal_id=$1 AND credential_id=$2 AND company_id=$3 AND ($4::uuid IS NULL OR tender_id=$4) AND ($5::text IS NULL OR coalesce(lot_key,'')=coalesce($5,'')) AND status IN('LOGIN_STARTED','WAITING_FOR_USER','MFA_REQUIRED','LOGIN_SUCCESSFUL')`,
      [portal.id, credential.id, companyId, tenderId, lotKey],
    );
    await client.query(
      "UPDATE tender.portal_registry SET last_error_code=$2,updated_at=now() WHERE id=$1",
      [portal.id, resultCode],
    );
    await client.query(
      "INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES('portal_session_restore_failed',$1,$2::jsonb)",
      [
        tenderId,
        json({
          portalId: portal.id,
          credentialId: credential.id,
          companyId,
          sessionId: saved.session_id || saved.id,
          lotKey,
          resultCode,
          externalWrite: false,
        }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function verifyStoredPortalSession(
  pool,
  portal,
  credential,
  companyId,
  saved,
  targetUrl,
  context = {},
) {
  const restored = await restorePortalSessionWithBrowser({
    portal,
    session: decryptSecret(saved),
    targetUrl,
  });
  if (restored.resultCode !== "SESSION_VALID") {
    await expireFailedPortalSession(pool, {
      portal,
      credential,
      companyId,
      saved,
      tenderId: context.tenderId || null,
      lotKey: context.lotKey ?? null,
      resultCode: restored.resultCode || "SESSION_RESTORE_FAILED",
    });
    return restored;
  }
  const cookieCount = Number(
      restored.session.storageState?.cookies?.length ||
        restored.session.cookies?.length ||
        (restored.session.cookie ? 1 : 0),
    ),
    encrypted = encryptSecret(restored.session),
    sessionId = saved.session_id || saved.id;
  const updated = (
    await pool.query(
      `UPDATE tender.portal_read_sessions session SET ciphertext=$2,iv=$3,auth_tag=$4,key_version=$5,status='ACTIVE',expires_at=$6,last_verified_at=now(),verification_status='VERIFIED_RESTORED_READ_ONLY_PAGE',storage_state_version=$7,cookie_count=$8,origin_count=$9,revoked_at=NULL WHERE session.id=$1 AND session.portal_id=$10 AND session.company_id=$11 AND session.credential_id=$12 AND EXISTS(SELECT 1 FROM tender.portal_credential_secrets credential JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id AND scope.company_id=$11 AND scope.active WHERE credential.id=$12 AND credential.portal_id=$10 AND credential.status='ACTIVE' AND credential.revoked_at IS NULL) RETURNING session.id`,
      [
        sessionId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.keyVersion,
        restored.sessionExpiresAt,
        Number(restored.session.formatVersion || 1),
        cookieCount,
        Number(restored.session.storageState?.origins?.length || 0),
        portal.id,
        companyId,
        credential.id,
      ],
    )
  ).rows[0];
  if (!updated)
    throw Object.assign(
      Error("credential version superseded before session refresh"),
      { code: "CREDENTIAL_VERSION_SUPERSEDED" },
    );
  const persisted = (
    await pool.query(
      `SELECT id,tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) effective_status FROM tender.portal_read_sessions WHERE id=$1 AND portal_id=$2 AND company_id=$3 AND credential_id=$4`,
      [sessionId, portal.id, companyId, credential.id],
    )
  ).rows[0];
  if (!persisted || persisted.effective_status !== "ACTIVE")
    throw Object.assign(Error("PORTAL_SESSION_READ_AFTER_WRITE_FAILED"), {
      code: "PORTAL_SESSION_READ_AFTER_WRITE_FAILED",
    });
  // Only an explicit login/connection verification may expand a session to
  // all affected contexts. A pipeline job that was itself created by fanout
  // must never recursively create another fanout wave after re-authentication.
  if (context.enqueueFanout !== false)
    await enqueueVerifiedSessionFanout(pool, sessionId);
  await pool.query(
    "UPDATE tender.portal_registry SET last_error_code=NULL,updated_at=now() WHERE id=$1",
    [portal.id],
  );
  return {
    ...restored,
    resultCode: "LOGIN_ERFOLGREICH",
    restored: true,
    documentAccess: true,
    sessionRowId: sessionId,
  };
}
export async function restoreOrLoginPortalSession(
  pool,
  portal,
  credential,
  companyId,
  targetUrl,
  documentTest,
  context = {},
) {
  if (!portal?.id || !credential?.id || !companyId)
    throw Object.assign(Error("exact portal authentication scope required"), {
      code: "COMPANY_SCOPE_MISMATCH",
    });
  // A verified session fans out to many tender/lot jobs. Serialize browser
  // authentication for the exact company/portal/credential tuple so those
  // jobs cannot each create a replacement session and recursively fan out.
  const authenticationLock =
      `portal-auth:${companyId}:${portal.id}:${credential.id}`,
    lockClient = await pool.connect();
  let locked = false;
  try {
    await lockClient.query(
      "SELECT pg_advisory_lock(hashtextextended($1,0))",
      [authenticationLock],
    );
    locked = true;
    // The caller's session snapshot may have become stale while waiting for
    // the lock. Re-read canonical truth before restoring or logging in.
    const currentSession = (
      await pool.query(
        "SELECT *,tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) session_effective_status FROM tender.portal_read_sessions WHERE portal_id=$1 AND credential_id=$2 AND company_id=$3 AND tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status)='ACTIVE' ORDER BY created_at DESC LIMIT 1",
        [portal.id, credential.id, companyId],
      )
    ).rows[0];
    const saved = currentSession
      ? {
          ...portal,
          ...currentSession,
          id: portal.id,
          session_id: currentSession.id,
          session_status: currentSession.status,
        }
      : null;
    const recentlyVerified = currentSession?.ciphertext
      && /^VERIFIED/.test(String(currentSession.verification_status || ""))
      && currentSession.last_verified_at
      && new Date(currentSession.last_verified_at).getTime() > Date.now() - 120_000;
    if (context.allowRecentVerifiedSessionReuse === true && recentlyVerified)
      return {
        resultCode: "LOGIN_ERFOLGREICH",
        session: decryptSecret(currentSession),
        restored: true,
        recentlyVerified: true,
        documentAccess: true,
        sessionRowId: currentSession.id,
      };
    let restoreFailure = null;
    if (saved?.ciphertext) {
      const restored = await verifyStoredPortalSession(
        pool,
        portal,
        credential,
        companyId,
        saved,
        targetUrl,
        context,
      );
      if (restored.resultCode === "LOGIN_ERFOLGREICH") return restored;
      restoreFailure = restored;
    }
    // Background document work may restore an already verified session, but
    // must not repeatedly submit stored credentials after that session fails.
    // Only the explicit login/connection action owns a fresh credential login.
    if (context.allowAutomaticLogin === false)
      return {
        ...(restoreFailure || {
          resultCode: "SESSION_NICHT_FUER_DOWNLOAD_GUELTIG",
        }),
        restored: false,
        reauthenticated: false,
      };
    const loggedIn = await authenticatePortal(portal, credential, {
      targetUrl,
      documentTest,
    });
    if (loggedIn.resultCode !== "LOGIN_ERFOLGREICH" || !loggedIn.session)
      return { ...loggedIn, restored: false, reauthenticated: false };
    const persisted = await persistPortalSession(
      pool,
      portal,
      credential,
      companyId,
      loggedIn,
    );
    const verified = await verifyStoredPortalSession(
      pool,
      portal,
      credential,
      companyId,
      persisted,
      targetUrl,
      context,
    );
    return {
      ...verified,
      restored: false,
      reauthenticated: verified.resultCode === "LOGIN_ERFOLGREICH",
    };
  } finally {
    if (locked)
      await lockClient
        .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          authenticationLock,
        ])
        .catch(() => {});
    await lockClient.release();
  }
}
async function portalReadHeaders(pool, url, companyIds) {
  try {
    const scopedCompanies = [
      ...new Set((companyIds || []).map(String).filter(Boolean)),
    ];
    if (scopedCompanies.length !== 1) return {};
    const companyId = scopedCompanies[0];
    const parsed = new URL(url);
    const signedPublicDownload =
      ["token", "downloadToken", "sig", "signature"].some((key) =>
        parsed.searchParams.has(key),
      ) ||
      (/download/i.test(parsed.pathname) && parsed.searchParams.has("k"));
    const publicDirectDownload = /\/download(?:\.php)?(?:\/|$)/i.test(
      parsed.pathname,
    );
    const publicStaticDocument =
      /\.(?:pdf|xlsx?|docx?|zip|xml|gaeb|x83|x84)$/i.test(parsed.pathname);
    if (
      parsed.protocol === "https:" &&
      (signedPublicDownload || publicDirectDownload || publicStaticDocument)
    )
      return {};
    const host = parsed.hostname.toLowerCase(),
      portal = (
        await pool.query(
          `SELECT p.*,c.id credential_id,c.ciphertext,c.iv,c.auth_tag,c.key_version
      FROM tender.portal_registry p
      JOIN tender.portal_credential_secrets c ON c.portal_id=p.id AND c.status='ACTIVE'
      JOIN tender.portal_credential_companies pc ON pc.credential_id=c.id AND pc.company_id=$1::uuid AND pc.active=true
      WHERE p.adapter_enabled=true AND (p.canonical_domain=$2 OR $2=ANY(p.allowed_subdomains) OR $2=ANY(p.authentication_domains) OR $2=ANY(p.download_domains))
      ORDER BY c.version DESC LIMIT 1`,
          [companyId, host],
        )
      ).rows[0];
    if (!portal) return {};
    canonicalPortalUrl(url, portal.canonical_domain, [
      ...(portal.allowed_subdomains || []),
      ...(portal.authentication_domains || []),
      ...(portal.download_domains || []),
    ]);
    await pool.query(
      "UPDATE tender.portal_read_sessions SET status='EXPIRED',revoked_at=coalesce(revoked_at,now()) WHERE portal_id=$1 AND credential_id=$2 AND company_id=$3 AND status='ACTIVE' AND expires_at<=now()",
      [portal.id, portal.credential_id, companyId],
    );
    const saved = (
        await pool.query(
          "SELECT *,tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) session_effective_status FROM tender.portal_read_sessions WHERE portal_id=$1 AND credential_id=$2 AND company_id=$3 AND tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status)='ACTIVE' ORDER BY created_at DESC LIMIT 1",
          [portal.id, portal.credential_id, companyId],
        )
      ).rows[0],
      credential = { ...portal, id: portal.credential_id },
      sessionPortal = saved
        ? {
            ...portal,
            ...saved,
            id: portal.id,
            session_id: saved.id,
            session_status: saved.status,
          }
        : portal;
    const result = await restoreOrLoginPortalSession(
      pool,
      sessionPortal,
      credential,
      companyId,
      url,
      true,
      { enqueueFanout: false, allowAutomaticLogin: false, allowRecentVerifiedSessionReuse: true },
    );
    if (result.resultCode !== "LOGIN_ERFOLGREICH" || !result.session) {
      const safeFailure = [
        result.failurePhase,
        result.failureClass,
        result.failureReason,
      ]
        .filter(Boolean)
        .map((value) => String(value).slice(0, 160))
        .join(": ");
      throw Object.assign(
        Error(
          safeFailure ||
            "automatic portal re-authentication did not establish a restorable session",
        ),
        { code: result.resultCode || "SESSION_NICHT_FUER_DOWNLOAD_GUELTIG" },
      );
    }
    const session = result.session,
      cookie = session.cookies
        ? cookieHeaderForUrl(session.cookies, url)
        : session.cookie;
    if (!cookie)
      throw Object.assign(
        Error("authenticated session has no cookie for document target"),
        { code: "SESSION_NICHT_FUER_DOWNLOAD_GUELTIG" },
      );
    return { cookie };
  } catch (error) {
    if (error?.code) throw error;
    return {};
  }
}
async function registeredPublicNetServerPortal(pool, url) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.pathname !== "/NetServer/TenderingProcedureDetails" ||
    target.searchParams.get("function") !== "_Details" ||
    !/^54321-(?:Net)?Tender-[a-z0-9-]+$/i.test(target.searchParams.get("TenderOID") || "")
  ) return null;
  return (
    await pool.query(
      `SELECT id,canonical_domain,adapter_id FROM tender.portal_registry
       WHERE canonical_domain=$1 AND adapter_id='ai-vergabe-manager'
       LIMIT 1`,
      [target.hostname.toLowerCase()],
    )
  ).rows[0] || null;
}
async function registeredPublicAIBietercockpitPortal(pool,url){
  const target=new URL(url);
  if(target.protocol!=="https:"||target.hostname!=="www.deutsches-ausschreibungsblatt.de"||!/^\/VN\/[A-Za-z0-9._-]+$/.test(target.pathname))return null;
  return (await pool.query(`SELECT id,canonical_domain,adapter_id FROM tender.portal_registry
    WHERE canonical_domain=$1 AND adapter_id='ai-vergabe-manager' LIMIT 1`,[target.hostname])).rows[0]||null;
}
async function portalContext(pool, initialUrl, finalUrl, companyIds, { tenderId, lotKeys = [] } = {}) {
  const initial = new URL(initialUrl).hostname.toLowerCase(),
    final = new URL(finalUrl).hostname.toLowerCase();
  const scopedCompanies = [
    ...new Set((companyIds || []).map(String).filter(Boolean)),
  ];
  if (scopedCompanies.length !== 1)
    return {
      status: "PORTAL_ASSIGNMENT_REVIEW_REQUIRED",
      domain: final,
      portal: null,
    };
  const companyId = scopedCompanies[0];
  const row =
    (
      await pool.query(
        `SELECT p.*,c.id credential_id,pc.company_id credential_company,s.status session_status,s.expires_at session_expires_at,s.verification_status session_verification_status,s.session_effective_status
    FROM tender.portal_registry p
    LEFT JOIN LATERAL(
      SELECT credential.* FROM tender.portal_credential_secrets credential
      JOIN tender.portal_credential_companies company_scope
        ON company_scope.credential_id=credential.id
        AND company_scope.company_id=$3::uuid AND company_scope.active=true
      WHERE credential.portal_id=p.id AND credential.status='ACTIVE'
        AND NOT EXISTS(SELECT 1 FROM tender.portal_credential_companies other_scope
          WHERE other_scope.credential_id=credential.id AND other_scope.active=true
            AND other_scope.company_id<>company_scope.company_id)
      ORDER BY credential.version DESC LIMIT 1
    )c ON true
    LEFT JOIN tender.portal_credential_companies pc ON pc.credential_id=c.id AND pc.company_id=$3::uuid AND pc.active=true
    LEFT JOIN LATERAL(SELECT status,expires_at,verification_status,tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) session_effective_status FROM tender.portal_read_sessions WHERE portal_id=p.id AND credential_id=c.id AND company_id=$3::uuid ORDER BY created_at DESC LIMIT 1)s ON true
    WHERE p.canonical_domain IN($1,$2) OR $2=ANY(p.allowed_subdomains)
    ORDER BY (p.canonical_domain=$1) DESC LIMIT 1`,
        [initial, final, companyId],
      )
    ).rows[0] || null;
  if (!row)
    return {
      status: "PORTAL_ASSIGNMENT_REVIEW_REQUIRED",
      domain: final,
      portal: null,
    };
  const exactLots = [...new Set(lotKeys.map(String).filter(Boolean))];
  if (!tenderId || exactLots.length !== 1) return {
    status: "PORTAL_ASSIGNMENT_REVIEW_REQUIRED",
    domain: final,
    portal: row,
  };
  const documentAssignments = (await pool.query(
    `SELECT assignment.assignment_id FROM tender.current_tender_company_portal_role_scopes assignment
     WHERE assignment.tender_id=$1 AND assignment.company_id=$2 AND assignment.portal_id=$3
       AND assignment.source_lot_id=$4 AND assignment.portal_role='DOCUMENT_PORTAL' LIMIT 2`,
    [tenderId, companyId, row.id, exactLots[0]],
  )).rows;
  if (documentAssignments.length !== 1) return {
    status: "PORTAL_ASSIGNMENT_REVIEW_REQUIRED",
    domain: final,
    portal: row,
  };
  if (!row.credential_id || !row.credential_company)
    return {
      status: "CREDENTIAL_MISSING",
      domain: final,
      portal: row,
    };
  if (row.session_effective_status === "ACTIVE")
    return { status: "SESSION_AKTIV", domain: final, portal: row };
  if (/MFA/i.test(String(row.session_verification_status || "")))
    return { status: "MFA_REQUIRED", domain: final, portal: row };
  if (/CAPTCHA/i.test(String(row.session_verification_status || "")))
    return { status: "CAPTCHA_REQUIRED", domain: final, portal: row };
  if (row.session_status)
    return { status: "REAUTH_REQUIRED", domain: final, portal: row };
  return { status: "REAUTH_REQUIRED", domain: final, portal: row };
}
async function processDeutscheEvergabe(pool, enrichment, selected, document) {
  const initial = new URL(document.source_url),
    tenderGuid = initial.pathname.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
  const directDashboard =
    /(?:^|\.)deutsche-evergabe\.de$/i.test(initial.hostname) &&
    /^\/dashboards\/dashboard_off\//i.test(initial.pathname);
  const bayernResolver =
    /^www\.evergabe\.bayern\.de$/i.test(initial.hostname) &&
    /^\/evergabe\.bieter\/api\/supplier\/external\/deeplink\/subproject\//i.test(
      initial.pathname,
    );
  if (!tenderGuid || (!directDashboard && !bayernResolver)) return false;
  const reusablePackage = (
    await pool.query(
      `SELECT id,filename,payload_sha256,mime_type,content_size,retrieved_at FROM tender.enrichment_documents
    WHERE enrichment_version_id=$1 AND document_type='PORTAL_TENDER_DOCUMENT' AND mime_type='application/zip'
      AND content IS NOT NULL AND payload_sha256 IS NOT NULL AND resolution_status='DOWNLOAD_SUCCEEDED'
      AND provenance->>'tenderId'=$2 AND provenance->>'portalId' IS NOT NULL AND provenance->>'signatureVerified'='true'
      AND provenance->>'malwareScanStatus'='CLEAN'
      AND lot_id IS NOT DISTINCT FROM $3::uuid
    ORDER BY retrieved_at DESC LIMIT 1`,
      [enrichment.id, tenderGuid, document.lot_id],
    )
  ).rows[0];
  const companyIds = [
    ...new Set(selected.map((x) => String(x.company.company_id))),
  ];
  if (companyIds.length !== 1) {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status='PORTAL_ASSIGNMENT_REVIEW_REQUIRED',resolution_status='PORTAL_ACCESS_REQUIRED',parser='PORTAL_REDIRECT',parser_version=$2,retrieved_at=now(),provenance=provenance||$3::jsonb WHERE id=$1",
      [
        document.id,
        PIPELINE_VERSION,
        json({
          targetPortal: "portal.deutsche-evergabe.de",
          tenderId: tenderGuid,
          scopeStatus: "COMPANY_SCOPE_REQUIRED",
          externalWrite: false,
        }),
      ],
    );
    return true;
  }
  const companyId = companyIds[0],
    portal = (
      await pool.query(
        `SELECT * FROM tender.portal_registry WHERE canonical_domain IN('www.deutsche-evergabe.de','portal.deutsche-evergabe.de') OR 'portal.deutsche-evergabe.de'=ANY(allowed_subdomains) ORDER BY (canonical_domain='www.deutsche-evergabe.de') DESC LIMIT 1`,
      )
    ).rows[0];
  if (!portal) {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status='PORTAL_ASSIGNMENT_REVIEW_REQUIRED',resolution_status='PORTAL_ACCESS_REQUIRED',parser='PORTAL_REDIRECT',parser_version=$2,retrieved_at=now(),provenance=provenance||$3::jsonb WHERE id=$1",
      [
        document.id,
        PIPELINE_VERSION,
        json({
          sourcePortal: initial.hostname,
          targetPortal: "portal.deutsche-evergabe.de",
          tenderId: tenderGuid,
          checkedAt: new Date().toISOString(),
          externalWrite: false,
        }),
      ],
    );
    return true;
  }
  const selectedLots = [...new Set(selected.map((candidate) => String(candidate.lotKey || "")).filter(Boolean))];
  const exactDocumentScope = selectedLots.length === 1
    ? (await pool.query(
        `SELECT assignment_id FROM tender.current_tender_company_portal_role_scopes
         WHERE tender_id=$1 AND company_id=$2 AND portal_id=$3
           AND source_lot_id=$4 AND portal_role='DOCUMENT_PORTAL' LIMIT 2`,
        [enrichment.tender_id, companyId, portal.id, selectedLots[0]],
      )).rows
    : [];
  if (exactDocumentScope.length !== 1) {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status='PORTAL_ASSIGNMENT_REVIEW_REQUIRED',resolution_status='PORTAL_ACCESS_REQUIRED',parser='PORTAL_REDIRECT',parser_version=$2,retrieved_at=now(),provenance=provenance||$3::jsonb WHERE id=$1",
      [document.id, PIPELINE_VERSION, json({
        targetPortal: portal.canonical_domain,
        portalId: portal.id,
        tenderId: tenderGuid,
        scopeStatus: "DOCUMENT_PORTAL_EXACT_SCOPE_REQUIRED",
        externalWrite: false,
      })],
    );
    return true;
  }
  const credential = (
    await pool.query(
      `SELECT c.* FROM tender.portal_credential_secrets c JOIN tender.portal_credential_companies cc ON cc.credential_id=c.id WHERE c.portal_id=$1 AND c.status='ACTIVE' AND cc.company_id=$2::uuid AND cc.active=true
        AND NOT EXISTS(SELECT 1 FROM tender.portal_credential_companies other_scope
          WHERE other_scope.credential_id=c.id AND other_scope.active=true AND other_scope.company_id<>cc.company_id)
        ORDER BY c.version DESC LIMIT 1`,
      [portal.id, companyId],
    )
  ).rows[0];
  if (!credential) {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status='CREDENTIAL_MISSING',resolution_status='PORTAL_ACCESS_REQUIRED',parser='PORTAL_REDIRECT',parser_version=$2,retrieved_at=now(),provenance=provenance||$3::jsonb WHERE id=$1",
      [
        document.id,
        PIPELINE_VERSION,
        json({
          sourcePortal: initial.hostname,
          targetPortal: "portal.deutsche-evergabe.de",
          portalId: portal.id,
          tenderId: tenderGuid,
          checkedAt: new Date().toISOString(),
          externalWrite: false,
        }),
      ],
    );
    return true;
  }
  await pool.query(
    "UPDATE tender.enrichment_documents SET resolution_status='TARGET_PORTAL_IDENTIFIED',provenance=provenance||$2::jsonb WHERE id=$1",
    [
      document.id,
      json({
        sourcePortal: initial.hostname,
        targetPortal: "portal.deutsche-evergabe.de",
        portalId: portal.id,
        tenderId: tenderGuid,
        documentArea: `https://portal.deutsche-evergabe.de/WORKFLOW/WORKFLOW/${tenderGuid}`,
        externalWrite: false,
      }),
    ],
  );
  const savedSession = (
    await pool.query(
      "SELECT *,tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) session_effective_status FROM tender.portal_read_sessions WHERE portal_id=$1 AND credential_id=$2 AND company_id=$3 AND tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status)='ACTIVE' ORDER BY created_at DESC LIMIT 1",
      [portal.id, credential.id, companyId],
    )
  ).rows[0];
  const workflowUrl = `https://portal.deutsche-evergabe.de/WORKFLOW/WORKFLOW/${tenderGuid}`,
    portalSession = savedSession
      ? {
          ...portal,
          ...savedSession,
          id: portal.id,
          portal_id: portal.id,
          session_id: savedSession.id,
          session_status: savedSession.status,
        }
      : portal,
    login = await restoreOrLoginPortalSession(
      pool,
      portalSession,
      credential,
      companyId,
      workflowUrl,
      true,
      {
        tenderId: enrichment.tender_id,
        lotKey: selected[0]?.lotKey ?? null,
        enqueueFanout: false,
        allowAutomaticLogin: false,
        allowRecentVerifiedSessionReuse: true,
      },
    );
  if (login.resultCode !== "LOGIN_ERFOLGREICH" || !login.session?.cookie) {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status=$2,resolution_status='PORTAL_ACCESS_REQUIRED',parser='PORTAL_REDIRECT',parser_version=$3,retrieved_at=now(),provenance=provenance||$4::jsonb WHERE id=$1",
      [
        document.id,
        login.resultCode || "LOGIN_ERFORDERLICH",
        PIPELINE_VERSION,
        json({
          targetPortal: "portal.deutsche-evergabe.de",
          portalId: portal.id,
          tenderId: tenderGuid,
          loginResult: login.resultCode,
          externalWrite: false,
        }),
      ],
    );
    return true;
  }
  if (reusablePackage) {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status='VORHANDEN',resolution_status='DOWNLOAD_SUCCEEDED',http_status=200,parser='PORTAL_DOCUMENT_INDEX',parser_version=$2,retrieved_at=now(),provenance=provenance-$3||$4::jsonb WHERE id=$1",
      [
        document.id,
        PIPELINE_VERSION,
        "error",
        json({
          downloadDisposition: "REUSED_IDENTICAL_VALIDATED_REVISION",
          reusedPackageDocumentId: reusablePackage.id,
          reusedPayloadSha256: reusablePackage.payload_sha256,
          reusedRetrievedAt: reusablePackage.retrieved_at,
          tenderId: tenderGuid,
          sessionVerifiedAt: new Date().toISOString(),
          externalWrite: false,
        }),
      ],
    );
    return true;
  }
  const headers = {
      cookie: login.session.cookies
        ? cookieHeaderForUrl(login.session.cookies, workflowUrl)
        : login.session.cookie,
    },
    base = "https://portal.deutsche-evergabe.de",
    workflow = await fetchBounded(workflowUrl, { headers });
  if (workflow.status !== "FETCHED") {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status=$2,resolution_status='DOWNLOAD_FAILED',parser='PORTAL_DOCUMENT_INDEX',parser_version=$3,retrieved_at=now() WHERE id=$1",
      [document.id, workflow.status, PIPELINE_VERSION],
    );
    return true;
  }
  const workflowHtml = workflow.buffer.toString("utf8"),
    workflowPath = classifyDeutscheEvergabeWorkflow(workflowHtml),
    stepHref = decodeHtml(
      workflowHtml.match(
        /href=["']([^"']*WorkflowOpen[^"']*A=WF_VUDownload[^"']*)["']/i,
      )?.[1],
    );
  if (workflowPath === "WF_EVA_LINK") {
    try {
      const fetched = await downloadAuthenticatedDeutscheEvergabeEvaArchive({
          portal,
          credential: decryptSecret(credential),
          session: login.session,
          tenderGuid,
        }),
        parsed = await parseFetched(fetched),
        hash = crypto.createHash("sha256").update(parsed.buffer).digest("hex"),
        lotBinding = resolveSingleLotBinding(null, selected),
        lotId = lotBinding.lotId,
        sourceUrl = `https://portal.deutsche-evergabe.de/WORKFLOW/WF_EVALINK/${tenderGuid}/Vergabeunterlagen`;
      await pool.query(
        `INSERT INTO tender.enrichment_documents(enrichment_version_id,lot_id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,content,extracted_data,parser,parser_version,retrieved_at,provenance,resolution_status) VALUES($1,$2,$3,'PORTAL_TENDER_DOCUMENT',$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,now(),$13::jsonb,'DOWNLOAD_SUCCEEDED') ON CONFLICT(enrichment_version_id,source_url) DO UPDATE SET lot_id=excluded.lot_id,filename=excluded.filename,fetch_status=excluded.fetch_status,http_status=excluded.http_status,mime_type=excluded.mime_type,payload_sha256=excluded.payload_sha256,content=excluded.content,extracted_data=excluded.extracted_data,parser=excluded.parser,parser_version=excluded.parser_version,retrieved_at=excluded.retrieved_at,provenance=excluded.provenance,resolution_status=excluded.resolution_status`,
        [
          enrichment.id,
          lotId,
          sourceUrl,
          parsed.name,
          parsed.status,
          fetched.httpStatus,
          parsed.mime,
          hash,
          parsed.buffer,
          json(parsed.parsed || { error: parsed.error }),
          parsed.parsed?.type || null,
          parsed.parsed?.parserVersion || PIPELINE_VERSION,
          json({
            targetPortal: "portal.deutsche-evergabe.de",
            documentPortal: "www.evergabe.bayern.de",
            portalId: portal.id,
            tenderId: tenderGuid,
            lotKey: lotBinding.lotKey,
            lotBindingSource: lotBinding.source,
            navigationPath: "WF_EVALINK",
            signatureVerified: true,
            malwareScanStatus: parsed.malwareScan?.status,
            malwareScanEngine: parsed.malwareScan?.engine,
            authenticatedRead: true,
            externalWrite: false,
          }),
        ],
      );
      await pool.query(
        "UPDATE tender.enrichment_documents SET fetch_status='VORHANDEN',resolution_status='DOWNLOAD_SUCCEEDED',http_status=200,mime_type='text/html',parser='PORTAL_DOCUMENT_INDEX',parser_version=$2,retrieved_at=now(),provenance=provenance||$3::jsonb WHERE id=$1",
        [
          document.id,
          PIPELINE_VERSION,
          json({
            targetPortal: "portal.deutsche-evergabe.de",
            documentPortal: "www.evergabe.bayern.de",
            portalId: portal.id,
            tenderId: tenderGuid,
            loginStatus: "LOGIN_SUCCEEDED",
            navigationPath: "WF_EVALINK",
            documentsFound: 1,
            documentsDownloaded: 1,
            externalWrite: false,
          }),
        ],
      );
      await pool.query(
        "UPDATE tender.portal_registry SET last_successful_login_at=now(),last_successful_document_fetch_at=now(),last_error_code=NULL,updated_at=now() WHERE id=$1",
        [portal.id],
      );
      return true;
    } catch (error) {
      await pool.query(
        "UPDATE tender.enrichment_documents SET fetch_status='DOWNLOAD_FEHLGESCHLAGEN',resolution_status='DOWNLOAD_FAILED',parser='PORTAL_DOCUMENT_INDEX',parser_version=$2,retrieved_at=now(),provenance=provenance||$3::jsonb WHERE id=$1",
        [
          document.id,
          PIPELINE_VERSION,
          json({
            targetPortal: "portal.deutsche-evergabe.de",
            portalId: portal.id,
            tenderId: tenderGuid,
            navigationPath: "WF_EVALINK",
            error: String(error.code || error.message).slice(0, 120),
            externalWrite: false,
          }),
        ],
      );
      if (
        ["MALWARE_DETECTED", "MALWARE_SCANNER_UNAVAILABLE"].includes(error.code)
      )
        throw error;
      return true;
    }
  }
  if (!stepHref) {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status='DOKUMENT_NICHT_ÖFFENTLICH_ZUGÄNGLICH',resolution_status='DOCUMENT_NOT_AVAILABLE',parser='PORTAL_DOCUMENT_INDEX',parser_version=$2,retrieved_at=now(),provenance=provenance||$3::jsonb WHERE id=$1",
      [
        document.id,
        PIPELINE_VERSION,
        json({
          targetPortal: "portal.deutsche-evergabe.de",
          portalId: portal.id,
          tenderId: tenderGuid,
          loginStatus: "LOGIN_SUCCEEDED",
          searchedDocumentArea: workflowUrl,
          navigationPath: workflowPath,
          externalWrite: false,
        }),
      ],
    );
    return true;
  }
  const step = await fetchBounded(new URL(stepHref, base).href, { headers });
  if (step.status !== "FETCHED") {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status=$2,resolution_status='DOWNLOAD_FAILED',parser='PORTAL_DOCUMENT_INDEX',parser_version=$3,retrieved_at=now() WHERE id=$1",
      [document.id, step.status, PIPELINE_VERSION],
    );
    return true;
  }
  const stepHtml = step.buffer.toString("utf8"),
    listHref = decodeHtml(
      stepHtml.match(/["'](\/files\/GetVUFileListForBidder\/[^"']+)["']/i)?.[1],
    );
  if (!listHref) {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status='DOKUMENT_NICHT_ÖFFENTLICH_ZUGÄNGLICH',resolution_status='DOCUMENT_NOT_AVAILABLE',parser='PORTAL_DOCUMENT_INDEX',parser_version=$2,retrieved_at=now() WHERE id=$1",
      [document.id, PIPELINE_VERSION],
    );
    return true;
  }
  const listed = await fetchBounded(new URL(listHref, base).href, { headers });
  let files = [];
  try {
    files = JSON.parse(listed.buffer.toString("utf8"));
  } catch {}
  if (listed.status !== "FETCHED" || !Array.isArray(files) || !files.length) {
    await pool.query(
      "UPDATE tender.enrichment_documents SET fetch_status=$2,resolution_status=$3,parser='PORTAL_DOCUMENT_INDEX',parser_version=$4,retrieved_at=now(),provenance=provenance||$5::jsonb WHERE id=$1",
      [
        document.id,
        listed.status === "FETCHED"
          ? "DOKUMENT_NICHT_ÖFFENTLICH_ZUGÄNGLICH"
          : listed.status,
        listed.status === "FETCHED"
          ? "DOCUMENT_NOT_AVAILABLE"
          : "DOWNLOAD_FAILED",
        PIPELINE_VERSION,
        json({
          targetPortal: "portal.deutsche-evergabe.de",
          portalId: portal.id,
          tenderId: tenderGuid,
          loginStatus: "LOGIN_SUCCEEDED",
          documentListUrl: new URL(listHref, base).href,
          documentCount: 0,
          externalWrite: false,
        }),
      ],
    );
    return true;
  }
  await pool.query(
    "UPDATE tender.enrichment_documents SET resolution_status='DOCUMENT_LIST_FOUND',provenance=provenance||$2::jsonb WHERE id=$1",
    [
      document.id,
      json({
        targetPortal: "portal.deutsche-evergabe.de",
        portalId: portal.id,
        tenderId: tenderGuid,
        loginStatus: "LOGIN_SUCCEEDED",
        documentListUrl: new URL(listHref, base).href,
        documentCount: files.length,
        externalWrite: false,
      }),
    ],
  );
  const lotBinding = resolveSingleLotBinding(null, selected),
    lotId = lotBinding.lotId;
  let succeeded = 0,
    failed = 0;
  const rejectedDocumentTypes = [];
  for (const file of files) {
    const documentId = String(file.DokIDStr || "");
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) {
      failed++;
      continue;
    }
    const viewerUrl = `${base}/Documentviewer/DocViewerIframe/${documentId}?isProd=True&nheight=620&nwidth=826`,
      viewer = await fetchBounded(viewerUrl, { headers });
    if (viewer.status !== "FETCHED") {
      failed++;
      continue;
    }
    const direct = decodeHtml(
      viewer.buffer
        .toString("utf8")
        .match(
          /href=["'](https:\/\/addon-service\.deutsche-evergabe\.de\/home\/DirectDocload\/[^"']+)["']/i,
        )?.[1],
    );
    if (!direct) {
      failed++;
      continue;
    }
    try {
      canonicalPortalUrl(
        direct,
        portal.canonical_domain,
        portal.allowed_subdomains,
      );
    } catch {
      failed++;
      continue;
    }
    const fetched = await fetchBounded(direct);
    if (fetched.status !== "FETCHED") {
      failed++;
      continue;
    }
    let parsed;
    try {
      parsed = await parseFetched(fetched);
    } catch (error) {
      if (error?.code !== "DOCUMENT_TYPE_REJECTED") throw error;
      const rejectedUrl = new URL(fetched.url || direct);
      rejectedDocumentTypes.push({
        documentId,
        host: rejectedUrl.hostname,
        path: rejectedUrl.pathname.slice(0, 240),
        mime: String(fetched.mime || "unknown").slice(0, 120),
        reason: "DOCUMENT_TYPE_REJECTED",
      });
      failed++;
      continue;
    }
    const preferred = decodeURIComponent(
        String(file.TFilename || parsed.name).replaceAll("+", " "),
      ).slice(0, 240),
      signatureOk = validDocumentSignature(
        parsed.buffer,
        parsed.mime,
        preferred,
      );
    if (!signatureOk) {
      failed++;
      await pool.query(
        `INSERT INTO tender.enrichment_documents(enrichment_version_id,lot_id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,content,extracted_data,parser,parser_version,retrieved_at,provenance,resolution_status) VALUES($1,$2,$3,'PORTAL_TENDER_DOCUMENT',$4,'PARSER_FEHLER',$5,$6,$7,$8,$9::jsonb,NULL,$10,now(),$11::jsonb,'DOWNLOAD_FAILED') ON CONFLICT(enrichment_version_id,source_url) DO NOTHING`,
        [
          enrichment.id,
          lotId,
          viewerUrl,
          preferred,
          fetched.httpStatus,
          parsed.mime,
          crypto.createHash("sha256").update(parsed.buffer).digest("hex"),
          parsed.buffer,
          json({ error: "file_signature_mismatch" }),
          PIPELINE_VERSION,
          json({
            targetPortal: "portal.deutsche-evergabe.de",
            portalId: portal.id,
            tenderId: tenderGuid,
            documentId,
            lotKey: lotBinding.lotKey,
            lotBindingSource: lotBinding.source,
            signatureVerified: false,
            externalWrite: false,
          }),
        ],
      );
      continue;
    }
    const hash = crypto
      .createHash("sha256")
      .update(parsed.buffer)
      .digest("hex");
    await pool.query(
      `INSERT INTO tender.enrichment_documents(enrichment_version_id,lot_id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,content,extracted_data,parser,parser_version,retrieved_at,provenance,resolution_status) VALUES($1,$2,$3,'PORTAL_TENDER_DOCUMENT',$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,now(),$13::jsonb,'DOWNLOAD_SUCCEEDED') ON CONFLICT(enrichment_version_id,source_url) DO UPDATE SET lot_id=excluded.lot_id,filename=excluded.filename,fetch_status=excluded.fetch_status,http_status=excluded.http_status,mime_type=excluded.mime_type,payload_sha256=excluded.payload_sha256,content=excluded.content,extracted_data=excluded.extracted_data,parser=excluded.parser,parser_version=excluded.parser_version,retrieved_at=excluded.retrieved_at,provenance=excluded.provenance,resolution_status=excluded.resolution_status`,
      [
        enrichment.id,
        lotId,
        viewerUrl,
        preferred,
        parsed.status,
        fetched.httpStatus,
        parsed.mime,
        hash,
        parsed.buffer,
        json(parsed.parsed || { error: parsed.error }),
        parsed.parsed?.type || null,
        parsed.parsed?.parserVersion || PIPELINE_VERSION,
        json({
          targetPortal: "portal.deutsche-evergabe.de",
          downloadDomain: "addon-service.deutsche-evergabe.de",
          portalId: portal.id,
          tenderId: tenderGuid,
          documentId,
          lotKey: lotBinding.lotKey,
          lotBindingSource: lotBinding.source,
          signatureVerified: true,
          authenticatedRead: true,
          externalWrite: false,
        }),
      ],
    );
    succeeded++;
    await sleep(25);
  }
  const finalStatus =
    succeeded && failed
      ? "DOWNLOAD_PARTIAL_SUCCESS"
      : succeeded
        ? "DOWNLOAD_SUCCEEDED"
        : "DOWNLOAD_FAILED";
  await pool.query(
    "UPDATE tender.enrichment_documents SET fetch_status=$2,resolution_status=$3,http_status=200,mime_type='text/html',parser='PORTAL_DOCUMENT_INDEX',parser_version=$4,retrieved_at=now(),provenance=provenance||$5::jsonb WHERE id=$1",
    [
      document.id,
      succeeded ? "VORHANDEN" : "DOWNLOAD_FEHLGESCHLAGEN",
      finalStatus,
      PIPELINE_VERSION,
      json({
        targetPortal: "portal.deutsche-evergabe.de",
        portalId: portal.id,
        tenderId: tenderGuid,
        loginStatus: "LOGIN_SUCCEEDED",
        documentsFound: files.length,
        documentsDownloaded: succeeded,
        documentsFailed: failed,
        rejectedDocumentTypeCount: rejectedDocumentTypes.length,
        rejectedDocumentTypes: rejectedDocumentTypes.slice(0, 20),
        documentListReviewRequired: succeeded === 0,
        externalWrite: false,
      }),
    ],
  );
  await pool.query(
    "UPDATE tender.portal_registry SET last_successful_login_at=now(),last_successful_document_fetch_at=CASE WHEN $2>0 THEN now() ELSE last_successful_document_fetch_at END,last_error_code=CASE WHEN $2>0 THEN NULL ELSE 'DOWNLOAD_FAILED' END,updated_at=now() WHERE id=$1",
    [portal.id, succeeded],
  );
  return true;
}
async function processDocuments(pool, enrichment, selected = []) {
  await recoverStoredParserFailures(pool, enrichment.id);
  const documents = (
      await pool.query(
        "SELECT * FROM tender.enrichment_documents WHERE enrichment_version_id=$1 AND NOT(document_type IN ('TENDER_DOCUMENT','PORTAL_TENDER_DOCUMENT','INTERNAL_ACCEPTANCE_DOCUMENT') AND resolution_status='DOWNLOAD_SUCCEEDED' AND content IS NOT NULL AND (lower(coalesce(filename,'')) NOT LIKE '%.zip' OR coalesce((provenance->>'archiveChildrenMaterialized')::int,0)>0)) AND NOT(parser='HTML' AND fetch_status='VORHANDEN' AND coalesce((provenance->>'discoveredFiles')::int,0)>0 AND retrieved_at>now()-interval '10 minutes') ORDER BY source_url",
        [enrichment.id],
      )
    ).rows,
    seen = new Set();
  const companyIds = selected.map((item) => item.company.company_id);
  for (const document of documents) {
    if (seen.has(document.source_url)) continue;
    seen.add(document.source_url);
    if (await processDeutscheEvergabe(pool, enrichment, selected, document))
      continue;
    const cached = (
      await pool.query(
        "SELECT cached.* FROM tender.enrichment_documents cached JOIN tender.enrichment_versions cached_version ON cached_version.id=cached.enrichment_version_id WHERE cached.source_url=$1 AND cached.enrichment_version_id<>$2 AND cached_version.tender_id=$4 AND cached.parser_version=$3 AND cached.fetch_status='VORHANDEN' AND cached.content IS NOT NULL AND cached.provenance->>'malwareScanStatus'='CLEAN' ORDER BY cached.retrieved_at DESC NULLS LAST LIMIT 1",
        [
          document.source_url,
          enrichment.id,
          PIPELINE_VERSION,
          enrichment.tender_id,
        ],
      )
    ).rows[0];
    if (cached) {
      await pool.query(
        "UPDATE tender.enrichment_documents SET filename=$2,fetch_status=$3,http_status=$4,mime_type=$5,payload_sha256=$6,content=$7,extracted_data=$8,parser=$9,parser_version=$10,retrieved_at=$11,provenance=provenance||$12::jsonb WHERE id=$1",
        [
          document.id,
          cached.filename,
          cached.fetch_status,
          cached.http_status,
          cached.mime_type,
          cached.payload_sha256,
          cached.content,
          cached.extracted_data,
          cached.parser,
          cached.parser_version,
          cached.retrieved_at,
          json({
            deduplicatedFromDocumentId: cached.id,
            checkedAt: new Date().toISOString(),
            sameTenderVerified: true,
            malwareScanStatus: "CLEAN",
          }),
        ],
      );
      continue;
    }
    let accessUrl = document.source_url;
    try {
      const located = new URL(document.provenance?.documentArea || "");
      if (located.protocol === "https:") accessUrl = located.href;
    } catch {}
    const source = new URL(accessUrl),
      publicRib =
        source.hostname === "www.meinauftrag.rib.de" &&
        source.pathname.startsWith("/public/"),
      publicEvergabeOnline =
        source.hostname === "www.evergabe-online.de" &&
        source.pathname === "/tenderdocuments.html",
      publicNetServerPortal =
        await registeredPublicNetServerPortal(pool, accessUrl),
      publicAIBietercockpitPortal =
        await registeredPublicAIBietercockpitPortal(pool,accessUrl),
      publicDuesseldorfNetServer =
        !publicNetServerPortal &&
        source.hostname === "vergabe.duesseldorf.de" &&
        source.pathname === "/NetServer/TenderingProcedureDetails" &&
        source.searchParams.get("function") === "_Details",
      authHeaders =
        publicRib || publicEvergabeOnline || publicNetServerPortal || publicAIBietercockpitPortal || publicDuesseldorfNetServer
          ? {}
          : await portalReadHeaders(pool, accessUrl, companyIds);
    let fetched = publicEvergabeOnline
      ? await downloadPublicEvergabeOnlineArchive(accessUrl).catch((error) => ({
          status: "DOWNLOAD_FEHLGESCHLAGEN",
          error: String(error.message).slice(0, 120),
        }))
      : publicNetServerPortal
        ? await downloadPublicNetServerArchive(accessUrl, {
            expectedHost: publicNetServerPortal.canonical_domain,
          }).catch((error) => ({
            status: "DOWNLOAD_FEHLGESCHLAGEN",
            error: String(error.message).slice(0, 120),
          }))
      : publicAIBietercockpitPortal
        ? await downloadPublicAIBietercockpitArchive(accessUrl).catch((error)=>({
            status:"DOWNLOAD_FEHLGESCHLAGEN",error:String(error.message).slice(0,120),
          }))
      : publicDuesseldorfNetServer
        ? await downloadPublicDuesseldorfNetServerArchive(accessUrl).catch(
            (error) => ({
              status: "DOWNLOAD_FEHLGESCHLAGEN",
              error: String(error.message).slice(0, 120),
            }),
          )
        : await fetchBounded(accessUrl, { headers: authHeaders });
    if (fetched.status !== "FETCHED") {
      await pool.query(
        "UPDATE tender.enrichment_documents SET fetch_status=$2,http_status=$3,parser_version=$4,retrieved_at=now(),provenance=provenance||$5::jsonb WHERE id=$1",
        [
          document.id,
          fetched.status,
          fetched.httpStatus || null,
          PIPELINE_VERSION,
          json({
            checkedAt: new Date().toISOString(),
            error: fetched.error || null,
          }),
        ],
      );
      continue;
    }
    if (fetched.mime === "text/html" && publicRib) {
      const located = await locateRibPublicTender(pool, enrichment, fetched);
      if (
        located.status === "DOCUMENT_NOT_FOUND" ||
        located.status === "SEARCH_UNAVAILABLE"
      ) {
        await pool.query(
          "UPDATE tender.enrichment_documents SET fetch_status='DOKUMENT_NICHT_ÖFFENTLICH_ZUGÄNGLICH',resolution_status='DOCUMENT_NOT_AVAILABLE',http_status=$2,mime_type='text/html',parser='RIB_TENDER_SEARCH',parser_version=$3,retrieved_at=now(),provenance=provenance||$4::jsonb WHERE id=$1",
          [
            document.id,
            fetched.httpStatus,
            PIPELINE_VERSION,
            json({
              ...located.evidence,
              errorClass: "DOCUMENT_NOT_FOUND",
              tenderId: enrichment.tender_id,
              checkedAt: new Date().toISOString(),
              externalWrite: false,
            }),
          ],
        );
        continue;
      }
      fetched = located.fetched;
      await pool.query(
        "UPDATE tender.enrichment_documents SET provenance=provenance||$2::jsonb WHERE id=$1",
        [
          document.id,
          json({ ...located.evidence, locationStatus: located.status }),
        ],
      );
    }
    if (
      fetched.mime === "text/html" &&
      new URL(fetched.url).hostname === "www.evergabe.de" &&
      /\/zustellweg-auswaehlen\/?$/i.test(new URL(fetched.url).pathname)
    ) {
      const documentArea = new URL(
          new URL(fetched.url).pathname.replace(
            /\/zustellweg-auswaehlen\/?$/i,
            "",
          ),
          fetched.url,
        ).href,
        area = await fetchBounded(documentArea, { headers: authHeaders });
      if (area.status === "FETCHED" && area.mime === "text/html") {
        fetched = area;
        await pool.query(
          "UPDATE tender.enrichment_documents SET provenance=provenance||$2::jsonb WHERE id=$1",
          [
            document.id,
            json({
              portalNavigation: "AUTHENTICATED_READ_ONLY_DOCUMENT_AREA",
              documentArea,
              evidenceSource:
                "authenticated portal exposed direct document-view route; no purchase, registration, or payment action executed",
              externalWrite: false,
            }),
          ],
        );
      }
    }
    if (fetched.mime === "text/html") {
      const page = htmlLinks(fetched.buffer, fetched.url),
        portal = await portalContext(
          pool,
          document.source_url,
          fetched.url,
          companyIds,
          {
            tenderId: enrichment.tender_id,
            lotKeys: selected.map((candidate) => candidate.lotKey),
          },
        );
      if (page.protected || page.directKiosk) {
        const status = page.externalRequestRequired
          ? "EXTERNAL_DOCUMENT_REQUEST_REQUIRED"
          : portal.status === "SESSION_AKTIV"
            ? page.orderRequired
              ? "MANUELLE_PRÜFUNG_ERFORDERLICH"
              : "LOGIN_ERFORDERLICH"
            : portal.status;
        const resolutionStatus =
          status === "EXTERNAL_DOCUMENT_REQUEST_REQUIRED"
            ? status
            : "PORTAL_ACCESS_REQUIRED";
        await pool.query(
          "UPDATE tender.enrichment_documents SET fetch_status=$2,resolution_status=$3,http_status=$4,mime_type='text/html',parser='PORTAL_REDIRECT',parser_version=$5,retrieved_at=now(),provenance=provenance||$6::jsonb WHERE id=$1",
          [
            document.id,
            status,
            resolutionStatus,
            fetched.httpStatus,
            PIPELINE_VERSION,
            json({
              portal: portal.domain,
              portalId: portal.portal?.id || null,
              sourcePortal: new URL(document.source_url).hostname,
              redirectUrl: fetched.url,
              projectId: page.projectId,
              procurementId: page.procurementId,
              documentArea: fetched.url,
              orderRequired: page.orderRequired,
              externalRequestRequired: page.externalRequestRequired,
              expired: page.expired,
              checkedAt: new Date().toISOString(),
              externalWrite: false,
            }),
          ],
        );
        await pool.query(
          "UPDATE tender.enrichment_fields SET quality_status=$2,provenance=provenance||$3::jsonb WHERE enrichment_version_id=$1 AND quality_status='DOKUMENT_NOCH_NICHT_ABGERUFEN'",
          [
            enrichment.id,
            status,
            json({
              portal: portal.domain,
              projectId: page.projectId,
              procurementId: page.procurementId,
              searchedDocumentArea: fetched.url,
            }),
          ],
        );
        continue;
      }
      await pool.query(
        "UPDATE tender.enrichment_documents SET fetch_status=$2,http_status=$3,mime_type='text/html',parser='HTML',parser_version=$4,retrieved_at=now(),provenance=provenance||$5::jsonb WHERE id=$1",
        [
          document.id,
          page.links.length
            ? "VORHANDEN"
            : "DOKUMENT_NICHT_ÖFFENTLICH_ZUGÄNGLICH",
          fetched.httpStatus,
          PIPELINE_VERSION,
          json({ downloadPage: true, discoveredFiles: page.links.length }),
        ],
      );
      const lotId = selected.length === 1 ? selected[0]?.lot?.id || null : null;
      const rejectedNonDocumentLinks = [];
      for (const link of page.links) {
        const ribLink = isRibPublicDownload(new URL(link)),
          child = ribLink
            ? await fetchRibDownload(link, { cookie: fetched.cookie || "" })
            : await fetchBounded(link, { headers: authHeaders });
        if (child.status !== "FETCHED") continue;
        let parsed;
        try {
          parsed = await parseFetched(child);
        } catch (error) {
          if (error?.code !== "DOCUMENT_TYPE_REJECTED") throw error;
          const rejectedUrl = new URL(child.url || link);
          rejectedNonDocumentLinks.push({
            host: rejectedUrl.hostname,
            path: rejectedUrl.pathname.slice(0, 240),
            mime: String(child.mime || "unknown").slice(0, 120),
            reason: "DOCUMENT_TYPE_REJECTED",
          });
          continue;
        }
        const
          hash = crypto
            .createHash("sha256")
            .update(parsed.buffer)
            .digest("hex");
        await pool.query(
          `INSERT INTO tender.enrichment_documents(enrichment_version_id,lot_id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,content,extracted_data,parser,parser_version,retrieved_at,provenance,resolution_status) VALUES($1,$2,$3,'PORTAL_TENDER_DOCUMENT',$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,now(),$13::jsonb,'DOWNLOAD_SUCCEEDED') ON CONFLICT(enrichment_version_id,source_url) DO UPDATE SET lot_id=excluded.lot_id,document_type=excluded.document_type,filename=excluded.filename,fetch_status=excluded.fetch_status,http_status=excluded.http_status,mime_type=excluded.mime_type,payload_sha256=excluded.payload_sha256,content=excluded.content,extracted_data=excluded.extracted_data,parser=excluded.parser,parser_version=excluded.parser_version,retrieved_at=excluded.retrieved_at,provenance=excluded.provenance,resolution_status=excluded.resolution_status`,
          [
            enrichment.id,
            lotId,
            link,
            parsed.name,
            parsed.status,
            child.httpStatus,
            parsed.mime,
            hash,
            parsed.buffer,
            json(parsed.parsed || { error: parsed.error }),
            parsed.parsed?.type || null,
            parsed.parsed?.parserVersion || PIPELINE_VERSION,
            json({
              tenderId: enrichment.tender_id,
              lotKey:
                selected.length === 1 ? selected[0]?.lotKey || null : null,
              parentUrl: document.source_url,
              malwareScanStatus: parsed.malwareScan?.status,
              malwareScanEngine: parsed.malwareScan?.engine,
              checkedAt: new Date().toISOString(),
              authenticatedRead: Boolean(authHeaders.cookie),
              ribPartnerDownload: ribLink,
              externalWrite: false,
            }),
          ],
        );
      }
      if (rejectedNonDocumentLinks.length)
        await pool.query(
          "UPDATE tender.enrichment_documents SET provenance=provenance||$2::jsonb WHERE id=$1",
          [
            document.id,
            json({
              rejectedNonDocumentLinkCount: rejectedNonDocumentLinks.length,
              rejectedNonDocumentLinks: rejectedNonDocumentLinks.slice(0, 20),
              documentListReviewRequired:
                rejectedNonDocumentLinks.length === page.links.length,
              checkedAt: new Date().toISOString(),
              externalWrite: false,
            }),
          ],
        );
      continue;
    }
    const parsed = await parseFetched(fetched),
      hash = crypto.createHash("sha256").update(parsed.buffer).digest("hex"),
      binding = resolveSingleLotBinding(document.lot_id, selected);
    await pool.query(
      "UPDATE tender.enrichment_documents SET lot_id=coalesce(lot_id,$2),filename=$3,fetch_status=$4,resolution_status='DOWNLOAD_SUCCEEDED',http_status=$5,mime_type=$6,payload_sha256=$7,content=$8,extracted_data=$9::jsonb,parser=$10,parser_version=$11,retrieved_at=now(),provenance=(provenance-'error'-'errorClass')||$12::jsonb WHERE id=$1",
      [
        document.id,
        binding.lotId,
        parsed.name,
        parsed.status,
        fetched.httpStatus,
        parsed.mime,
        hash,
        parsed.buffer,
        json(parsed.parsed || { error: parsed.error }),
        parsed.parsed?.type || null,
        parsed.parsed?.parserVersion || PIPELINE_VERSION,
        json({
          tenderId: enrichment.tender_id,
          lotKey: document.provenance?.lotKey || binding.lotKey,
          lotBindingSource: binding.source,
          malwareScanStatus: parsed.malwareScan?.status,
          malwareScanEngine: parsed.malwareScan?.engine,
          checkedAt: new Date().toISOString(),
        }),
      ],
    );
    await sleep(25);
  }
  await materializeArchiveChildren(pool, enrichment.id, selected);
  await rebindMaterializedArchiveChildren(pool, enrichment.id, selected);
}
function extractedSegments(document) {
  const data = document.extracted_data || {},
    segments = [];
  for (const page of data.pages || [])
    if (page.text)
      segments.push({ text: String(page.text), page: page.pageNumber || null });
  for (const sheet of data.worksheets || [])
    for (const row of sheet.rows || []) {
      const populated = (row.cells || []).filter((cell) => {
        const value = cell.displayed ?? cell.value;
        return value !== null && value !== undefined && String(value).trim();
      });
      for (const cell of populated) {
        const value = cell.displayed ?? cell.value;
        segments.push({
          text: String(value),
          table: sheet.name || null,
          cell: cell.address || null,
        });
      }
      if (populated.length > 1)
        segments.push({
          text: populated
            .map((cell) => String(cell.displayed ?? cell.value))
            .join(" | "),
          table: sheet.name || null,
          cell: `row:${row.rowNumber}`,
        });
    }
  if (!segments.length && typeof data.text === "string")
    segments.push({ text: data.text });
  return segments;
}
async function materializeDocumentFacts(
  pool,
  enrichmentId,
  documents,
  selected = [],
) {
  const selectedLotIds = new Set(
    selected.map((item) => item?.lot?.id).filter(Boolean),
  );
  const unique = [
    ...new Map(
      documents
        .filter(
          (document) =>
            document.procurement_verification_status === "VERIFIED" &&
            document.payload_sha256,
        )
        .map((document) => [
          `${document.payload_sha256}:${document.lot_id || "_tender"}`,
          document,
        ]),
    ).values(),
  ];
  const authoritativeSources = selectLotAuthoritativeDocuments(
    unique,
    selectedLotIds,
  );
  const selectedLotId =
    selectedLotIds.size === 1 ? [...selectedLotIds][0] : null;
  const facts = new Map();
  for (const document of authoritativeSources) {
    for (const segment of extractedSegments(document)) {
      const scope = scopeFromText(segment.text);
      for (const [key, values] of Object.entries(scope)) {
        for (const value of values || []) {
          const fact = facts.get(key) || { values: [], evidence: [] };
          if (!fact.values.includes(value)) {
            fact.values.push(value);
            fact.evidence.push({
              documentId: document.id,
              filename: document.filename,
              hash: document.payload_sha256,
              page: segment.page || null,
              table: segment.table || null,
              cell: segment.cell || null,
            });
          }
          facts.set(key, fact);
        }
      }
    }
  }
  for (const [fieldKey, fact] of facts)
    await pool.query(
      `INSERT INTO tender.enrichment_fields(enrichment_version_id,field_key,value,quality_status,provenance,confidence) SELECT $1,$2,$3::jsonb,'VORHANDEN',$4::jsonb,0.9 WHERE NOT EXISTS(SELECT 1 FROM tender.enrichment_fields WHERE enrichment_version_id=$1 AND field_key=$2 AND provenance->>'parser'='document-scope-materializer-v2' AND provenance->>'selectedLotId' IS NOT DISTINCT FROM $5)`,
      [
        enrichmentId,
        fieldKey,
        json(fact.values),
        json({
          source: "VERIFIED_PROCUREMENT_DOCUMENTS",
          parser: "document-scope-materializer-v2",
          parserVersion: PIPELINE_SCHEMA_VERSION,
          lotScoped: Boolean(selectedLotId),
          selectedLotId,
          evidence: fact.evidence,
        }),
        selectedLotId,
      ],
    );
  const securityText = authoritativeSources
      .flatMap((document) =>
        (document.extracted_data?.pages || []).map((page) => page.text || ""),
      )
      .join("\n"),
    annualMatch = securityText.match(
      /jährlich\s+([\d.]+(?:,[\d]+)?)\s+zu\s+vergütenden\s+Einsatzstunden/i,
    ),
    periodMatch = securityText.match(
      /Laufzeit des Vertrages beginnt am\s+(\d{2}\.\d{2}\.\d{4})\s+und endet grundsätzlich am\s+(\d{2}\.\d{2}\.\d{4})/i,
    ),
    workdaysMatch = securityText.match(/(\d+)\s+prod\.?\s*Arbeitstage/i);
  if (annualMatch && periodMatch) {
    const annual = Number(annualMatch[1].replaceAll(".", "").replace(",", ".")),
      parseDate = (value) => {
        const [day, month, year] = value.split(".").map(Number);
        return new Date(Date.UTC(year, month - 1, day));
      },
      start = parseDate(periodMatch[1]),
      end = parseDate(periodMatch[2]),
      months =
        (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
        end.getUTCMonth() -
        start.getUTCMonth() +
        1,
      total = (annual * months) / 12,
      evidence = {
        annualHoursText: annualMatch[0],
        contractPeriodText: periodMatch[0],
        formula: `${annual} h/Jahr × ${months} Monate ÷ 12`,
        sourceDocuments: authoritativeSources.map((document) => ({
          id: document.id,
          filename: document.filename,
          hash: document.payload_sha256,
        })),
      };
    for (const [key, value, unit] of [
      ["productive_hours", total, "h initiale Vertragslaufzeit"],
      ["productive_hours_per_year", annual, "h/Jahr"],
    ])
      await pool.query(
        `INSERT INTO tender.enrichment_fields(enrichment_version_id,field_key,value,quality_status,provenance,confidence) SELECT $1,$2,$3::jsonb,'VORHANDEN',$4::jsonb,0.99 WHERE NOT EXISTS(SELECT 1 FROM tender.enrichment_fields WHERE enrichment_version_id=$1 AND field_key=$2 AND provenance->>'parser'='security-schedule-v1' AND provenance->>'selectedLotId' IS NOT DISTINCT FROM $5)`,
        [
          enrichmentId,
          key,
          json(value),
          json({
            source: "AUTHORITATIVE_SECURITY_SCHEDULE",
            parser: "security-schedule-v1",
            parserVersion: PIPELINE_SCHEMA_VERSION,
            selectedLotId,
            unit,
            evidence,
          }),
          selectedLotId,
        ],
      );
    if (workdaysMatch)
      await pool.query(
        `INSERT INTO tender.enrichment_fields(enrichment_version_id,field_key,value,quality_status,provenance,confidence) SELECT $1,'workdays',$2::jsonb,'VORHANDEN',$3::jsonb,0.99 WHERE NOT EXISTS(SELECT 1 FROM tender.enrichment_fields WHERE enrichment_version_id=$1 AND field_key='workdays' AND provenance->>'parser'='security-schedule-v1' AND provenance->>'selectedLotId' IS NOT DISTINCT FROM $4)`,
        [
          enrichmentId,
          json(Number(workdaysMatch[1])),
          json({
            source: "AUTHORITATIVE_SECURITY_SCHEDULE",
            parser: "security-schedule-v1",
            parserVersion: PIPELINE_SCHEMA_VERSION,
            selectedLotId,
            unit: "Tage/Jahr",
            evidence: {
              text: workdaysMatch[0],
              sourceDocuments: evidence.sourceDocuments,
            },
          }),
          selectedLotId,
        ],
      );
  }
  for (const securitySource of authoritativeSources)
    for (const fact of deriveRibSecurityLvFacts(securitySource))
      await pool.query(
        `INSERT INTO tender.enrichment_fields(enrichment_version_id,field_key,value,quality_status,provenance,confidence) SELECT $1,$2,$3::jsonb,'VORHANDEN',$4::jsonb,0.99 WHERE NOT EXISTS(SELECT 1 FROM tender.enrichment_fields WHERE enrichment_version_id=$1 AND field_key=$2 AND provenance->>'parser'='rib-security-lv-v2' AND provenance->>'selectedLotId' IS NOT DISTINCT FROM $5)`,
        [
          enrichmentId,
          fact.key,
          json(fact.value),
          json({
            source: "AUTHORITATIVE_LV_DERIVATION",
            parser: "rib-security-lv-v2",
            parserVersion: PIPELINE_SCHEMA_VERSION,
            lotScoped: Boolean(selectedLotId),
            selectedLotId,
            unit: fact.unit,
            formula: fact.formula || null,
            evidence: fact.evidence,
          }),
          selectedLotId,
        ],
      );
  const selectedLotKey =
    selected.length === 1 ? selected[0]?.lotKey || null : null;
  for (const fact of deriveCleaningRoomBookFacts(
    authoritativeSources,
    selectedLotKey,
  ))
    await pool.query(
      `WITH refreshed AS (
         UPDATE tender.enrichment_fields
            SET value=$3::jsonb,
                quality_status='VORHANDEN',
                provenance=$4::jsonb,
                confidence=0.99
          WHERE enrichment_version_id=$1
            AND field_key=$2
            AND provenance->>'parser'='cleaning-room-book-v4'
            AND provenance->>'selectedLotId' IS NOT DISTINCT FROM $5
          RETURNING id
       )
       INSERT INTO tender.enrichment_fields(
         enrichment_version_id,
         field_key,
         value,
         quality_status,
         provenance,
         confidence
       )
       SELECT $1,$2,$3::jsonb,'VORHANDEN',$4::jsonb,0.99
       WHERE NOT EXISTS(SELECT 1 FROM refreshed)`,
      [
        enrichmentId,
        fact.key,
        json(fact.value),
        json({
          source: "AUTHORITATIVE_CLEANING_CONTRACT_DERIVATION",
          parser: "cleaning-room-book-v4",
          parserVersion: PIPELINE_SCHEMA_VERSION,
          lotScoped: Boolean(selectedLotId),
          selectedLotId,
          selectedLotKey,
          unit: fact.unit,
          formula: fact.formula || null,
          evidence: fact.evidence,
        }),
        selectedLotId,
      ],
    );
}
async function materializeDocumentContract(pool, enrichmentId, selected = []) {
  const rows = (
      await pool.query(
        `SELECT d.id,d.enrichment_version_id,d.lot_id,d.source_url,d.document_type,d.filename,d.fetch_status,d.http_status,d.mime_type,d.payload_sha256,d.extracted_data,d.parser,d.parser_version,d.retrieved_at,d.provenance,d.created_at,d.resolution_status,d.document_class,d.procurement_relevant,d.tender_association_verified,d.lot_association_verified,d.magic_bytes_verified,d.content_size,d.procurement_verification_status,e.tender_id FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id WHERE d.enrichment_version_id=$1 AND d.content IS NOT NULL AND d.payload_sha256 IS NOT NULL ORDER BY d.retrieved_at DESC NULLS LAST,d.id DESC`,
        [enrichmentId],
      )
    ).rows,
    seenPayloads = new Set();
  for (const row of rows) {
    if (
      row.document_type === "INTERNAL_ACCEPTANCE_DOCUMENT" &&
      row.provenance?.classification === "INTERNAL_ACCEPTANCE_FIXTURE"
    ) {
      row.procurement_verification_status = "VERIFIED";
      continue;
    }
    const duplicateKey = `${row.payload_sha256}:${row.lot_id || "_tender"}`;
    if (seenPayloads.has(duplicateKey)) {
      row.procurement_verification_status = "DUPLICATE_CONTENT";
      row.procurement_relevant = false;
      await pool.query(
        "UPDATE tender.enrichment_documents SET procurement_verification_status='DUPLICATE_CONTENT',procurement_relevant=false,resolution_status=CASE WHEN magic_bytes_verified=true THEN 'DOWNLOAD_SUCCEEDED' ELSE resolution_status END,provenance=provenance||$2::jsonb WHERE id=$1",
        [
          row.id,
          json({
            documentContractVersion: PIPELINE_SCHEMA_VERSION,
            duplicatePayloadSha256: row.payload_sha256,
            deduplicatedAt: new Date().toISOString(),
          }),
        ],
      );
      continue;
    }
    seenPayloads.add(duplicateKey);
    const tenderGlobal =
      row.provenance?.lotScope === "TENDER_GLOBAL" ||
      (row.lot_id == null &&
        row.mime_type === "application/zip" &&
        row.provenance?.signatureVerified === true) ||
      (row.provenance?.extractedFromArchive === true &&
        !row.provenance?.inferredArchiveLotNumber);
    if (
      String(row.provenance?.documentContractVersion || "") ===
        String(PIPELINE_SCHEMA_VERSION) &&
      row.procurement_verification_status &&
      row.procurement_verification_status !== "LOT_ASSOCIATION_MISSING" &&
      !(
        row.procurement_verification_status === "GENERAL_PORTAL_DOCUMENT" &&
        /vergabeunterlag/i.test(row.filename || "")
      )
    )
      continue;
    const content =
        (
          await pool.query(
            "SELECT content FROM tender.enrichment_documents WHERE id=$1",
            [row.id],
          )
        ).rows[0]?.content || Buffer.alloc(0),
      signatureValid = validDocumentSignature(
        content,
        row.mime_type,
        row.filename,
      ),
      tenderLinked = Boolean(
        row.tender_id &&
          (row.provenance?.tenderId || row.provenance?.sourceNotice),
      ),
      extractedText = [
        ...(row.extracted_data?.pages || []).map((page) => page.text || ""),
        ...(row.extracted_data?.worksheets || []).flatMap((sheet) =>
          (sheet.rows || []).flatMap((sheetRow) =>
            (sheetRow.cells || []).map(
              (cell) => cell.displayed ?? cell.value ?? "",
            ),
          ),
        ),
      ].join("\n"),
      classification = classifyProcurementDocument({
        filename: row.filename,
        extractedText,
        mimeType: row.mime_type,
        magicBytesValid: signatureValid,
        size: content.length,
        hash: row.payload_sha256,
        tenderLinked,
        lotLinked: Boolean(row.lot_id),
        tenderGlobal,
      });
    row.procurement_verification_status = classification.verified
      ? "VERIFIED"
      : classification.rejectionReason;
    row.document_class = classification.documentClass;
    row.procurement_relevant = classification.procurementRelevant;
    await pool.query(
      `UPDATE tender.enrichment_documents SET document_class=$2,procurement_relevant=$3,tender_association_verified=$4,lot_association_verified=$5,magic_bytes_verified=$6,content_size=$7,procurement_verification_status=$8,provenance=provenance||$9::jsonb,resolution_status=CASE WHEN $6 THEN 'DOWNLOAD_SUCCEEDED' ELSE 'DOWNLOAD_FAILED' END WHERE id=$1`,
      [
        row.id,
        classification.documentClass,
        classification.procurementRelevant,
        tenderLinked,
        Boolean(row.lot_id) || tenderGlobal,
        signatureValid,
        content.length,
        row.procurement_verification_status,
        json({
          documentContractVersion: PIPELINE_SCHEMA_VERSION,
          documentClass: classification.documentClass,
          procurementVerified: classification.verified,
          rejectionReason: classification.rejectionReason,
          lotScope: tenderGlobal ? "TENDER_GLOBAL" : "LOT",
        }),
      ],
    );
  }
  await materializeDocumentFacts(pool, enrichmentId, rows, selected);
}
async function recordLivePortalEvidence(
  pool,
  { item, enrichmentId, portalDomain, verified, sessionVerified = false },
) {
  if (!portalDomain || Number(verified) < 1 || !sessionVerified) return;
  const portal = (
    await pool.query(
      `SELECT p.*,f.id family_id FROM tender.portal_registry p LEFT JOIN tender.portal_family_domains d ON d.domain=lower(p.canonical_domain) LEFT JOIN tender.portal_families f ON f.id=d.portal_family_id WHERE p.canonical_domain=$1 OR $1=ANY(p.allowed_subdomains) OR $1=ANY(p.download_domains) ORDER BY p.adapter_enabled DESC LIMIT 1`,
      [portalDomain],
    )
  ).rows[0];
  if (!portal?.family_id || !portal.adapter_enabled) return;
  const hashes = (
    await pool.query(
      "SELECT id,filename,payload_sha256,document_class FROM tender.enrichment_documents WHERE enrichment_version_id=$1 AND procurement_verification_status='VERIFIED' ORDER BY filename",
      [enrichmentId],
    )
  ).rows;
  await pool.query(
    `INSERT INTO tender.portal_live_health(portal_family_id,portal_id,effective_status,login_result,document_fetch_possible,tender_id,lot_key,evidence) SELECT $1,$2,'LIVE_VALIDATED','LOGIN_SUCCEEDED',true,$3,$4,$5::jsonb WHERE NOT EXISTS(SELECT 1 FROM tender.portal_live_health WHERE evidence->>'jobId'=$6)`,
    [
      portal.family_id,
      portal.id,
      item.tender_id,
      item.lot_key || null,
      json({
        jobId: item.id,
        enrichmentVersionId: enrichmentId,
        verifiedDocuments: hashes,
        sessionVerified: true,
        contractVersion: PIPELINE_SCHEMA_VERSION,
        externalWrite: false,
      }),
      String(item.id),
    ],
  );
}
async function refreshCanonicalDocumentCounts(pool, jobId, enrichmentId) {
  await pool.query(
    `WITH source AS(SELECT d.*,lower(coalesce(filename,'')) LIKE '%.zip' AND coalesce((provenance->>'archiveChildrenMaterialized')::int,0)>0 materialized_archive FROM tender.enrichment_documents d WHERE enrichment_version_id=$2),counts AS(SELECT count(DISTINCT coalesce(payload_sha256,source_url)) FILTER(WHERE document_type='PORTAL_TENDER_DOCUMENT' AND coalesce(procurement_verification_status,'')<>'DUPLICATE_CONTENT' AND NOT materialized_archive)::int found,count(*) FILTER(WHERE procurement_verification_status='VERIFIED' AND NOT materialized_archive)::int downloaded,count(*) FILTER(WHERE procurement_verification_status='VERIFIED' AND parser IS NOT NULL AND NOT materialized_archive)::int analyzed FROM source) UPDATE tender.autopilot_queue q SET documents_found=c.found,documents_downloaded=c.downloaded,documents_analyzed=c.analyzed,total_items=c.found,successful_items=c.analyzed,failed_items=greatest(0,c.found-c.analyzed),result_counts=jsonb_build_object('found',c.found,'downloaded',c.downloaded,'analyzed',c.analyzed,'deduplicated',true,'archiveScoped',true,'directDocumentsIncluded',true) FROM counts c WHERE q.id=$1`,
    [jobId, enrichmentId],
  );
}
async function canonicalProcurementDocumentCounts(pool,enrichmentId,lotKey){
  return (await pool.query(`WITH source AS(
      SELECT d.*,lower(coalesce(filename,'')) LIKE '%.zip'
        AND coalesce((provenance->>'archiveChildrenMaterialized')::int,0)>0 materialized_archive
      FROM tender.enrichment_documents d
      WHERE enrichment_version_id=$1
        AND (d.lot_id IS NULL OR EXISTS(SELECT 1 FROM tender.enrichment_lots l
          WHERE l.id=d.lot_id AND l.enrichment_version_id=d.enrichment_version_id AND l.lot_key=$2))
    ) SELECT
      count(DISTINCT coalesce(payload_sha256,source_url)) FILTER(
        WHERE document_type='PORTAL_TENDER_DOCUMENT' AND coalesce(procurement_relevant,true)
          AND coalesce(document_class,'')<>'GENERAL_PORTAL_DOCUMENT'
          AND coalesce(procurement_verification_status,'')<>'DUPLICATE_CONTENT' AND NOT materialized_archive)::int found,
      count(*) FILTER(WHERE procurement_verification_status='VERIFIED'
        AND coalesce(procurement_relevant,true) AND coalesce(document_class,'')<>'GENERAL_PORTAL_DOCUMENT'
        AND NOT materialized_archive)::int downloaded,
      count(*) FILTER(WHERE procurement_verification_status='VERIFIED' AND parser IS NOT NULL
        AND coalesce(procurement_relevant,true) AND coalesce(document_class,'')<>'GENERAL_PORTAL_DOCUMENT'
        AND NOT materialized_archive)::int analyzed,
      max(coalesce(provenance->>'targetPortal',provenance->>'portal')) portal,
      (array_agg(coalesce(resolution_status,fetch_status) ORDER BY CASE coalesce(resolution_status,fetch_status)
        WHEN 'DOWNLOAD_FAILED' THEN 1 WHEN 'PORTAL_ACCESS_REQUIRED' THEN 2
        WHEN 'EXTERNAL_DOCUMENT_REQUEST_REQUIRED' THEN 3 ELSE 9 END)
        FILTER(WHERE coalesce(document_class,'')<>'GENERAL_PORTAL_DOCUMENT'
          AND document_type IN('PORTAL_TENDER_DOCUMENT','TENDER_DOCUMENT')))[1] access
    FROM source`,[enrichmentId,lotKey])).rows[0];
}
async function recordResolvedPortalEvidence(pool, item, enrichmentId) {
  const resolved = (
      await pool.query(
        `SELECT p.id,p.canonical_domain FROM tender.enrichment_documents d JOIN tender.portal_registry p ON lower(split_part(split_part(d.source_url,'://',2),'/',1))=p.canonical_domain OR lower(split_part(split_part(d.source_url,'://',2),'/',1))=ANY(p.allowed_subdomains) WHERE d.enrichment_version_id=$1 AND p.adapter_enabled ORDER BY (d.content IS NOT NULL) DESC,d.retrieved_at DESC NULLS LAST LIMIT 1`,
        [enrichmentId],
      )
    ).rows[0],
    verified = Number(
      (
        await pool.query(
          "SELECT count(*)::int n FROM tender.enrichment_documents WHERE enrichment_version_id=$1 AND procurement_verification_status='VERIFIED'",
          [enrichmentId],
        )
      ).rows[0]?.n || 0,
    );
  if (!resolved || !verified) return;
  await recordLivePortalEvidence(pool, {
    item,
    enrichmentId,
    portalDomain: resolved.canonical_domain,
    verified,
  });
  await pool.query(
    "UPDATE tender.portal_registry SET adapter_validation_status='PRODUCTION_VALIDATED',last_successful_document_fetch_at=now(),last_error_code=NULL,last_verified_at=now(),updated_at=now() WHERE id=$1",
    [resolved.id],
  );
}
async function ensureProcedureMonitoring(pool, item, tender) {
  if (tender.data_class !== "PUBLIC_REAL") return;
  const adapter = (
    await pool.query(
      "SELECT id FROM tender.portal_adapters WHERE portal_code=$1",
      [item.adapter_id],
    )
  ).rows[0];
  if (!adapter) return;
  await pool.query(
    `INSERT INTO tender.procedure_monitoring(tender_id,lot_key,portal_adapter_id,status,last_checked_at,next_check_at,assigned_user_id,state)
    VALUES($1,$2,$3,'ACTIVE',NULL,now(),$4,$5::jsonb)
    ON CONFLICT(tender_id,lot_key,portal_adapter_id) DO UPDATE SET status=CASE WHEN tender.procedure_monitoring.status='PROCEDURE_CLOSED' THEN tender.procedure_monitoring.status ELSE 'ACTIVE' END,next_check_at=least(coalesce(tender.procedure_monitoring.next_check_at,now()),now()),updated_at=now()`,
    [
      tender.id,
      item.lot_key || "",
      adapter.id,
      item.created_by || null,
      json({
        monitoringVersion: PIPELINE_VERSION,
        sourceUrl: tender.source_url,
        establishedByJobId: item.id,
        externalWrite: false,
      }),
    ],
  );
}
async function monitorDueProcedure(pool) {
  const row = (
    await pool.query(
      `SELECT m.*,t.source_url,t.offer_deadline,t.data_class FROM tender.procedure_monitoring m JOIN tender.tenders t ON t.id=m.tender_id WHERE m.status='ACTIVE' AND coalesce(m.next_check_at,now())<=now() AND t.data_class='PUBLIC_REAL' ORDER BY m.next_check_at NULLS FIRST FOR UPDATE OF m SKIP LOCKED LIMIT 1`,
    )
  ).rows[0];
  if (!row) return false;
  let source;
  try {
    source = new URL(row.source_url);
  } catch {
    source = null;
  }
  if (!source || !["https:", "http:"].includes(source.protocol)) {
    await pool.query(
      "UPDATE tender.procedure_monitoring SET status='REVIEW_REQUIRED',last_checked_at=now(),next_check_at=now()+interval '1 hour',state=state||$2::jsonb,updated_at=now() WHERE id=$1",
      [
        row.id,
        json({ lastEventType: "SOURCE_URL_INVALID", externalWrite: false }),
      ],
    );
    return true;
  }
  const fetched = await fetchBounded(source.href, { maxBytes: 20_000_000 });
  if (fetched.status !== "FETCHED") {
    await pool.query(
      "UPDATE tender.procedure_monitoring SET last_checked_at=now(),next_check_at=now()+interval '30 minutes',state=state||$2::jsonb,updated_at=now() WHERE id=$1",
      [
        row.id,
        json({
          lastEventType: "MONITORING_RETRY_SCHEDULED",
          safeResult: fetched.status,
          httpStatus: fetched.httpStatus || null,
          externalWrite: false,
        }),
      ],
    );
    return true;
  }
  const hash = crypto.createHash("sha256").update(fetched.buffer).digest("hex"),
    changed = Boolean(row.last_event_sha256 && row.last_event_sha256 !== hash),
    eventType = row.last_event_sha256
      ? changed
        ? "SOURCE_CHANGED"
        : "SOURCE_UNCHANGED"
      : "BASELINE_ESTABLISHED";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE tender.procedure_monitoring SET last_checked_at=now(),next_check_at=now()+interval '15 minutes',last_event_sha256=$2,state=state||$3::jsonb,updated_at=now() WHERE id=$1",
      [
        row.id,
        hash,
        json({
          lastEventType: eventType,
          sourceHost: source.hostname,
          httpStatus: fetched.httpStatus,
          checkedAt: new Date().toISOString(),
          externalWrite: false,
        }),
      ],
    );
    await client.query(
      "INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES($1,$2,$3::jsonb)",
      [
        changed
          ? "procedure_source_change_detected"
          : "procedure_monitoring_checked",
        row.tender_id,
        json({
          monitoringId: row.id,
          eventType,
          sourceHost: source.hostname,
          contentSha256: hash,
          externalWrite: false,
        }),
      ],
    );
    if (changed)
      await client.query(
        `INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,lot_key,company_id,service_scope,portal_id,credential_id,enrichment_version_id,assessment_version_id,idempotency_key,reason,status,current_step,max_attempts)
      SELECT gen_random_uuid(),'RUN_FULL_PIPELINE',r.tender_id,v.id,coalesce(t.notice_number,t.external_id),r.lot_key,r.company_id,r.service_line,registered.portal_id,registered.credential_id,e.id,r.evaluation_version,concat('MONITORING_CHANGE:',r.tender_id,':',coalesce(r.lot_key,''),':',r.company_id,':',registered.portal_id,':',$2::text),'MONITORING_CHANGE_REPROCESS','QUEUED','DISCOVERED',3
      FROM tender.current_service_relevance r JOIN tender.tenders t ON t.id=r.tender_id JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=r.tender_id AND registered.company_id=r.company_id JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=r.tender_id ORDER BY version DESC LIMIT 1)v ON true JOIN LATERAL(SELECT id FROM tender.enrichment_versions WHERE tender_id=r.tender_id ORDER BY version DESC LIMIT 1)e ON true WHERE r.tender_id=$1 AND r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED' AND r.primary_company=true ON CONFLICT DO NOTHING`,
        [row.tender_id, hash],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return true;
}
async function legacyCompanyContexts(pool, tender) {
  const companies = (
      await pool.query(
        "SELECT * FROM tender.enterprise_company_links WHERE active=true ORDER BY legal_name",
      )
    ).rows,
    result = [];
  for (const company of companies) {
    const serviceLine = company.sector_slug || "cleaning",
      [region, parameterRows, profile, costConfig] = await Promise.all([
        pool.query(
          "SELECT * FROM tender.region_evaluations WHERE tender_id=$1 AND company_id=$2 AND lot_id IS NULL ORDER BY evaluation_version DESC LIMIT 1",
          [tender.id, company.company_id],
        ),
        pool.query(
          `SELECT c.id,c.version_id,v.version_no,a.activated_at,a.company_id,a.service_line,a.parameter_key,c.new_value,c.unit,c.valid_from,c.valid_until,'ACTIVE'::text status,c.created_at FROM tender.configuration_active_parameters a JOIN tender.configuration_changes c ON c.id=a.change_id JOIN tender.configuration_versions v ON v.id=c.version_id WHERE a.company_id=$1 AND a.service_line=$2 ORDER BY a.parameter_key,v.version_no DESC`,
          [company.company_id, serviceLine],
        ),
        pool.query(
          "SELECT p.* FROM tender.enterprise_company_links l JOIN tender.company_profiles p ON p.id=l.tender_profile_id WHERE l.company_id=$1 AND l.active=true LIMIT 1",
          [company.company_id],
        ),
        pool.query(
          "SELECT * FROM tender.cost_configurations WHERE company_id=$1 AND service_line=$2 AND status='ACTIVE' AND effective_from<=current_date ORDER BY version DESC LIMIT 1",
          [company.company_id, serviceLine],
        ),
      ]);
    const effective = resolveEffectiveParameters(parameterRows.rows, {
        asOf: new Date(),
      }),
      companyProfile = profile.rows[0] || null;
    const sourceManifest = Object.fromEntries(
      Object.entries(effective.parameters).map(([key, value]) => [
        key,
        {
          parameterId: value.parameterId,
          sourceVersionId: value.sourceVersionId,
          sourceVersion: value.sourceVersion,
          validFrom: value.validFrom,
          validUntil: value.validUntil,
        },
      ]),
    );
    const unified = buildEffectiveCompanyProfile({
      companyId: company.company_id,
      serviceArea: serviceLine,
      parameters: effective.parameters,
      companyProfile,
      sourceManifest,
    });
    const persisted = (
      await pool.query(
        `INSERT INTO tender.effective_profile_snapshots(company_id,service_line,effective_at,resolver_version,snapshot_sha256,parameters,ambiguities,source_manifest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) ON CONFLICT(company_id,service_line,snapshot_sha256) DO UPDATE SET source_manifest=excluded.source_manifest RETURNING id`,
        [
          company.company_id,
          serviceLine,
          unified.resolvedAt,
          PIPELINE_SCHEMA_VERSION,
          unified.snapshotId,
          json(unified.parameters),
          json(effective.ambiguities),
          json({
            ...sourceManifest,
            __effectiveProfile: {
              companyProfileId: unified.companyProfileId,
              companyProfileVersion: unified.companyProfileVersion,
              additional: unified.additional,
              readiness: unified.readiness,
            },
          }),
        ],
      )
    ).rows[0];
    result.push({
      company,
      parameters: profileParameterRows(unified),
      profile: { ...companyProfile, effective: unified },
      profileSnapshot: {
        ...unified,
        id: persisted.id,
        ambiguities: effective.ambiguities,
      },
      region: region.rows[0] || null,
      costConfig: costConfig.rows[0] || null,
    });
  }
  return result;
}
async function relevancePlan(pool, tender, enrichment, { suppressPipelineEnqueue = false, pipelineJobId = "" } = {}) {
  const contexts = await companyContexts(pool, tender),
    lots = (
      await pool.query(
        "SELECT * FROM tender.enrichment_lots WHERE enrichment_version_id=$1 ORDER BY lot_key",
        [enrichment.id],
      )
    ).rows,
    targets = lots.length
      ? lots.map((row) => {
          const lot = {
            ...row,
            ...(row.structured_data || {}),
            id: row.id,
            lot_key: row.lot_key,
          };
          return {
            lot,
            lotKey: row.lot_key,
            enrichment: {
              ...enrichment,
              structured_data: {
                ...enrichment.structured_data,
                lots: [row.structured_data],
                scope:
                  row.structured_data?.scope ||
                  enrichment.structured_data?.scope,
              },
            },
          };
        })
      : [{ lot: null, lotKey: null, enrichment }],
    selected = [];
  for (const target of targets) {
    const result = classifyTenderServices({
      tender,
      lot: target.lot,
      enrichment: target.enrichment,
      companies: contexts,
    });
    for (const evaluation of result.evaluations) {
      const effectiveContext = contexts.find(
          (item) =>
            String(item.company.company_id) === String(evaluation.companyId),
        ),
        snapshot = relevanceSnapshotHash({
          pipeline: PIPELINE_VERSION,
          tenderId: tender.id,
          lotKey: evaluation.lotKey,
          companyId: evaluation.companyId,
          enrichmentVersion: enrichment.version,
          effectiveProfileId: effectiveContext?.profileSnapshot?.id || null,
          effectiveProfileVersion:
            effectiveContext?.profileSnapshot?.snapshotId || null,
          enterpriseConfigurationVersion:
            effectiveContext?.company?.configuration_version || null,
          appliedRules: evaluation.appliedRules,
          cpvCodes: evaluation.cpvCodes,
        });
      const version = Number(
        (
          await pool.query(
            "SELECT coalesce(max(evaluation_version),0)+1 version FROM tender.service_relevance_evaluations WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3",
            [tender.id, evaluation.companyId, evaluation.lotKey],
          )
        ).rows[0].version,
      );
      const relevanceValues = [
          tender.id,
          enrichment.id,
          evaluation.companyId,
          evaluation.lotKey,
          version,
          PIPELINE_VERSION,
          snapshot,
          evaluation.relevanceStatus,
          evaluation.serviceScopeGate,
          evaluation.primaryCompany,
          evaluation.serviceLine,
          evaluation.processable ? "FULL_PIPELINE_ALLOWED" : "NO_GO_FACHLICH",
          evaluation.reason,
          json(evaluation.positiveSignals),
          json(evaluation.exclusionSignals),
          json(evaluation.cpvCodes),
          json(evaluation.appliedRules),
          json({
            rawTenderChanged: false,
            documentsDownloaded: false,
            effectiveProfileId: effectiveContext?.profileSnapshot?.id || null,
            effectiveProfileVersion:
              effectiveContext?.profileSnapshot?.snapshotId || null,
            enterpriseConfigurationVersion:
              effectiveContext?.company?.configuration_version || null,
          }),
        ];
      await pool.query(
        suppressPipelineEnqueue
          ? `WITH suppression AS (SELECT set_config('tender.pipeline_job_id',$19,true))
             INSERT INTO tender.service_relevance_evaluations(tender_id,enrichment_version_id,company_id,lot_key,evaluation_version,classifier_version,snapshot_sha256,relevance_status,service_scope_gate,primary_company,alternative_company,service_line,recommendation,reason,positive_signals,exclusion_signals,applied_cpv_codes,applied_rules,source_manifest)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb FROM suppression ON CONFLICT DO NOTHING`
          : `INSERT INTO tender.service_relevance_evaluations(tender_id,enrichment_version_id,company_id,lot_key,evaluation_version,classifier_version,snapshot_sha256,relevance_status,service_scope_gate,primary_company,alternative_company,service_line,recommendation,reason,positive_signals,exclusion_signals,applied_cpv_codes,applied_rules,source_manifest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb) ON CONFLICT DO NOTHING`,
        suppressPipelineEnqueue ? [...relevanceValues, String(pipelineJobId || "PORTAL_RESOLUTION")] : relevanceValues,
      );
    }
    if (result.primary) {
      const context = contexts.find(
        (item) =>
          String(item.company.company_id) === String(result.primary.companyId),
      );
      selected.push({ ...target, ...context, relevance: result.primary, lots });
    }
  }
  return selected;
}
async function authoritativeQueuedSelection(pool,tender,enrichment,item,selected){
  const exact=selected.filter(candidate=>String(candidate.company?.company_id)===String(item.company_id)
    &&(candidate.lotKey??null)===(item.lot_key??null));
  if(exact.length||!item.company_id||!item.lot_key)return exact;
  const decision=(await pool.query(`SELECT relevance.* FROM tender.service_relevance_evaluations relevance
    WHERE relevance.tender_id=$1 AND relevance.company_id=$2 AND (relevance.lot_key=$3 OR relevance.lot_key IS NULL)
      AND relevance.relevance_status='RELEVANT' AND relevance.service_scope_gate='PASSED'
      AND relevance.recommendation='FULL_PIPELINE_ALLOWED' AND relevance.primary_company=true
      AND NOT EXISTS(SELECT 1 FROM tender.service_relevance_evaluations newer
        WHERE newer.tender_id=relevance.tender_id AND newer.company_id=relevance.company_id
          AND newer.lot_key IS NOT DISTINCT FROM relevance.lot_key AND newer.evaluation_version>relevance.evaluation_version)
    ORDER BY (relevance.lot_key IS NOT DISTINCT FROM $3) DESC,relevance.evaluation_version DESC LIMIT 1`,
    [tender.id,item.company_id,item.lot_key])).rows[0];
  if(!decision)return [];
  const selection=(await pool.query(`SELECT selection.lot_id,selection.source_lot_id FROM tender.tender_lot_selections selection
    JOIN tender.lots lot ON lot.id=selection.lot_id AND lot.tender_id=selection.tender_id
      AND lot.external_id=selection.source_lot_id
    WHERE selection.tender_id=$1 AND selection.company_id=$2 AND selection.source_lot_id=$3`,
    [tender.id,item.company_id,item.lot_key])).rows[0];
  if(!selection)return [];
  const contexts=await companyContexts(pool,tender),companyContext=contexts.find(context=>String(context.company.company_id)===String(item.company_id));
  if(!companyContext)return [];
  await bindExactEnrichmentContext(pool,{tender,enrichment,company:companyContext.company,lotKey:item.lot_key});
  const binding=(await pool.query(`SELECT id FROM tender.enrichment_context_bindings WHERE enrichment_version_id=$1
    AND tenant_id=$2 AND company_id=$3 AND tender_id=$4 AND lot_id=$5 AND source_lot_id=$6`,
    [enrichment.id,companyContext.company.tenant_id,item.company_id,tender.id,selection.lot_id,item.lot_key])).rows;
  if(binding.length!==1)return [];
  const
    lots=(await pool.query("SELECT * FROM tender.enrichment_lots WHERE enrichment_version_id=$1 ORDER BY lot_key",[enrichment.id])).rows,
    row=lots.find(candidate=>candidate.lot_key===item.lot_key);
  if(!row)return [];
  const lot={...row,...(row.structured_data||{}),id:row.id,lot_key:row.lot_key};
  return [{lot,lotKey:row.lot_key,enrichment:{...enrichment,structured_data:{...enrichment.structured_data,lots:[row.structured_data],scope:row.structured_data?.scope||enrichment.structured_data?.scope}},
    ...companyContext,relevance:{...decision,companyId:decision.company_id,lotKey:item.lot_key,processable:true},lots}];
}
async function reviewSelected(pool, tender, enrichment, selected) {
  const actor = (
    await pool.query(
      "SELECT u.id FROM iam.users u JOIN iam.user_roles ur ON ur.user_id=u.id JOIN iam.role_permissions rp ON rp.role_id=ur.role_id JOIN iam.permissions p ON p.id=rp.permission_id WHERE u.active=true AND p.code='tender.admin' ORDER BY u.id LIMIT 1",
    )
  ).rows[0];
  if (!actor) throw new Error("autopilot_actor_missing");
  const enrichmentFields = (
      await pool.query(
        "SELECT * FROM tender.enrichment_fields WHERE enrichment_version_id=$1 ORDER BY field_key,created_at,id",
        [enrichment.id],
      )
    ).rows,
    enrichmentDocuments = (
      await pool.query(
        "SELECT id,enrichment_version_id,lot_id,source_url,document_type,filename,fetch_status,http_status,mime_type,payload_sha256,extracted_data,parser,parser_version,retrieved_at,provenance,created_at,resolution_status,document_class,procurement_relevant,tender_association_verified,lot_association_verified,magic_bytes_verified,content_size,procurement_verification_status FROM tender.enrichment_documents WHERE enrichment_version_id=$1 ORDER BY source_url",
        [enrichment.id],
      )
    ).rows;
  for (const target of selected) {
    const company = target.company,
      enrichmentBinding = await bindExactEnrichmentContext(pool,{
        tender,enrichment,company,lotKey:target.lotKey,
      }),
      targetEnrichmentFields = selectLotEnrichmentFields(
        enrichmentFields,
        target.lot?.id || null,
      ),
      targetEnrichmentDocuments = enrichmentDocuments.filter(
        (document) =>
          !document.lot_id ||
          String(document.lot_id) === String(target.lot?.id || ""),
      ),
      context = {
        tender,
        company,
        region: target.region,
        lots: target.lots,
        requirements: [],
        findings: [],
        documents: [],
        parameters: target.parameters,
        profile: target.profile,
        costConfig: target.costConfig,
        enrichment: target.enrichment,
        enrichmentFields: targetEnrichmentFields,
        enrichmentDocuments: targetEnrichmentDocuments,
      },
      version = Number(
        (
          await pool.query(
            "SELECT coalesce(max(result_version),0)+1 v FROM tender.autopilot_results WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3",
            [tender.id, company.company_id, target.lotKey],
          )
        ).rows[0].v,
      ),
      review = buildFullTenderReview({ ...context, version }),
      preparedTasks = review.recommendation.nextSteps.map((title, index) => ({
        key: `TASK-${index + 1}`,
        title,
        status: "PREPARED_INTERNAL",
        externalEffect: false,
      })),
      preparedDeadlines = review.procurement
        .filter((x) => /frist|beginn/i.test(x.label) && x.value)
        .map((x) => ({
          label: x.label,
          value: x.value,
          status: "PREPARED_INTERNAL",
        })),
      brief = {
        executiveSummary: review.recommendation.reason,
        tender: { id: tender.id, title: tender.title, buyer: tender.buyer },
        lot: target.lotKey,
        company: { id: company.company_id, name: company.legal_name },
        profileSnapshotId: target.profileSnapshot?.id || null,
        profileSources: target.profileSnapshot
          ? Object.fromEntries(
              Object.entries(target.profileSnapshot.parameters).map(
                ([key, value]) => [
                  key,
                  {
                    parameterId: value.parameterId,
                    sourceVersionId: value.sourceVersionId,
                    validFrom: value.validFrom,
                    validUntil: value.validUntil,
                  },
                ],
              ),
            )
          : {},
        documentState: targetEnrichmentDocuments.map((document) => ({
          id: document.id,
          filename: document.filename,
          hash: document.payload_sha256,
          status:
            document.procurement_verification_status ||
            document.resolution_status ||
            document.fetch_status,
        })),
        recommendation: review.recommendation,
        opportunities: [review.serviceMatching.reason],
        risks: review.risks,
        economics: review.calculation,
        openPoints: review.recommendation.openQuestions,
        deadlines: preparedDeadlines,
        responsibilities: preparedTasks,
        requiredDecisions: review.recommendation.failedGates,
        binding: false,
      };
    const insertedResult = await pool.query(
      `INSERT INTO tender.autopilot_results(tender_id,enrichment_version_id,company_id,lot_key,result_version,pipeline_version,stage_status,review,prepared_tasks,prepared_deadlines,board_brief,source_manifest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb)
       ON CONFLICT(tender_id,company_id,lot_key,result_version) DO NOTHING RETURNING id`,
      [
        tender.id,
        enrichment.id,
        company.company_id,
        target.lotKey,
        version,
        PIPELINE_VERSION,
        json({
          notice: "DONE",
          lots: "DONE",
          documents: targetEnrichmentDocuments.some(
            (x) => x.procurement_verification_status === "VERIFIED",
          )
            ? "PROCUREMENT_DOCUMENTS_VERIFIED"
            : "PROCUREMENT_DOCUMENTS_NOT_VERIFIED",
          quality: "DONE",
          matching: "DONE",
          serviceScopeGate: "PASSED",
          region: "DONE",
          hardGates: "DONE",
          capacity: "DONE",
          calculation: review.calculation.status,
          recommendation: review.recommendation.decision,
        }),
        json(review),
        json(preparedTasks),
        json(preparedDeadlines),
        json(brief),
        json({
          enrichmentVersion: enrichment.version,
          payloadSha256: enrichment.payload_sha256,
          companyId: company.company_id,
          lotKey: target.lotKey,
          relevanceStatus: target.relevance.relevanceStatus,
          profileSnapshotId: target.profileSnapshot?.id || null,
          profileSnapshotSha256: target.profileSnapshot?.snapshotId || null,
          enrichmentContextBindingId: enrichmentBinding?.id || null,
        }),
      ],
    );
    if (!insertedResult.rowCount) continue;
    await pool.query(
      "INSERT INTO tender.evaluations(tender_id,actor_id,score,explanation) VALUES($1,$2,NULL,$3::jsonb)",
      [
        tender.id,
        actor.id,
        json({
          reviewType: "FULL_TENDER_AUTOPILOT",
          companyId: String(company.company_id),
          lotKey: String(target.lotKey || ""),
          evaluationVersion: version,
          profileSnapshotId: target.profileSnapshot?.id || null,
          review,
        }),
      ],
    );
  }
}
const valueFor = (rows, label) => rows?.find((x) => x.label === label)?.value;
const supplied = isExplicitlySupplied;
export function validateCalculationInputs(review, documents, lotKey) {
  const p = review.calculation?.parameters || {},
    scope = review.scope || [],
    procurement = review.procurement || [],
    calc = review.calculation || {};
  const authoritativeProductiveHours =
    valueFor(scope, "Produktivstunden") ?? valueFor(scope, "Leistungsstunden");
  const common = [
      [
        "Leistungstyp",
        review.serviceRelevance?.serviceLine,
        "individuelle Leistungs- und CPV-Prüfung",
      ],
      [
        "Objektanzahl",
        valueFor(scope, "Objektanzahl"),
        "Bekanntmachung und Vergabeunterlagen",
      ],
      [
        "Standorte",
        valueFor(procurement, "Leistungsort"),
        "Bekanntmachung und Vergabeunterlagen",
      ],
      [
        "Vertragslaufzeit",
        valueFor(procurement, "Vertragslaufzeit"),
        "Bekanntmachung und Vergabeunterlagen",
      ],
      [
        "Arbeitszeiten",
        valueFor(scope, "Leistungszeiten"),
        "Bekanntmachung und Vergabeunterlagen",
      ],
      ["Tarifgebiet", p.C02, "aktive Gesellschaftskonfiguration C02"],
      ["Tariflohn", p.C01, "aktive Gesellschaftskonfiguration C01"],
      [
        "Zuschläge / Feiertag / Nacht / Wochenende",
        p.C03,
        "aktive Gesellschaftskonfiguration C03",
      ],
      ["Materialkosten", p.C11, "aktive Gesellschaftskonfiguration C11"],
      ["Maschinenkosten", p.C12, "aktive Gesellschaftskonfiguration C12"],
      ["Fahrzeiten", p.C14, "aktive Gesellschaftskonfiguration C14"],
      ["Verwaltungskosten", p.C08, "aktive Gesellschaftskonfiguration C08"],
      [
        "Zielmarge",
        p.C19 ?? p.C20 ?? p.C21,
        "aktive Gesellschaftskonfiguration C19-C21",
      ],
      ["Risikozuschläge", p.C18, "aktive Gesellschaftskonfiguration C18"],
    ],
    serviceLine = review.serviceRelevance?.serviceLine,
    sector =
      serviceLine === "security"
        ? [
            [
              "Postenanzahl und Besetzung",
              valueFor(scope, "Postenanzahl") ??
                valueFor(scope, "Personalvorgaben"),
              "Bekanntmachung und Vergabeunterlagen",
            ],
            [
              "Bewachungszeiten",
              valueFor(scope, "Leistungszeiten"),
              "Bekanntmachung und Vergabeunterlagen",
            ],
            [
              "Arbeitstage",
              valueFor(scope, "Arbeitstage"),
              "Bekanntmachung und Vergabeunterlagen",
            ],
          ]
        : serviceLine === "facility-management"
          ? [
              ...new Set([
                ...(calc.missing || []),
                ...(review.recommendation?.openQuestions || []),
              ]),
            ]
              .filter(
                (label) =>
                  label !==
                  "Aktives, freigegebenes Facility-Kalkulationsprofil",
              )
              .map((label) => [
                label,
                valueFor(scope, label),
                "Bekanntmachung und Vergabeunterlagen",
              ])
          : [
              [
                "Flächen",
                valueFor(scope, "Flächen"),
                "Bekanntmachung und Vergabeunterlagen",
              ],
              [
                "Reinigungsintervalle",
                valueFor(scope, "Reinigungsintervalle"),
                "Bekanntmachung und Vergabeunterlagen",
              ],
              [
                "Leistungsfrequenzen",
                authoritativeProductiveHours ??
                  valueFor(scope, "Leistungsfrequenzen") ??
                  valueFor(scope, "Arbeitstage"),
                authoritativeProductiveHours
                  ? "in verifizierten Produktivstunden bereits vollständig berücksichtigt"
                  : "Bekanntmachung und Vergabeunterlagen",
              ],
            ],
    checks = [...common, ...sector];
  const missing = checks
    .filter(([, value]) => !supplied(value))
    .map(([field, , source]) => ({
      field,
      source,
      lot: lotKey || "Gesamt",
      documentStatus: documents.length
        ? documents.every((x) => x.fetch_status === "VORHANDEN")
          ? "VORHANDEN"
          : "TEILWEISE_ODER_BLOCKIERT"
        : "KEINE_DOKUMENTE",
      nextAction: `${field} aus Vergabeunterlagen übernehmen oder gesellschaftsscharf freigeben`,
    }));
  const pricePositions = valueFor(scope, "Preispositionen"),
    uncosted = Array.isArray(pricePositions)
      ? pricePositions.filter(
          (position) =>
            !["01.1", "02.3", "02.4"].includes(
              String(position?.position || ""),
            ),
        )
      : [];
  if (review.serviceRelevance?.serviceLine === "security" && uncosted.length)
    missing.push({
      field: `Autoritative Kostenansätze für Nicht-Personalpositionen ${uncosted.map((position) => position.position).join(", ")}`,
      source:
        "LV/Preisblatt und kompatible gesellschaftsscharfe Einheitspreise",
      lot: lotKey || "Gesamt",
      documentStatus: "VORHANDEN_ABER_KOSTENANSATZ_FEHLT",
      nextAction:
        "Einheitspreise für Videoanlagen, Anlagenwochen, Notruf-/Servicewochen und Baustellenausstattung fachlich freigeben; keine freie Umrechnung aus C11/C12",
    });
  return { checks, missing };
}
async function persistCalculation(pool, item, tender, enrichment) {
  const result = (
    await pool.query(
      "SELECT * FROM tender.autopilot_results WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3 AND enrichment_version_id=$4 ORDER BY result_version DESC LIMIT 1",
      [tender.id, item.company_id, item.lot_key, enrichment.id],
    )
  ).rows[0];
  if (!result)
    throw Object.assign(Error("current review missing"), {
      code: "AKTUELLE_BEWERTUNG_FEHLT",
    });
  const documents = (
    await pool.query(
      "SELECT id,lot_id,fetch_status,source_url,filename,document_type,procurement_verification_status,extracted_data,provenance,payload_sha256 FROM tender.enrichment_documents WHERE enrichment_version_id=$1 ORDER BY source_url",
      [enrichment.id],
    )
  ).rows;
  const validation = validateCalculationInputs(
      result.review,
      documents,
      item.lot_key,
    ),
    config = (
      await pool.query(
        "SELECT id FROM tender.cost_configurations WHERE company_id=$1 AND service_line=$2 AND status='ACTIVE' ORDER BY version DESC LIMIT 1",
        [item.company_id, item.service_scope],
      )
    ).rows[0];
  const explicitInputRows = (
      await pool.query(
        "SELECT DISTINCT ON(field_key) id,field_key,value,unit,version,created_by,created_at FROM tender.calculation_user_inputs WHERE tender_id=$1 AND company_id=$2 AND lot_key=$3 AND active=true AND transmitted=false ORDER BY field_key,version DESC,created_at DESC",
        [tender.id, item.company_id, item.lot_key || ""],
      )
    ).rows,
    explicitInputs = Object.fromEntries(
      explicitInputRows.map((row) => [row.field_key, row]),
    ),
    derivedContractFacts =
      item.service_scope === "cleaning"
        ? deriveCleaningRoomBookFacts(documents, item.lot_key)
        : [],
    genericContractDuration =
      item.service_scope !== "cleaning"
        ? (() => {
            const candidates = [],
              date = (value) => {
                const [day, month, year] = String(value)
                  .split(".")
                  .map(Number);

                if (
                  !Number.isInteger(day) ||
                  !Number.isInteger(month) ||
                  !Number.isInteger(year)
                )
                  return null;

                const parsed = new Date(
                  Date.UTC(year, month - 1, day),
                );

                return Number.isNaN(parsed.getTime())
                  ? null
                  : parsed;
              },
              patterns = [
                /beginnt(?:[^\d]{0,120})am\s+(\d{2}\.\d{2}\.\d{4})[\s\S]{0,180}?endet(?:[^\d]{0,80})am\s+(\d{2}\.\d{2}\.\d{4})/gi,
                /Leistungsbeginn\s*\/\s*Leistungsende(?:[^\d]{0,120})(\d{2}\.\d{2}\.\d{4})\s*[-–]\s*(\d{2}\.\d{2}\.\d{4})/gi,
                /Vertrag(?:es|slaufzeit)?(?:[^\d]{0,160})(\d{2}\.\d{2}\.\d{4})\s*[-–]\s*(\d{2}\.\d{2}\.\d{4})/gi,
              ];

            for (const document of documents) {
              const text = (document.extracted_data?.pages || [])
                .map((page) => page.text || "")
                .join("\n");

              for (const pattern of patterns) {
                pattern.lastIndex = 0;

                for (const match of text.matchAll(pattern)) {
                  const start = date(match[1]),
                    end = date(match[2]);

                  if (!start || !end || end < start) continue;

                  const months =
                    (end.getUTCFullYear() -
                      start.getUTCFullYear()) *
                      12 +
                    end.getUTCMonth() -
                    start.getUTCMonth() +
                    1;

                  if (months <= 0 || months > 240) continue;

                  candidates.push({
                    value: months,
                    unit: "Monate",
                    evidence: {
                      filename: document.filename,
                      documentId: document.id,
                      sha256: document.payload_sha256,
                      text: match[0],
                      start: match[1],
                      end: match[2],
                      formula:
                        "Kalendermonate einschließlich Start- und Endmonat",
                    },
                  });
                }
              }
            }

            const values = [
              ...new Set(candidates.map((candidate) => candidate.value)),
            ];

            if (values.length !== 1) return null;

            const selected = candidates.find(
              (candidate) => candidate.value === values[0],
            );

            return {
              key: "contract_duration_months",
              value: selected.value,
              unit: selected.unit,
              evidence: candidates
                .filter(
                  (candidate) =>
                    candidate.value === selected.value,
                )
                .map((candidate) => candidate.evidence),
              provenance: {
                source: "VERIFIED_PROCUREMENT_DOCUMENT",
                parser: "contract-duration-v1",
              },
            };
          })()
        : null,
    derivedDuration =
      derivedContractFacts.find(
        (fact) => fact.key === "contract_duration_months",
      ) ||
      genericContractDuration ||
      null;
  if (derivedDuration) {
    const check = validation.checks.find(
      (entry) => entry[0] === "Vertragslaufzeit",
    );
    if (check) check[1] = derivedDuration.value;
    validation.missing = validation.missing.filter(
      (entry) => entry.field !== "Vertragslaufzeit",
    );
  }
  const securityLvFacts =
      item.service_scope === "security"
        ? (() => {
            const positions = [],
              seen = new Set(),
              positionPattern = /^\s*(\d+(?:\.\d+)+)\s+(.+?)\s*$/,
              quantityPattern =
                /Menge:\s*([\d.]+(?:,[\d]+)?)\s+Stunde\b/i,
              number = (value) =>
                Number(String(value).replaceAll(".", "").replace(",", "."));

            for (const document of documents) {
              if (!/leistungsverzeichnis/i.test(String(document.filename || "")))
                continue;

              const documentHash =
                document.payload_sha256 ||
                document.sha256 ||
                document.id;

              for (const page of document.extracted_data?.pages || []) {
                const lines = Array.isArray(page.lines)
                  ? page.lines.map(String)
                  : String(page.text || "").split(/\r?\n/);

                for (let index = 0; index < lines.length; index += 1) {
                  const positionMatch = lines[index].match(positionPattern);
                  if (!positionMatch) continue;

                  let quantityMatch = null;

                  for (
                    let next = index + 1;
                    next < Math.min(lines.length, index + 8);
                    next += 1
                  ) {
                    if (positionPattern.test(lines[next])) break;

                    quantityMatch = lines[next].match(quantityPattern);
                    if (quantityMatch) break;
                  }

                  if (!quantityMatch) continue;

                  const quantity = number(quantityMatch[1]);
                  if (!Number.isFinite(quantity) || quantity <= 0) continue;

                  const position = positionMatch[1],
                    description = positionMatch[2].trim(),
                    identity =
                      documentHash + "|" + position + "|" + quantity;

                  if (seen.has(identity)) continue;
                  seen.add(identity);

                  positions.push({
                    position,
                    description,
                    service: description,
                    quantity,
                    unit: "Stunde",
                    source: document.filename,
                    page: page.pageNumber || null,
                    documentId: document.id,
                    sha256: document.payload_sha256 || null,
                  });
                }
              }
            }

            if (!positions.length) return null;

            const sum = (predicate) =>
              positions
                .filter(predicate)
                .reduce((total, position) => total + position.quantity, 0);

            const productiveHours = sum(() => true),
              nightHours = sum((position) =>
                /nacht/i.test(position.description),
              ),
              sundayHours = sum((position) =>
                /sonntag|sonn-\/?feiertag/i.test(position.description),
              ),
              holidayHours = sum((position) =>
                /feiertag/i.test(position.description),
              );

            return {
              productiveHours,
              nightHours,
              sundayHours,
              holidayHours,
              positions,
              provenance: {
                source: "AUTHORITATIVE_SECURITY_BILL_OF_QUANTITIES",
                parser: "security-lv-hours-v1",
                formula:
                  "Summe aller eindeutig als Stunde ausgewiesenen LV-Positionsmengen",
                productiveHours,
                positions: positions.map((position) => ({
                  position: position.position,
                  description: position.description,
                  quantity: position.quantity,
                  unit: position.unit,
                  filename: position.source,
                  page: position.page,
                  documentId: position.documentId,
                  sha256: position.sha256,
                })),
              },
            };
          })()
        : null;

  const explicitHours = Number(explicitInputs.productive_hours?.value),
    derivedSecurityHours = Number(securityLvFacts?.productiveHours),
    cleaningPerformanceRow =
      item.service_scope === "cleaning"
        ? (
            await pool.query(
              `SELECT
                   active.parameter_key,
                   change.new_value,
                   change.unit,
                   change.source,
                   active.version_id,
                   active.activated_at,
                   active.activated_by
               FROM tender.configuration_active_parameters active
               JOIN tender.configuration_changes change
                 ON change.id=active.change_id
               WHERE active.company_id=$1
                 AND active.service_line=$2
                 AND active.parameter_key='C22'
                 AND change.unit='M2_PER_HOUR'
                 AND change.valid_from<=current_date
                 AND (
                   change.valid_until IS NULL
                   OR change.valid_until>=current_date
                 )
               LIMIT 1`,
              [
                item.company_id,
                item.service_scope
              ]
            )
          ).rows[0]
        : null,
    cleaningPerformance =
      Number(
        cleaningPerformanceRow?.new_value
      ),
    annualCleaningArea =
      Number(
        derivedContractFacts.find(
          fact =>
            fact.key ===
            "annual_cleaning_area_occurrences"
        )?.value
      ),
    legacyCleaningHours =
      Number(
        derivedContractFacts.find(
          fact =>
            fact.key === "productive_hours"
        )?.value
      ),
    cleaningDurationStartSource =
      valueFor(
        result.review.procurement,
        "Ausführungsbeginn"
      ),
    cleaningDurationSource =
      derivedDuration?.value ??
      valueFor(
        result.review.procurement,
        "Vertragslaufzeit"
      ),
    cleaningContractMonths =
      (() => {
        const values = Array.isArray(cleaningDurationSource)
          ? cleaningDurationSource
          : [cleaningDurationSource],
          isoDate = value => {
            const match =
              String(value ?? "").match(
                /^(\d{4})-(\d{2})-(\d{2})(?:[+T].*)?$/
              );

            if (!match) return null;

            const parsed = new Date(
              Date.UTC(
                Number(match[1]),
                Number(match[2]) - 1,
                Number(match[3])
              )
            );

            return Number.isNaN(parsed.getTime())
              ? null
              : parsed;
          },
          structuredStart =
            isoDate(cleaningDurationStartSource);

        for (const value of values) {
          const numeric = Number(value);

          if (
            structuredStart
          ) {
            const structuredEnd =
              isoDate(value);

            if (
              structuredEnd &&
              structuredEnd >= structuredStart
            ) {
              const months =
                (
                  structuredEnd.getUTCFullYear() -
                  structuredStart.getUTCFullYear()
                ) * 12 +
                structuredEnd.getUTCMonth() -
                structuredStart.getUTCMonth() +
                1;

              if (
                months > 0 &&
                months <= 240
              )
                return months;
            }
          }

          if (Number.isFinite(numeric) && numeric > 0)
            return numeric;

          const dates = [
            ...String(value ?? "").matchAll(
              /(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/g
            )
          ].map(match =>
            new Date(
              Date.UTC(
                Number(match[3]),
                Number(match[2]) - 1,
                Number(match[1])
              )
            )
          );

          if (
            dates.length >= 2 &&
            !Number.isNaN(dates[0].getTime()) &&
            !Number.isNaN(dates.at(-1).getTime()) &&
            dates.at(-1) >= dates[0]
          ) {
            const first = dates[0];
            const last = dates.at(-1);

            const months =
              (last.getUTCFullYear() -
                first.getUTCFullYear()) *
                12 +
              last.getUTCMonth() -
              first.getUTCMonth() +
              1;

            if (months > 0 && months <= 240)
              return months;
          }

          const monthMatch =
            String(value ?? "").match(
              /(\d+(?:[.,]\d+)?)\s*(?:Monat|Monate|Monaten|months?)/i
            );

          if (monthMatch) {
            const months = Number(
              monthMatch[1].replace(",", ".")
            );

            if (
              Number.isFinite(months) &&
              months > 0 &&
              months <= 240
            )
              return months;
          }

          const yearMatch =
            String(value ?? "").match(
              /(\d+(?:[.,]\d+)?)\s*(?:Jahr|Jahre|Jahren|years?)/i
            );

          if (yearMatch) {
            const months =
              Number(
                yearMatch[1].replace(",", ".")
              ) * 12;

            if (
              Number.isFinite(months) &&
              months > 0 &&
              months <= 240
            )
              return months;
          }
        }

        return null;
      })(),
    derivedCleaningHours =
      Number.isFinite(legacyCleaningHours) &&
      legacyCleaningHours > 0
        ? legacyCleaningHours
        : Number.isFinite(annualCleaningArea) &&
            annualCleaningArea > 0 &&
            Number.isFinite(cleaningPerformance) &&
            cleaningPerformance > 0 &&
            Number.isFinite(cleaningContractMonths) &&
            cleaningContractMonths > 0
          ? annualCleaningArea /
            cleaningPerformance *
            cleaningContractMonths /
            12
          : null;

  if (
    (Number.isFinite(explicitHours) && explicitHours > 0) ||
    (Number.isFinite(derivedSecurityHours) && derivedSecurityHours > 0) ||
    (Number.isFinite(derivedCleaningHours) && derivedCleaningHours > 0)
  )
    validation.missing = validation.missing.filter(
      (entry) => entry.field !== "Produktivstunden",
    );
  const securityCostRows =
      item.service_scope === "security"
        ? (
            await pool.query(
              `SELECT a.parameter_key,c.new_value,c.unit,c.source,c.valid_from,a.version_id,a.activated_at,a.activated_by FROM tender.configuration_active_parameters a JOIN tender.configuration_changes c ON c.id=a.change_id WHERE a.company_id=$1 AND a.service_line='security' AND a.parameter_key=ANY($2::text[]) AND c.valid_from<=current_date AND (c.valid_until IS NULL OR c.valid_until>=current_date)`,
              [item.company_id, ["S01", "S02", "S03", "S04"]],
            )
          ).rows
        : [],
    securityCosts = Object.fromEntries(
      securityCostRows.map((x) => [x.parameter_key, x.new_value]),
    );
  const nonPersonnelIndex = validation.missing.findIndex((x) =>
    String(x.field).startsWith(
      "Autoritative Kostenansätze für Nicht-Personalpositionen",
    ),
  );
  if (nonPersonnelIndex >= 0) {
    validation.missing.splice(nonPersonnelIndex, 1);
    for (const [parameterKey, label, unit] of [
      ["S01", "Videoanlage", "EUR/Einheit"],
      ["S02", "Anlagenwoche", "EUR/Woche"],
      ["S03", "Notruf-/Servicewoche", "EUR/Woche"],
      ["S04", "Baustellenausstattung", "EUR"],
    ])
      if (!supplied(securityCosts[parameterKey]))
        validation.missing.push({
          field: `${label} – Kostenansatz noch nicht hinterlegt`,
          parameterKey,
          unit,
          source: "aktive gesellschaftsscharfe WB-Security-Kostenkonfiguration",
          lot: item.lot_key || "Gesamt",
          documentStatus: "VORHANDEN_ABER_UNTERNEHMENSWERT_FEHLT",
          nextAction: `${parameterKey} im Adminportal fachlich freigeben und aktivieren`,
        });
  }
  if (!config)
    validation.missing.push({
      field: "aktive Kalkulationskonfiguration",
      source: "gesellschaftsscharfe Kostenkonfiguration",
      lot: item.lot_key || "Gesamt",
      documentStatus: documents.length
        ? "VORHANDEN_ODER_GEPRÜFT"
        : "KEINE_DOKUMENTE",
      nextAction: "Kalkulationskonfiguration fachlich freigeben",
    });
  const profileSnapshotId = result.source_manifest?.profileSnapshotId || null,
    profileSnapshot = profileSnapshotId
      ? (
          await pool.query(
            "SELECT * FROM tender.effective_profile_snapshots WHERE id=$1",
            [profileSnapshotId],
          )
        ).rows[0]
      : null,
    tenderFields = validation.checks
      .filter(
        ([, value, source]) =>
          supplied(value) && !/Gesellschaftskonfiguration/.test(source),
      )
      .map(([key, value, source]) => ({ key, value, source })),
    calculationInput = buildCalculationInput({
      profileSnapshot: profileSnapshot
        ? {
            snapshotId: profileSnapshot.snapshot_sha256,
            parameters: profileSnapshot.parameters,
            ambiguities: profileSnapshot.ambiguities,
          }
        : null,
      tenderFields,
      requiredFields: [],
    });
  calculationInput.missing = validation.missing.map((entry) => ({
    ...entry,
    category: /Gesellschaft|Kalkulationskonfiguration/.test(entry.source)
      ? "MISSING_COMPANY_PARAMETER"
      : "MISSING_TENDER_INFORMATION",
  }));
  calculationInput.snapshotId = crypto
    .createHash("sha256")
    .update(
      json({
        profileSnapshotId,
        values: calculationInput.values,
        provenance: calculationInput.provenance,
        missing: calculationInput.missing,
        explicitInputs: explicitInputRows.map((row) => ({
          id: row.id,
          fieldKey: row.field_key,
          version: row.version,
        })),
      }),
    )
    .digest("hex");
  const inputRow = (
    await pool.query(
      `INSERT INTO tender.calculation_input_snapshots(tenant_id,tender_id,lot_key,company_id,profile_snapshot_id,schema_version,snapshot_sha256,parameters,provenance,missing_inputs)
       VALUES((SELECT tenant_id FROM saas.legacy_company_tenant_bindings WHERE company_id=$3),$1,$2,$3,$4,1,$5,$6::jsonb,$7::jsonb,$8::jsonb)
       ON CONFLICT(tender_id,lot_key,company_id,snapshot_sha256) DO UPDATE SET provenance=excluded.provenance RETURNING id`,
      [
        tender.id,
        item.lot_key || "",
        item.company_id,
        profileSnapshotId,
        calculationInput.snapshotId,
        json(calculationInput.values),
        json({
          ...calculationInput.provenance,
          contractDuration: derivedDuration
            ? {
                source: "VERIFIED_PROCUREMENT_DOCUMENT",
                value: derivedDuration.value,
                unit: derivedDuration.unit,
                evidence: derivedDuration.evidence,
              }
            : null,
          explicitUserInputs: explicitInputRows.map((row) => ({
            id: row.id,
            fieldKey: row.field_key,
            version: row.version,
            unit: row.unit,
            createdAt: row.created_at,
            createdBy: row.created_by,
          })),
        }),
        json(calculationInput.missing),
      ],
    )
  ).rows[0];
  const suppliedHours =
    (Number.isFinite(explicitHours) && explicitHours > 0
      ? explicitHours
      : null) ??
    (Number.isFinite(derivedSecurityHours) && derivedSecurityHours > 0
      ? derivedSecurityHours
      : null) ??
    (Number.isFinite(derivedCleaningHours) && derivedCleaningHours > 0
      ? derivedCleaningHours
      : null) ??
    result.review.calculation?.neededHours ??
    valueFor(result.review.scope, "Produktivstunden") ??
    valueFor(result.review.scope, "Leistungsstunden");
  const engineResult = calculateSectorTender({
    serviceArea: item.service_scope,
    parameters: {
      ...(result.review.calculation?.parameters || {}),
      ...securityCosts,
      ...(cleaningPerformanceRow
        ? { C22: cleaningPerformance }
        : {}),
    },
    units: {
      ...(result.review.calculation?.parameterUnits || {}),
      ...(cleaningPerformanceRow
        ? { C22: cleaningPerformanceRow.unit }
        : {}),
    },
    facts: {
      productiveHours: suppliedHours,
      workdays: valueFor(result.review.scope, "Arbeitstage"),
      duration:
        item.service_scope === "cleaning" &&
        Number.isFinite(cleaningContractMonths) &&
        cleaningContractMonths > 0
          ? cleaningContractMonths
          : (
              derivedDuration?.value ??
              valueFor(
                result.review.procurement,
                "Vertragslaufzeit"
              )
            ),
      areas: valueFor(result.review.scope, "Flächen"),
      nightHours:
        securityLvFacts?.nightHours ??
        valueFor(result.review.scope, "Nachtstunden"),
      sundayHours:
        securityLvFacts?.sundayHours ??
        valueFor(result.review.scope, "Sonntagsstunden"),
      holidayHours:
        securityLvFacts?.holidayHours ??
        valueFor(result.review.scope, "Feiertagsstunden"),
      staffingStrength: valueFor(result.review.scope, "Besetzungsstärke"),
      objectCount: valueFor(result.review.scope, "Objektanzahl"),
      unitCount: valueFor(result.review.scope, "Mengen"),
      kilometers: valueFor(result.review.scope, "Fahrtkilometer"),
      fteAnnualHours:
        valueFor(result.review.scope, "Produktive Jahresstunden je Vollzeitkraft") ??
        1600,
      siteManagement: valueFor(
        result.review.scope,
        "Objektleitungsanforderungen",
      ),
      operationsManagement: valueFor(
        result.review.scope,
        "Einsatzleitungsanforderungen",
      ),
      pricePositions:
        securityLvFacts?.positions ??
        valueFor(result.review.scope, "Preispositionen"),
    },
    provenance: {
      ...calculationInput.provenance,
      contractDuration: derivedDuration
        ? {
            source: "VERIFIED_PROCUREMENT_DOCUMENT",
            value: derivedDuration.value,
            unit: derivedDuration.unit,
            evidence: derivedDuration.evidence,
          }
        : null,
      productiveHours: explicitInputs.productive_hours
        ? {
            source: "EXPLICIT_SCOPED_USER_INPUT",
            inputId: explicitInputs.productive_hours.id,
            version: explicitInputs.productive_hours.version,
            unit: explicitInputs.productive_hours.unit,
            createdAt: explicitInputs.productive_hours.created_at,
            createdBy: explicitInputs.productive_hours.created_by,
          }
        : securityLvFacts?.provenance ??
          (
            Number.isFinite(derivedCleaningHours) &&
            derivedCleaningHours > 0
              ? {
                  source:
                    "AUTHORITATIVE_CLEANING_AREA_AND_COMPANY_PERFORMANCE",
                  formula:
                    "Jahresleistungsfläche ÷ gesellschaftsspezifischer Reinigungsleistungswert × Vertragsmonate ÷ 12",
                  annualCleaningArea,
                  cleaningPerformance,
                  cleaningPerformanceUnit:
                    cleaningPerformanceRow?.unit,
                  contractMonths:
                    cleaningContractMonths,
                  evidence:
                    derivedContractFacts.find(
                      fact =>
                        fact.key ===
                        "annual_cleaning_area_occurrences"
                    )?.evidence || [],
                  configuration: {
                    parameterKey: "C22",
                    versionId:
                      cleaningPerformanceRow?.version_id,
                    activatedAt:
                      cleaningPerformanceRow?.activated_at,
                    activatedBy:
                      cleaningPerformanceRow?.activated_by,
                    approvalSource:
                      cleaningPerformanceRow?.source
                  }
                }
              : calculationInput.provenance.productiveHours
          ),
      ...Object.fromEntries(
        securityCostRows.map((x) => [
          x.parameter_key,
          {
            source: "COMPANY_CONFIGURATION",
            versionId: x.version_id,
            activatedAt: x.activated_at,
            activatedBy: x.activated_by,
            unit: x.unit,
            approvalSource: x.source,
          },
        ]),
      ),
    },
  });
  if (engineResult.status !== "CALCULATED")
    for (const field of engineResult.missing || [])
      if (!validation.missing.some((item) => item.field === field))
        validation.missing.push({
          field,
          source: "Bekanntmachung und Vergabeunterlagen",
          lot: item.lot_key || "Gesamt",
          documentStatus: documents.length
            ? "TEILWEISE_ODER_BLOCKIERT"
            : "KEINE_DOKUMENTE",
          nextAction: `${field} quellengebunden extrahieren`,
        });
  const bidderHoursRequired = documents.some(
    (document) =>
      /Kalkulationsdatei.*\.xlsx$/i.test(document.filename || "") &&
      (document.extracted_data?.worksheets || []).some((sheet) =>
        (sheet.rows || []).some((row) =>
          (row.cells || []).some((cell) =>
            /tragen Sie die Reinigungsdauer in Stunden ein/i.test(
              String(cell.displayed ?? cell.value ?? ""),
            ),
          ),
        ),
      ),
  );
  for (const entry of validation.missing)
    if (entry.field === "Produktivstunden" && bidderHoursRequired) {
      entry.source = "Losbezogene Kalkulationsdatei des Auftraggebers";
      entry.documentStatus = "EVIDENCE_REQUIRED_BIDDER_INPUT";
      entry.nextAction =
        "Reinigungsdauer in den vom Auftraggeber vorgesehenen h/m/s-Bieterfeldern je Raumgruppe fachlich kalkulieren; die Unterlagen enthalten keine belastbare vorgegebene Produktivstundensumme.";
    }
  const blocked = validation.missing.length > 0,
    verifiedTenderDocuments = documents.filter(
      (document) =>
        document.document_type === "PORTAL_TENDER_DOCUMENT" &&
        document.procurement_verification_status === "VERIFIED",
    ).length,
    documentsUnavailable = verifiedTenderDocuments === 0,
    partial =
      blocked && !documentsUnavailable && engineResult.status === "CALCULATED",
    status = !blocked
      ? "CALCULATED_REAL"
      : partial
        ? "CALCULATION_PARTIAL"
        : documentsUnavailable
          ? "CALCULATION_BLOCKED_DOCUMENTS_NOT_AVAILABLE"
          : "CALCULATION_BLOCKED_MISSING_INPUT";
  const canonicalLot =
    (
      await pool.query(
        "SELECT id FROM tender.lots WHERE id=$1 AND tender_id=$2",
        [item.lot_id, tender.id],
      )
    ).rows[0] || null;
  let calculationRow = null;
  if (config) {
    const calculationClient = await pool.connect(),
      calculationLock = `calculation-version:${tender.id}:${item.company_id}:${item.lot_key || ""}`;
    try {
      await calculationClient.query("BEGIN");
      await calculationClient.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [calculationLock],
      );
      const version = Number(
        (
          await calculationClient.query(
            "SELECT coalesce(max(version),0)+1 v FROM tender.calculations WHERE tender_id=$1 AND company_id=$2 AND lot_key IS NOT DISTINCT FROM $3",
            [tender.id, item.company_id, item.lot_key],
          )
        ).rows[0].v,
      );
      calculationRow = (
        await calculationClient.query(
          `INSERT INTO tender.calculations(tender_id,lot_id,lot_key,company_id,version,service_line,scenario,config_id,status,blocked_reasons,totals)
      VALUES($1,$2,$3,$4,$5,$6,'BASE',$7,$8,$9::jsonb,$10::jsonb) RETURNING id`,
          [
            tender.id,
            canonicalLot?.id || null,
            item.lot_key,
            item.company_id,
            version,
            item.service_scope,
            config.id,
            status,
            json(validation.missing),
            json(
              partial
                ? {
                    ...engineResult,
                    status: "CALCULATION_PARTIAL",
                    missingPositions: validation.missing,
                  }
                : blocked
                  ? {}
                  : { ...engineResult, status: "CALCULATED_REAL" },
            ),
          ],
        )
      ).rows[0];
      await calculationClient.query("COMMIT");
    } catch (error) {
      await calculationClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await calculationClient.release();
    }
  }
  await pool.query(
    "UPDATE tender.autopilot_results SET stage_status=jsonb_set(stage_status,'{calculation}',to_jsonb($2::text),true) WHERE id=$1",
    [result.id, status],
  );
  const effectiveCalculation = partial
    ? {
        ...engineResult,
        status: "CALCULATION_PARTIAL",
        missing: validation.missing,
        verifiedTenderDocuments,
        externalTransmission: false,
      }
    : blocked
      ? {
          status,
          missing: validation.missing,
          verifiedTenderDocuments,
          externalTransmission: false,
        }
      : { ...engineResult, status: "CALCULATED_REAL" };
  return {
    status,
    missing: validation.missing,
    calculation: effectiveCalculation,
    calculationId: calculationRow?.id || null,
    calculationInputSnapshotId: inputRow.id,
    profileSnapshotId,
    documentStatus: documents.map((x) => ({
      filename: x.filename,
      status: x.fetch_status,
      source: x.source_url,
    })),
    resultVersion: result.result_version,
  };
}
async function persistManagementOutput(
  pool,
  { item, tender, enrichment, calculation },
) {
  const profileSnapshot = calculation.profileSnapshotId
    ? (
        await pool.query(
          "SELECT id,snapshot_sha256,source_manifest FROM tender.effective_profile_snapshots WHERE id=$1",
          [calculation.profileSnapshotId],
        )
      ).rows[0]
    : null;
  const documentRevision =
      enrichment.payload_sha256 || String(enrichment.version),
    output = buildManagementOutput({
      tender,
      lotKey: item.lot_key,
      company: { sector_slug: item.service_scope },
      profileSnapshot: profileSnapshot
        ? { id: profileSnapshot.id, revision: profileSnapshot.snapshot_sha256 }
        : null,
      documentRevision,
      calculation: calculation.calculation,
      missing: calculation.missing,
      jobId: item.id,
      correlationId: item.request_id,
    });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize the no-current-row case covered by the partial unique index.
    await client.query(
      "SELECT id FROM tender.tenders WHERE id=$1 FOR UPDATE",
      [tender.id],
    );
    const current = (
      await client.query(
        "SELECT id,output_sha256 FROM tender.management_outputs WHERE tender_id=$1 AND lot_key=$2 AND company_id=$3 AND scenario_key='REAL' AND historical=false FOR UPDATE",
        [tender.id, item.lot_key || "", item.company_id],
      )
    ).rows[0];
    if (current && current.output_sha256 === output.outputHash) {
      await client.query("COMMIT");
      return { id: current.id, ...output, idempotent: true };
    }
    if (current)
      await client.query(
        "UPDATE tender.management_outputs SET historical=true WHERE id=$1",
        [current.id],
      );
    const row = (
      await client.query(
        `INSERT INTO tender.management_outputs(tender_id,lot_key,company_id,scenario_key,profile_snapshot_id,calculation_id,document_revision,management_output_version,output_sha256,status,payload,job_id,correlation_id) VALUES($1,$2,$3,'REAL',$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING id`,
        [
          tender.id,
          item.lot_key || "",
          item.company_id,
          calculation.profileSnapshotId,
          calculation.calculationId,
          documentRevision,
          output.schemaVersion,
          output.outputHash,
          output.status,
          json(output),
          item.id,
          item.request_id,
        ],
      )
    ).rows[0];
    if (current)
      await client.query(
        "UPDATE tender.management_outputs SET superseded_by=$2 WHERE id=$1",
        [current.id, row.id],
      );
    await client.query("COMMIT");
    return { id: row.id, ...output, idempotent: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function ensureManagementApprovalRequest(
  pool,
  { item, tender, enrichment, calculation, managementOutput },
) {
  if (calculation.status !== "CALCULATED_REAL" || calculation.missing.length)
    return null;
  const documents = (
    await pool.query(
      `SELECT d.id,d.payload_sha256,coalesce(d.procurement_verification_status,d.resolution_status,d.fetch_status) status,d.document_class,d.procurement_relevant FROM tender.enrichment_documents d WHERE d.enrichment_version_id=$1 AND ($2='' OR d.lot_id IS NULL OR EXISTS(SELECT 1 FROM tender.enrichment_lots l WHERE l.id=d.lot_id AND l.lot_key=$2)) ORDER BY d.id`,
      [enrichment.id, item.lot_key || ""],
    )
  ).rows.filter(
    (d) =>
      d.procurement_relevant !== false &&
      d.document_class !== "GENERAL_PORTAL_DOCUMENT",
  );
  const verified =
    documents.some((d) => d.status === "VERIFIED") &&
    documents.every((d) =>
      [
        "VERIFIED",
        "TENDER_AND_LOT_VERIFIED",
        "TENDER_VERIFIED_LOT_GLOBAL",
        "LOT_ASSOCIATION_MISSING",
        "DOWNLOAD_SUCCEEDED",
        "PROCUREMENT_DOCUMENTS_VERIFIED",
      ].includes(d.status),
    );
  if (!verified) return null;
  const [portal, tenderVersion, management, actor] = await Promise.all([
    pool.query(
      `SELECT a.id portal_adapter_id FROM tender.enrichment_documents d JOIN tender.portal_registry p ON lower(split_part(split_part(d.source_url,'://',2),'/',1))=p.canonical_domain OR lower(split_part(split_part(d.source_url,'://',2),'/',1))=ANY(p.allowed_subdomains) JOIN tender.portal_adapters a ON a.portal_code=p.adapter_id WHERE d.enrichment_version_id=$1 AND d.procurement_verification_status='VERIFIED' ORDER BY d.retrieved_at DESC NULLS LAST,d.id LIMIT 1`,
      [enrichment.id],
    ),
    pool.query(
      "SELECT id FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC LIMIT 1",
      [tender.id],
    ),
    pool.query(
      "SELECT id,management_output_version FROM tender.management_outputs WHERE id=$1",
      [managementOutput.id],
    ),
    item.created_by
      ? pool.query("SELECT id FROM iam.users WHERE id=$1 AND active", [
          item.created_by,
        ])
      : pool.query(
          `SELECT u.id FROM iam.users u JOIN iam.user_roles ur ON ur.user_id=u.id JOIN iam.roles r ON r.id=ur.role_id WHERE u.active AND r.code IN ('board','administrator') ORDER BY CASE r.code WHEN 'board' THEN 0 ELSE 1 END,u.id LIMIT 1`,
        ),
  ]);
  const binding = approvalBinding({
    tenderId: tender.id,
    lotKey: item.lot_key || "GLOBAL",
    companyId: item.company_id,
    portalAdapterId: portal.rows[0]?.portal_adapter_id,
    tenderVersionId: tenderVersion.rows[0]?.id,
    documentVersion: manifestHash(
      documents.map((d) => ({
        id: d.id,
        sha256: d.payload_sha256,
        status: d.status,
      })),
    ),
    calculationId: calculation.calculationId,
    calculationVersion: (
      await pool.query("SELECT version FROM tender.calculations WHERE id=$1", [
        calculation.calculationId,
      ])
    ).rows[0]?.version,
    managementOutputId: management.rows[0]?.id,
    managementVersion: management.rows[0]?.management_output_version,
    offerVersion: 1,
    approverRole: "BOARD_OR_AUTHORIZED_EMPLOYEE",
  });
  const requestActor = actor.rows[0];
  if (binding.status !== "APPROVAL_BINDING_READY" || !requestActor) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = (
      await client.query(
        "SELECT id,status FROM tender.approval_requests WHERE tender_id=$1 AND company_id=$2 AND action_type='BID_SUBMISSION' AND payload_sha256=$3 LIMIT 1",
        [tender.id, item.company_id, binding.sha256],
      )
    ).rows[0];
    if (existing) {
      if (existing.status === "SUPERSEDED")
        await client.query(
          "UPDATE tender.approval_requests SET status='REQUESTED',expires_at=$2 WHERE id=$1",
          [existing.id, tender.offer_deadline],
        );
      await client.query("COMMIT");
      return {
        ...existing,
        status:
          existing.status === "SUPERSEDED" ? "REQUESTED" : existing.status,
      };
    }
    await client.query(
      "UPDATE tender.approval_requests SET status='SUPERSEDED' WHERE tender_id=$1 AND company_id=$2 AND action_type='BID_SUBMISSION' AND payload_manifest->>'lotKey'=$3 AND payload_manifest->>'companyId'=$4 AND status IN ('DRAFT','REQUESTED','APPROVED')",
      [
        tender.id,
        item.company_id,
        item.lot_key || "GLOBAL",
        String(item.company_id),
      ],
    );
    const expiresAt =
      tender.offer_deadline && new Date(tender.offer_deadline) > new Date()
        ? tender.offer_deadline
        : new Date(Date.now() + 72 * 60 * 60 * 1000);
    const payload = { ...binding.binding, externalExecution: false };
    const row = (
      await client.query(
        `INSERT INTO tender.approval_requests(tender_id,company_id,action_type,payload_sha256,payload_manifest,tender_version_id,calculation_id,status,requested_by,expires_at) VALUES($1,$2,'BID_SUBMISSION',$3,$4::jsonb,$5,$6,'REQUESTED',$7,$8) RETURNING id,status,tenant_id,company_id`,
        [
          tender.id,
          item.company_id,
          binding.sha256,
          json(payload),
          tenderVersion.rows[0].id,
          calculation.calculationId,
          requestActor.id,
          expiresAt,
        ],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO tender.approval_events(approval_request_id,actor_id,role_code,decision,reason,payload_sha256) VALUES($1,$2,'SYSTEM_WORKFLOW','REQUESTED','Automatisch aus aktueller realer Vollkalkulation und Managementausgabe vorgelegt.',$3)",
      [row.id, requestActor.id, binding.sha256],
    );
    await client.query(
      "INSERT INTO tender.audit_events(actor_id,action,tender_id,metadata) VALUES($1,'approval_request_materialized',$2,$3::jsonb)",
      [
        requestActor.id,
        tender.id,
        json({
          approvalRequestId: row.id,
          auditId: binding.binding.auditId,
          lotKey: item.lot_key || "",
          companyId: item.company_id,
          payloadSha256: binding.sha256,
          externalWrite: false,
        }),
      ],
    );
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
const step = (pool, id, current, progress, counts = {}) =>
  pool.query(
    `UPDATE tender.autopilot_queue SET current_step=$2,progress_percent=$3,heartbeat_at=now(),last_progress_at=now(),total_items=COALESCE($4,total_items),successful_items=COALESCE($5,successful_items),skipped_items=COALESCE($6,skipped_items),failed_items=COALESCE($7,failed_items) WHERE id=$1`,
    [
      id,
      current,
      progress,
      counts.total ?? null,
      counts.successful ?? null,
      counts.skipped ?? null,
      counts.failed ?? null,
    ],
  );
async function processAction(pool, item, tender, run) {
  const action = item.action_type || "REFRESH_ENRICHMENT";
  if (action === "RUN_FULL_PIPELINE")
    await pool.query("SELECT set_config('tender.pipeline_job_id',$1,false)", [
      String(item.id),
    ]);
  if (["RESOLVE_TARGET_PORTAL", "VALIDATE_PORTAL_ADAPTER"].includes(action)) {
    await step(pool, item.id, action, 50);
    const portal = (
      await pool.query("SELECT * FROM tender.portal_registry WHERE id=$1", [
        item.portal_id,
      ])
    ).rows[0];
    if (!portal)
      throw Object.assign(Error("portal context missing"), {
        code: "FEHLENDER_PORTALKONTEXT",
      });
    if (!portal.adapter_enabled || !portal.adapter_id)
      throw Object.assign(Error("validated adapter required"), {
        code: "UNKNOWN_PORTAL_ADAPTER_REQUIRED",
      });
    if (action === "RESOLVE_TARGET_PORTAL")
      return {
        portalId: portal.id,
        adapterId: portal.adapter_id,
        adapterVersion: portal.adapter_version,
        targetPortal: portal.canonical_domain,
      };
    const validation =
      portal.adapter_validation_status || "ADAPTER_REPAIR_REQUIRED";
    await pool.query(
      "INSERT INTO tender.portal_adapter_validations(portal_id,adapter_id,adapter_version,validation_status,checks,safe_diagnostic,external_write) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,false)",
      [
        portal.id,
        portal.adapter_id,
        portal.adapter_version,
        validation,
        json({
          domainRecognized: true,
          redirectPolicyConfigured:
            (portal.authentication_domains || []).length > 0 ||
            portal.canonical_domain,
          credentialConfigured: Boolean(item.credential_id),
          externalWrite: false,
        }),
        json({ result: validation }),
      ],
    );
    return {
      portalId: portal.id,
      adapterId: portal.adapter_id,
      adapterVersion: portal.adapter_version,
      validationStatus: validation,
    };
  }
  if (
    [
      "START_PORTAL_AUTHENTICATION",
      "TEST_PORTAL_CONNECTION",
      "TEST_DOCUMENT_FETCH",
    ].includes(action)
  ) {
    await step(pool, item.id, "PORTAL_KONTEXT_PRUEFEN", 20);
    const portal = (
      await pool.query(
        "SELECT p.*,s.id session_id,s.status session_status,s.expires_at,s.ciphertext,s.iv,s.auth_tag,s.key_version,s.session_effective_status FROM tender.portal_registry p LEFT JOIN LATERAL(SELECT *,tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status) session_effective_status FROM tender.portal_read_sessions WHERE portal_id=p.id AND company_id=$2 AND credential_id=$3 ORDER BY created_at DESC LIMIT 1)s ON true WHERE p.id=$1",
        [item.portal_id, item.company_id, item.credential_id],
      )
    ).rows[0];
    if (!portal)
      throw Object.assign(Error("portal context missing"), {
        code: "FEHLENDER_PORTALKONTEXT",
      });
    const eligibility = credentialPortalEligibility(portal);
    if (!eligibility.eligible)
      throw Object.assign(Error("portal is not eligible for credential jobs"), {
        code: eligibility.code,
      });
    if (String(item.adapter_id || "") !== String(portal.adapter_id || ""))
      throw Object.assign(
        Error("job adapter does not match exact portal binding"),
        { code: "KEIN_ADAPTER_VERFUEGBAR" },
      );
    const credential = (
      await pool.query(
        `SELECT c.* FROM tender.portal_credential_secrets c JOIN tender.portal_credential_companies cc ON cc.credential_id=c.id WHERE c.id=$3 AND c.portal_id=$1 AND c.status='ACTIVE' AND c.revoked_at IS NULL AND (c.valid_until IS NULL OR c.valid_until>now()) AND cc.company_id=$2 AND cc.active=true`,
        [item.portal_id, item.company_id, item.credential_id],
      )
    ).rows[0];
    if (!credential)
      throw Object.assign(Error("portal access not configured for company"), {
        code: "REGISTERED_PORTAL_SCOPE_NOT_FOUND",
      });
    const jobEligibility = credentialJobEligibility(portal, credential, action);
    if (!jobEligibility.eligible)
      throw Object.assign(
        Error("credential capability is not authorized for this exact host"),
        { code: jobEligibility.code },
      );
    const continuationTarget = (
      await pool.query(
        "SELECT portal_tender_url,lot_key FROM tender.portal_login_continuations WHERE login_job_id=$1 AND portal_id=$2 AND credential_id=$3 AND company_id=$4 ORDER BY created_at DESC LIMIT 1",
        [item.id, portal.id, credential.id, item.company_id],
      )
    ).rows[0];
    await step(pool, item.id, "SICHERE_LESESESSION_AUFBAUEN", 40);
    const targetUrl =
        continuationTarget?.portal_tender_url ||
        (portal.document_path
          ? new URL(portal.document_path, `https://${portal.canonical_domain}`)
              .href
          : `https://${portal.canonical_domain}/`),
      tested = await restoreOrLoginPortalSession(
        pool,
        portal,
        credential,
        item.company_id,
        targetUrl,
        action === "TEST_DOCUMENT_FETCH",
        {
          tenderId: tender.id,
          lotKey: continuationTarget?.lot_key ?? item.lot_key ?? null,
        },
      );
    if (tested.resultCode !== "LOGIN_ERFOLGREICH") {
      await pool.query(
        "UPDATE tender.portal_registry SET last_error_code=$2,updated_at=now() WHERE id=$1",
        [portal.id, tested.resultCode || "TECHNISCHER_CONNECTORFEHLER"],
      );
      throw Object.assign(Error("portal read test failed"), {
        code: tested.resultCode || "TECHNISCHER_CONNECTORFEHLER",
      });
    }
    if (action === "TEST_DOCUMENT_FETCH") {
      await step(pool, item.id, "DOKUMENTENLISTE_ERMITTELN", 55);
      const notice = await loadNotice(pool, tender),
        enrichment = await persistEnrichment(pool, run.id, tender, notice);
      let selected = await relevancePlan(pool, tender, enrichment);
      selected = selected.filter(
        (candidate) =>
          String(candidate.company.company_id) === String(item.company_id) &&
          (item.lot_key == null ||
            (candidate.lotKey ?? null) === (item.lot_key ?? null)),
      );
      if (!selected.length)
        throw Object.assign(
          Error("company and lot context no longer eligible"),
          { code: "NOT_ELIGIBLE" },
        );
      const portalAssignments = await materializeAuthoritativePortalAssignments(pool, {
        tenderId: tender.id,
        selected,
      });
      const exactDocumentAssignments = (await pool.query(
        `SELECT 1 FROM tender.current_tender_company_portal_role_scopes scope
         WHERE scope.tender_id=$1 AND scope.company_id=$2 AND scope.source_lot_id=$3
           AND scope.portal_id=$4 AND scope.portal_role='DOCUMENT_PORTAL'
           AND ($5::text IS NULL OR scope.canonical_service=$5) LIMIT 2`,
        [tender.id, item.company_id, item.lot_key, item.portal_id, item.service_scope],
      )).rows;
      if (exactDocumentAssignments.length !== 1)
        throw Object.assign(new Error("authoritative portal assignment requires review"), {
          code: "PORTAL_ASSIGNMENT_REVIEW_REQUIRED",
        });
      await step(pool, item.id, "DOWNLOAD_RUNNING", 70);
      await processDocuments(pool, enrichment, selected);
      await materializeDocumentContract(pool, enrichment.id, selected);
    }
    const docs =
      action === "TEST_DOCUMENT_FETCH"
        ? (
            await pool.query(
              `SELECT count(*) FILTER(WHERE d.document_type='PORTAL_TENDER_DOCUMENT')::int total,count(*) FILTER(WHERE d.document_type='PORTAL_TENDER_DOCUMENT' AND d.content IS NOT NULL AND d.payload_sha256 IS NOT NULL)::int downloaded,count(*) FILTER(WHERE d.document_type='PORTAL_TENDER_DOCUMENT' AND d.procurement_verification_status='VERIFIED')::int verified,bool_or(coalesce(d.resolution_status,d.fetch_status)='EXTERNAL_DOCUMENT_REQUEST_REQUIRED') external_request_required FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id WHERE e.tender_id=$1 AND ($4::text IS NULL OR d.lot_id IS NULL OR EXISTS(SELECT 1 FROM tender.enrichment_lots lot WHERE lot.id=d.lot_id AND lot.enrichment_version_id=d.enrichment_version_id AND lot.lot_key=$4)) AND (lower(split_part(split_part(d.source_url,'://',2),'/',1))=ANY($2::text[]) OR d.provenance->>'portalId'=$3)`,
              [
                tender.id,
                [
                  portal.canonical_domain,
                  ...(portal.allowed_subdomains || []),
                  ...(portal.authentication_domains || []),
                  ...(portal.download_domains || []),
                ],
                String(portal.id),
                item.lot_key,
              ],
            )
          ).rows[0]
        : { total: 0, downloaded: 0, verified: 0 };
    const truth = truthfulDocumentTest({
      found: docs.total,
      downloaded: docs.downloaded,
      verified: docs.verified,
      reason: docs.external_request_required
        ? "EXTERNAL_DOCUMENT_REQUEST_REQUIRED"
        : null,
    });
    const externalState =
      action === "TEST_DOCUMENT_FETCH" && !truth.succeeded
        ? (
            await pool.query(
              `SELECT coalesce(d.resolution_status,d.fetch_status) status FROM tender.enrichment_documents d JOIN tender.enrichment_versions e ON e.id=d.enrichment_version_id WHERE e.tender_id=$1 AND (d.provenance->>'portalId'=$2 OR d.provenance->>'targetPortal'=ANY($3::text[])) ORDER BY d.retrieved_at DESC NULLS LAST LIMIT 1`,
              [
                tender.id,
                String(portal.id),
                [portal.canonical_domain, ...(portal.allowed_subdomains || [])],
              ],
            )
          ).rows[0]?.status
        : null;
    const externalResult =
      externalState === "DOCUMENT_NOT_AVAILABLE"
        ? "DOCUMENT_NOT_FOUND"
        : externalState === "EXTERNAL_DOCUMENT_REQUEST_REQUIRED"
          ? externalState
          : null;
    if (action === "TEST_DOCUMENT_FETCH" && !truth.succeeded && !externalResult)
      throw Object.assign(
        Error("document fetch test did not verify a real file"),
        { code: truth.resultCode },
      );
    const statusClient = await pool.connect();
    try {
      await statusClient.query("BEGIN");
      await statusClient.query(
        "SELECT id FROM tender.portal_registry WHERE id=$1 FOR UPDATE",
        [portal.id],
      );
      const currentCredential = (
        await statusClient.query(
          "SELECT credential.id FROM tender.portal_credential_secrets credential JOIN tender.portal_credential_companies scope ON scope.credential_id=credential.id AND scope.company_id=$3 AND scope.active WHERE credential.id=$2 AND credential.portal_id=$1 AND credential.status='ACTIVE' AND credential.revoked_at IS NULL FOR UPDATE OF credential",
          [portal.id, credential.id, item.company_id],
        )
      ).rows[0];
      if (!currentCredential)
        throw Object.assign(
          Error("credential version superseded before status persistence"),
          { code: "CREDENTIAL_VERSION_SUPERSEDED" },
        );
      await statusClient.query(
        "UPDATE tender.portal_registry SET last_successful_login_at=now(),last_successful_document_fetch_at=CASE WHEN $2 THEN now() ELSE last_successful_document_fetch_at END,last_error_code=NULL,updated_at=now() WHERE id=$1",
        [portal.id, action === "TEST_DOCUMENT_FETCH" && truth.succeeded],
      );
      await statusClient.query("COMMIT");
    } catch (error) {
      await statusClient.query("ROLLBACK");
      throw error;
    } finally {
      statusClient.release();
    }
    await pool.query(
      "UPDATE tender.autopilot_queue SET adapter_id=$2,adapter_version=$3,result_counts=$4::jsonb,total_items=$5,successful_items=$6,skipped_items=0,failed_items=$7,documents_found=$5,documents_downloaded=$8,documents_analyzed=$6 WHERE id=$1",
      [
        item.id,
        portal.adapter_id,
        portal.adapter_version,
        json({
          found: docs.total,
          downloaded: docs.downloaded,
          verified: docs.verified,
          analyzed: docs.verified,
        }),
        docs.total,
        docs.verified,
        Math.max(0, docs.total - docs.verified),
        docs.downloaded,
      ],
    );
    if (action === "TEST_DOCUMENT_FETCH")
      await pool.query(
        `INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,notice_id,lot_key,company_id,service_scope,portal_id,credential_id,enrichment_version_id,assessment_version_id,idempotency_key,reason,status,current_step,calculation_status,next_step)
      SELECT gen_random_uuid(),'RUN_FULL_PIPELINE',r.tender_id,v.id,coalesce(t.notice_number,t.external_id),r.lot_key,r.company_id,r.service_line,registered.portal_id,registered.credential_id,e.id,r.evaluation_version,concat('PORTAL_LOGIN_CONTINUATION:',r.tender_id,':',coalesce(r.lot_key,''),':',r.company_id,':',e.id),'PORTAL_LOGIN_AUTOMATIC_CONTINUATION','QUEUED','DOCUMENT_FETCH_QUEUED','CALCULATION_QUEUED','FETCH_DOCUMENTS'
      FROM tender.current_service_relevance r JOIN tender.tenders t ON t.id=r.tender_id JOIN tender.current_registered_tender_company_portals registered ON registered.tender_id=r.tender_id AND registered.company_id=r.company_id JOIN LATERAL(SELECT id FROM tender.tender_versions WHERE tender_id=r.tender_id ORDER BY version DESC LIMIT 1)v ON true JOIN LATERAL(SELECT id FROM tender.enrichment_versions WHERE tender_id=r.tender_id ORDER BY version DESC LIMIT 1)e ON true
      WHERE r.tender_id=$1 AND r.company_id=$2 AND ($3::text IS NULL OR r.lot_key=$3) AND r.relevance_status='RELEVANT' AND r.service_scope_gate='PASSED' AND r.primary_company=true
      ON CONFLICT DO NOTHING`,
        [tender.id, item.company_id, item.lot_key],
      );
    return {
      connectionFunctional: true,
      documentFetchPossible:
        action === "TEST_DOCUMENT_FETCH" && truth.succeeded,
      resultCode:
        action === "TEST_DOCUMENT_FETCH"
          ? externalResult || truth.resultCode
          : "LOGIN_SUCCEEDED",
      foundDocuments: docs.total,
      downloadedDocuments: docs.downloaded,
      successfulDocuments: docs.verified,
      lastLoginAt: new Date().toISOString(),
      lastFetchAt:
        action === "TEST_DOCUMENT_FETCH" && truth.succeeded
          ? new Date().toISOString()
          : portal.last_successful_document_fetch_at,
      automaticContinuation:
        action === "START_PORTAL_AUTHENTICATION"
          ? "VERIFIED_SESSION_FANOUT"
          : action === "TEST_DOCUMENT_FETCH",
    };
  }
  if (
    [
      "EXPORT_REVIEW_REPORT",
      "EXPORT_BOARD_BRIEF",
      "GENERATE_BOARD_REPORT",
    ].includes(action)
  ) {
    await step(pool, item.id, "EXPORT_VORBEREITEN", 70);
    const row = (
      await pool.query(
        "SELECT result_version FROM tender.autopilot_results WHERE tender_id=$1 AND company_id=$2 ORDER BY result_version DESC LIMIT 1",
        [tender.id, item.company_id],
      )
    ).rows[0];
    if (!row)
      throw Object.assign(Error("export source missing"), {
        code: "EXPORT_FEHLGESCHLAGEN",
      });
    return {
      downloadUrl: `/api/tender/management-inbox/autopilot/${tender.id}/${action === "EXPORT_REVIEW_REPORT" ? "review-report" : "board-brief"}?company=${item.company_id}`,
      resultVersion: row.result_version,
    };
  }
  await step(
    pool,
    item.id,
    action === "RUN_FULL_PIPELINE" ? "FETCH_DOCUMENTS" : "AUSSCHREIBUNG_LADEN",
    10,
  );
  const result = await loadNotice(pool, tender);
  await step(pool, item.id, "REFRESH_ENRICHMENT", 30);
  const enrichment = await persistEnrichment(pool, run.id, tender, result);
  const noticeType = classifyNoticeType({
    structuredData: enrichment.structured_data,
    parserPath: enrichment.parser_path,
    rawNotice: result.parsed,
  });
  await pool.query(
    "UPDATE tender.enrichment_versions SET notice_type=$2,historical=($2='AWARD_NOTICE') WHERE id=$1",
    [enrichment.id, noticeType],
  );
  if (noticeType === "AWARD_NOTICE") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE tender.autopilot_results SET historical=true,read_model_status=CASE WHEN read_model_status='CURRENT' THEN 'HISTORICAL' ELSE read_model_status END WHERE tender_id=$1",
        [tender.id],
      );
      await client.query(
        "UPDATE tender.canonical_read_snapshots SET status='SUPERSEDED',superseded_at=coalesce(superseded_at,now()) WHERE tender_id=$1 AND status='CURRENT'",
        [tender.id],
      );
      await client.query(
        "UPDATE tender.management_outputs SET historical=true WHERE tender_id=$1 AND historical=false",
        [tender.id],
      );
      await client.query(
        "INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES('award_notice_removed_from_active_pipeline',$1,$2::jsonb)",
        [
          tender.id,
          json({
            enrichmentVersion: enrichment.version,
            noticeType,
            historyRetained: true,
            externalWrite: false,
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return {
      enrichmentVersion: enrichment.version,
      noticeType,
      historical: true,
      calculationStarted: false,
      managementOutputGenerated: false,
      marketAnalysisRetained: true,
    };
  }
  await step(pool, item.id, "KONTEXT_UND_LOSE_PRUEFEN", 40);
  const contextActions=[
      "RUN_FULL_PIPELINE",
      "FETCH_DOCUMENTS",
      "ANALYZE_DOCUMENTS",
      "REFRESH_ENRICHMENT",
    "REFRESH_REVIEW",
  ];
  let selected = await relevancePlan(pool, tender, enrichment, {
    suppressPipelineEnqueue: contextActions.includes(action),
    pipelineJobId: item.id,
  });
  if(contextActions.includes(action))selected=await authoritativeQueuedSelection(pool,tender,enrichment,item,selected);
  if(contextActions.includes(action)&&!selected.length)throw Object.assign(Error("company and lot context no longer eligible"),{code:"NOT_ELIGIBLE"});
  if (
    contextActions.includes(action) &&
    selected.length
  ) {
    const portalAssignments = await materializeAuthoritativePortalAssignments(pool, {
      tenderId: tender.id,
      selected,
    });
    const exactDocumentAssignments = (await pool.query(
      `SELECT 1 FROM tender.current_tender_company_portal_role_scopes scope
       WHERE scope.tender_id=$1 AND scope.company_id=$2 AND scope.source_lot_id=$3
         AND scope.portal_id=$4 AND scope.portal_role='DOCUMENT_PORTAL'
         AND ($5::text IS NULL OR scope.canonical_service=$5) LIMIT 2`,
      [tender.id, item.company_id, item.lot_key, item.portal_id, item.service_scope],
    )).rows;
    if (exactDocumentAssignments.length !== 1)
      throw Object.assign(new Error("authoritative portal assignment requires review"), {
        code: "PORTAL_ASSIGNMENT_REVIEW_REQUIRED",
      });
    await step(pool, item.id, "FETCH_DOCUMENTS", 50);
    await processDocuments(pool, enrichment, selected);
    await materializeDocumentContract(pool, enrichment.id, selected);
    const ds=await canonicalProcurementDocumentCounts(pool,enrichment.id,item.lot_key);
    const resolution =
        Number(ds.downloaded) > 0
          ? "PROCUREMENT_DOCUMENTS_VERIFIED"
          : ds.access,
      verifiedSession =
        item.portal_id && item.credential_id
          ? (
              await pool.query(
                "SELECT id FROM tender.portal_read_sessions WHERE portal_id=$1 AND credential_id=$2 AND company_id=$3 AND tender.portal_session_effective_status(status,expires_at,revoked_at,verification_status)='ACTIVE' ORDER BY last_verified_at DESC LIMIT 1",
                [item.portal_id, item.credential_id, item.company_id],
              )
            ).rows[0]
          : null,
      portalAccess = verifiedSession
        ? "LOGIN_SUCCEEDED"
        : ds.access || "SESSION_EXPIRED";
    await pool.query(
      "UPDATE tender.autopilot_queue SET document_portal=$2,portal_access_status=$3,document_resolution_status=$4,documents_found=$5::int,documents_downloaded=$6::int,documents_analyzed=$7::int,total_items=$5::int,successful_items=CASE WHEN $9='ANALYZE_DOCUMENTS' THEN $7::int ELSE $6::int END,failed_items=greatest(0,$5::int-CASE WHEN $9='ANALYZE_DOCUMENTS' THEN $7::int ELSE $6::int END),result_counts=$8::jsonb,error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL,blocking_reason=NULL WHERE id=$1",
      [
        item.id,
        ds.portal,
        portalAccess,
        resolution,
        ds.found,
        ds.downloaded,
        ds.analyzed,
        json({
          found: ds.found,
          downloaded: ds.downloaded,
          analyzed: ds.analyzed,
          sessionVerified: Boolean(verifiedSession),
        }),
        action,
      ],
    );
    await recordLivePortalEvidence(pool, {
      item,
      enrichmentId: enrichment.id,
      portalDomain: ds.portal,
      verified: ds.downloaded,
      sessionVerified: Boolean(verifiedSession),
    });
    if (action === "FETCH_DOCUMENTS" && !Number(ds.downloaded)) {
      const code =
        ds.access === "PORTAL_ACCESS_REQUIRED" ||
        ds.access === "LOGIN_ERFORDERLICH"
          ? "SESSION_NICHT_FUER_DOWNLOAD_GUELTIG"
          : ds.found
            ? "PROCUREMENT_DOCUMENTS_NOT_VERIFIED"
            : "DOKUMENTENLISTE_NICHT_ERMITTELT";
      throw Object.assign(
        Error("document fetch produced no verified procurement file"),
        { code },
      );
    }
    if (action === "ANALYZE_DOCUMENTS" && !Number(ds.analyzed)) {
      const code = ds.found
        ? "DOKUMENTENANALYSE_FEHLGESCHLAGEN"
        : "DOKUMENTENLISTE_NICHT_ERMITTELT";
      throw Object.assign(
        Error("document analysis produced no analyzed file"),
        { code },
      );
    }
  }
  if (
    [
      "RUN_FULL_PIPELINE",
      "FETCH_DOCUMENTS",
      "ANALYZE_DOCUMENTS",
      "REFRESH_ENRICHMENT",
      "REFRESH_REVIEW",
    ].includes(action) &&
    selected.length
  )
    await refreshCanonicalDocumentCounts(pool, item.id, enrichment.id);
  if (
    [
      "RUN_FULL_PIPELINE",
      "FETCH_DOCUMENTS",
      "ANALYZE_DOCUMENTS",
      "REFRESH_ENRICHMENT",
      "REFRESH_REVIEW",
    ].includes(action) &&
    selected.length
  )
    await recordResolvedPortalEvidence(pool, item, enrichment.id);
  if (
    [
      "RUN_FULL_PIPELINE",
      "ANALYZE_DOCUMENTS",
      "REFRESH_REVIEW",
      "REFRESH_ENRICHMENT",
      "GENERATE_RECOMMENDATION",
    ].includes(action) &&
    selected.length
  ) {
    await step(pool, item.id, "ANALYZE_DOCUMENTS", 65);
    await reviewSelected(pool, tender, enrichment, selected);
  }
  if (action === "RUN_FULL_PIPELINE") {
    if (!selected.length)
      throw Object.assign(
        Error("eligible company/lot context no longer current"),
        { code: "NOT_ELIGIBLE" },
      );
    await step(pool, item.id, "VALIDATE_CALCULATION_INPUTS", 78);
    const calculation = await persistCalculation(
      pool,
      item,
      tender,
      enrichment,
    );
    const portalState = (
        await pool.query(
          "SELECT document_portal,portal_access_status FROM tender.autopilot_queue WHERE id=$1",
          [item.id],
        )
      ).rows[0],
      portalReason =
        portalState?.portal_access_status &&
        portalState.portal_access_status !== "VORHANDEN"
          ? `Dokumentenportal ${portalState.document_portal || "unbekannt"}: ${portalState.portal_access_status}. `
          : "";
    await pool.query(
      "UPDATE tender.autopilot_queue SET calculation_status=$2,blocking_reason=$3,missing_calculation_inputs=$4::jsonb,last_successful_step='VALIDATE_CALCULATION_INPUTS',next_step=$5 WHERE id=$1",
      [
        item.id,
        calculation.status,
        calculation.status === "CALCULATION_PARTIAL"
          ? `${portalReason}Teilkalkulation erstellt; offene Einzelpositionen: ${calculation.missing.map((x) => x.field).join(", ")}.`
          : calculation.missing.length
            ? `${portalReason}Kalkulation blockiert. Es fehlen ${calculation.missing.map((x) => x.field).join(", ")} für ${item.lot_key || "Gesamt"}.`
            : null,
        json(calculation.missing),
        calculation.status === "CALCULATION_PARTIAL"
          ? "MANAGEMENT_OUTPUT_QUEUED"
          : calculation.missing.length
            ? "FEHLENDE_DATEN_ERGÄNZEN"
            : "START_CALCULATION",
      ],
    );
    if (
      !calculation.missing.length ||
      calculation.status === "CALCULATION_PARTIAL"
    ) {
      await step(pool, item.id, "CALCULATING", 88);
      await pool.query(
        "UPDATE tender.autopilot_queue SET last_successful_step=$2,next_step='MANAGEMENT_OUTPUT_QUEUED',calculation_status=$3 WHERE id=$1",
        [
          item.id,
          calculation.status === "CALCULATION_PARTIAL"
            ? "CALCULATION_PARTIAL"
            : "CALCULATED_REAL",
          calculation.status,
        ],
      );
    }
    await step(pool, item.id, "MANAGEMENT_OUTPUT_QUEUED", 94);
    const managementOutput = await persistManagementOutput(pool, {
      item,
      tender,
      enrichment,
      calculation,
    });
    await ensureManagementApprovalRequest(pool, {
      item,
      tender,
      enrichment,
      calculation,
      managementOutput,
    });
    await ensureProcedureMonitoring(pool, item, tender);
    await step(pool, item.id, "MANAGEMENT_OUTPUT_GENERATED", 98);
    await pool.query(
      `UPDATE tender.autopilot_queue SET last_successful_step='GENERATE_RECOMMENDATION',next_step=CASE
      WHEN portal_access_status='MFA_BESTÄTIGUNG_ERFORDERLICH' THEN 'MFA_READ_ONLY_SESSION_BESTÄTIGEN'
      WHEN portal_access_status='PORTALZUGANG_NICHT_KONFIGURIERT' THEN 'PORTALZUGANG_KONFIGURIEREN'
      WHEN portal_access_status IN('PORTALSESSION_ABGELAUFEN','REAUTH_REQUIRED') THEN 'READ_ONLY_SESSION_ERNEUERN'
      WHEN portal_access_status IN('LOGIN_ERFORDERLICH','MFA_REQUIRED','CAPTCHA_REQUIRED') THEN 'PORTAL_LOGIN_PRÜFEN'
      WHEN calculation_status='CALCULATION_BLOCKED_MISSING_INPUT' THEN 'FEHLENDE_DATEN_ERGÄNZEN'
      ELSE NULL END WHERE id=$1`,
      [item.id],
    );
    return {
      enrichmentVersion: enrichment.version,
      selectedCompanies: selected.length,
      actionType: action,
      calculation,
      managementOutput: {
        id: managementOutput.id,
        status: managementOutput.status,
        outputHash: managementOutput.outputHash,
      },
    };
  }
  if (["START_CALCULATION", "VALIDATE_CALCULATION_INPUTS"].includes(action)) {
    selected = selected.filter(
      (x) =>
        String(x.company.company_id) === String(item.company_id) &&
        (x.lotKey ?? null) === (item.lot_key ?? null),
    );
    if (!selected.length)
      throw Object.assign(
        Error("eligible company/lot context no longer current"),
        { code: "NOT_ELIGIBLE" },
      );
    await step(pool, item.id, "REFRESH_REVIEW", 65);
    await reviewSelected(pool, tender, enrichment, selected);
    await step(pool, item.id, "VALIDATE_CALCULATION_INPUTS", 78);
    const calculation = await persistCalculation(
      pool,
      item,
      tender,
      enrichment,
    );
    await pool.query(
      "UPDATE tender.autopilot_queue SET calculation_status=$2,blocking_reason=$3,missing_calculation_inputs=$4::jsonb,last_successful_step='VALIDATE_CALCULATION_INPUTS',next_step=$5 WHERE id=$1",
      [
        item.id,
        calculation.status,
        calculation.missing.length
          ? `Kalkulation blockiert. Es fehlen ${calculation.missing.map((x) => x.field).join(", ")} für ${item.lot_key || "Gesamt"}.`
          : null,
        json(calculation.missing),
        calculation.missing.length ? "FEHLENDE_DATEN_ERGÄNZEN" : null,
      ],
    );
    if (
      !calculation.missing.length ||
      calculation.status === "CALCULATION_PARTIAL"
    ) {
      await step(pool, item.id, "CALCULATING", 90);
      await pool.query(
        "UPDATE tender.autopilot_queue SET calculation_status=$2 WHERE id=$1",
        [item.id, calculation.status],
      );
    }
    await step(pool, item.id, "MANAGEMENT_OUTPUT_QUEUED", 95);
    const managementOutput = await persistManagementOutput(pool, {
      item,
      tender,
      enrichment,
      calculation,
    });
    await ensureManagementApprovalRequest(pool, {
      item,
      tender,
      enrichment,
      calculation,
      managementOutput,
    });
    return {
      enrichmentVersion: enrichment.version,
      selectedCompanies: selected.length,
      actionType: action,
      calculation,
      managementOutput: {
        id: managementOutput.id,
        status: managementOutput.status,
        outputHash: managementOutput.outputHash,
      },
    };
  }
  return {
    enrichmentVersion: enrichment.version,
    selectedCompanies: selected.length,
    actionType: action,
  };
}
async function refreshPipelineContext(pool, item) {
  if (!item.company_id) return;
  const state = (
    await pool.query(
      `SELECT q.*,r.id result_id,r.stage_status,r.review,r.board_brief,r.source_manifest,
    (SELECT id FROM tender.calculation_input_snapshots c WHERE c.tender_id=q.tender_id AND c.company_id=q.company_id AND c.lot_key=coalesce(q.lot_key,'') ORDER BY c.created_at DESC LIMIT 1) calculation_input_snapshot_id,
    (SELECT id FROM tender.management_outputs m WHERE m.tender_id=q.tender_id AND m.company_id=q.company_id AND m.lot_key=coalesce(q.lot_key,'') AND m.historical=false ORDER BY m.created_at DESC LIMIT 1) management_output_id
    FROM tender.autopilot_queue q LEFT JOIN LATERAL(SELECT * FROM tender.autopilot_results x WHERE x.tender_id=q.tender_id AND x.company_id=q.company_id AND x.lot_key IS NOT DISTINCT FROM q.lot_key ORDER BY x.result_version DESC LIMIT 1)r ON true WHERE q.id=$1`,
      [item.id],
    )
  ).rows[0];
  if (!state) return;
  const completed = ["SOURCE_RESOLVED"];
  if (state.document_portal) completed.push("TARGET_PORTAL_RESOLVED");
  if (state.portal_access_status === "LOGIN_SUCCEEDED")
    completed.push("AUTHENTICATED");
  if (Number(state.documents_found) > 0)
    completed.push("DOCUMENT_LIST_RESOLVED");
  if (Number(state.documents_downloaded) > 0)
    completed.push("PROCUREMENT_DOCUMENTS_VERIFIED");
  if (Number(state.documents_analyzed) > 0)
    completed.push("DOCUMENTS_ANALYZED");
  if (state.result_id) completed.push("ENRICHMENT_MATERIALIZED");
  if (state.source_manifest?.profileSnapshotId)
    completed.push("EFFECTIVE_PROFILE_RESOLVED");
  if (
    state.review?.capacity?.status &&
    !/erforderlich|fehl/i.test(state.review.capacity.status)
  )
    completed.push("CAPACITY_EVALUATED");
  if (state.calculation_input_snapshot_id)
    completed.push("INPUT_COMPLETENESS_CHECKED");
  if (state.calculation_status) completed.push("CALCULATION_QUEUED");
  if (
    [
      "CALCULATION_COMPLETED",
      "CALCULATED_REAL",
      "CALCULATION_PARTIAL",
    ].includes(state.calculation_status)
  )
    completed.push("CALCULATION_COMPLETED");
  if (state.management_output_id) completed.push("MANAGEMENT_OUTPUT_GENERATED");
  if (state.board_brief && Object.keys(state.board_brief).length)
    completed.push("BOARD_BRIEF_GENERATED");
  let blockingState = null;
  if (!completed.includes("TARGET_PORTAL_RESOLVED"))
    blockingState = "UNKNOWN_PORTAL_ADAPTER_REQUIRED";
  else if (!completed.includes("DOCUMENT_LIST_RESOLVED"))
    blockingState = "DOCUMENT_LIST_NOT_RESOLVED";
  else if (!completed.includes("PROCUREMENT_DOCUMENTS_VERIFIED"))
    blockingState = "PROCUREMENT_DOCUMENTS_NOT_VERIFIED";
  else if (!completed.includes("DOCUMENTS_ANALYZED"))
    blockingState = "DOCUMENT_ANALYSIS_FAILED";
  else if (!completed.includes("EFFECTIVE_PROFILE_RESOLVED"))
    blockingState = "EFFECTIVE_PROFILE_MISSING";
  else if (
    !completed.includes("INPUT_COMPLETENESS_CHECKED") ||
    state.calculation_status === "CALCULATION_BLOCKED_MISSING_INPUT"
  )
    blockingState = "CALCULATION_INPUT_MISSING";
  const transition = nextPipelineTransition({
      completedSteps: completed,
      blockingState,
    }),
    currentStep = completed.at(-1),
    prior = (
      await pool.query(
        "SELECT * FROM tender.pipeline_contexts WHERE tender_id=$1 AND lot_key=$2 AND company_id=$3 AND pipeline_version=$4",
        [
          state.tender_id,
          state.lot_key || "",
          state.company_id,
          PIPELINE_SCHEMA_VERSION,
        ],
      )
    ).rows[0];
  const context = (
    await pool.query(
      `INSERT INTO tender.pipeline_contexts(tender_id,lot_key,company_id,pipeline_version,current_step,fachlich_status,blocking_state,completed_steps,profile_snapshot_id,calculation_input_snapshot_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,1) ON CONFLICT(tender_id,lot_key,company_id,pipeline_version) DO UPDATE SET current_step=excluded.current_step,fachlich_status=excluded.fachlich_status,blocking_state=excluded.blocking_state,completed_steps=excluded.completed_steps,profile_snapshot_id=excluded.profile_snapshot_id,calculation_input_snapshot_id=excluded.calculation_input_snapshot_id,revision=tender.pipeline_contexts.revision+1,updated_at=now() RETURNING id`,
      [
        state.tender_id,
        state.lot_key || "",
        state.company_id,
        PIPELINE_SCHEMA_VERSION,
        currentStep,
        transition.status,
        transition.blockingState,
        json(PIPELINE_STEPS.filter((step) => completed.includes(step))),
        state.source_manifest?.profileSnapshotId || null,
        state.calculation_input_snapshot_id,
      ],
    )
  ).rows[0];
  if (
    !prior ||
    prior.current_step !== currentStep ||
    prior.blocking_state !== transition.blockingState
  )
    await pool.query(
      "INSERT INTO tender.pipeline_transitions(pipeline_context_id,from_step,to_step,outcome,blocking_state,job_id,evidence) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [
        context.id,
        prior?.current_step || null,
        currentStep,
        transition.status,
        transition.blockingState,
        item.id,
        json({ completedSteps: completed, externalWrite: false }),
      ],
    );
}
export async function processQueueItem(pool, item) {
  const tender = (
    await pool.query("SELECT * FROM tender.tenders WHERE id=$1", [
      item.tender_id,
    ])
  ).rows[0];
  if (!tender)
    throw Object.assign(Error("tender context missing"), {
      code: "FEHLENDER_TENDERKONTEXT",
    });
  if (item.action_type === "RESOLVE_NOTICE_PORTALS") {
    const run = (
      await pool.query(
        "INSERT INTO tender.enrichment_runs(kind,status,mapper_version,parser_version) VALUES('AUTHORITATIVE_PORTAL_RESOLUTION','RUNNING',$1,$1) RETURNING id",
        [PIPELINE_VERSION],
      )
    ).rows[0];
    let resolutionStage = "CURRENT_VERSION_CHECK";
    try {
      const currentVersion = (await pool.query(
        "SELECT id FROM tender.tender_versions WHERE tender_id=$1 ORDER BY version DESC,created_at DESC,id DESC LIMIT 1",
        [tender.id],
      )).rows[0];
      if (!currentVersion || String(currentVersion.id) !== String(item.tender_version_id)) {
        const summary = {
          resolutionStatus: "SUPERSEDED_BY_CURRENT_TENDER_VERSION",
          externalWrite: false,
          transmitted: false,
        };
        await pool.query(
          "UPDATE tender.enrichment_runs SET status='SUCCESS',finished_at=now(),total=1,enriched=0,metadata=$2::jsonb WHERE id=$1",
          [run.id, json(summary)],
        );
        await pool.query(
          "UPDATE tender.autopilot_queue SET status='SUCCEEDED',current_step='SUPERSEDED_BY_CURRENT_TENDER_VERSION',progress_percent=100,finished_at=now(),heartbeat_at=now(),result_summary=$2::jsonb WHERE id=$1",
          [item.id, json(summary)],
        );
        return summary;
      }
      await step(pool, item.id, "PORTAL_EVIDENCE_LADEN", 20);
      resolutionStage = "NOTICE_LOAD";
      const notice = await loadNotice(pool, tender);
      resolutionStage = "EVIDENCE_PERSIST";
      const enrichment = await persistEnrichment(pool, run.id, tender, notice);
      resolutionStage = "COMPANY_RELEVANCE";
      const selected = (await relevancePlan(pool, tender, enrichment, {
        suppressPipelineEnqueue: true,
        pipelineJobId: item.id,
      })).filter(
        (context) => String(context.company?.company_id || "") === String(item.company_id || ""),
      );
      resolutionStage = "ASSIGNMENT_MATERIALIZATION";
      const assignments = await materializeAuthoritativePortalAssignments(pool, {
        tenderId: tender.id,
        selected,
      });
      resolutionStage = "DOCUMENT_CONTINUATION_ENQUEUE";
      const documentJobsQueued = (await pool.query(
        `INSERT INTO tender.autopilot_queue(request_id,action_type,tender_id,tender_version_id,
            notice_id,lot_key,company_id,service_scope,portal_id,credential_id,
            enrichment_version_id,assessment_version_id,idempotency_key,reason,status,current_step,max_attempts)
          SELECT gen_random_uuid(),'FETCH_DOCUMENTS',relevance.tender_id,scope.tender_version_id,
            coalesce(source.notice_number,source.external_id),relevance.lot_key,relevance.company_id,
            relevance.service_line,scope.portal_id,scope.credential_id,$2,relevance.evaluation_version,
            concat('phase2-document-fetch:',relevance.tender_id,':',scope.tender_version_id,':',
              relevance.company_id,':',relevance.lot_key,':',scope.portal_id),
            'AUTHORITATIVE_PORTAL_RESOLUTION_CONTINUATION','QUEUED','DOCUMENT_FETCH_QUEUED',5
          FROM tender.current_service_relevance relevance
          JOIN tender.tenders source ON source.id=relevance.tender_id
          JOIN tender.current_tender_company_portal_role_scopes scope
            ON scope.tender_id=relevance.tender_id AND scope.company_id=relevance.company_id
            AND scope.source_lot_id=relevance.lot_key AND scope.canonical_service=relevance.service_line
            AND scope.portal_role='DOCUMENT_PORTAL'
          WHERE relevance.tender_id=$1 AND relevance.company_id=$3 AND relevance.relevance_status='RELEVANT'
            AND relevance.service_scope_gate='PASSED' AND relevance.primary_company=true
            AND (scope.credential_id IS NOT NULL OR EXISTS(
              SELECT 1 FROM tender.portal_registry portal
              JOIN tender.tender_external_links link ON link.tender_id=scope.tender_id
                AND link.tender_version_id=scope.tender_version_id
                AND link.role='PROCUREMENT_DOCUMENT' AND link.public_access=true
                AND link.verification_status IN('DISCOVERED','HTTP_VERIFIED')
              WHERE portal.id=scope.portal_id AND portal.adapter_enabled=true
                AND portal.adapter_validation_status='PRODUCTION_VALIDATED'
                AND 'PUBLIC_DOCUMENTS_POSSIBLE'=ANY(coalesce(portal.capabilities,'{}'::text[]))
                AND (lower(coalesce(link.final_host,link.original_host))=lower(portal.canonical_domain)
                  OR lower(coalesce(link.final_host,link.original_host))=ANY(portal.allowed_subdomains)
                  OR lower(coalesce(link.final_host,link.original_host))=ANY(portal.download_domains))))
          ON CONFLICT DO NOTHING`,
        [tender.id, enrichment.id, item.company_id],
      )).rowCount;
      resolutionStage = "RESOLUTION_SUMMARY";
      const resolutions = (
        await pool.query(
          `SELECT evidence_role,resolution_status,portal_id,exact_host
           FROM tender.tender_portal_resolutions
           WHERE tender_id=$1 AND tender_version_id=$2
           ORDER BY evidence_role`,
          [tender.id, currentVersion.id],
        )
      ).rows;
      const reviewRequired = resolutions
        .filter((row) => ["PROCUREMENT_DOCUMENT", "PARTICIPATION", "SUBMISSION"].includes(row.evidence_role))
        .some((row) => row.resolution_status !== "UNIQUE_EVIDENCE");
      const summary = {
        enrichmentVersion: enrichment.version,
        resolutionStatus: reviewRequired ? "PORTAL_ASSIGNMENT_REVIEW_REQUIRED" : "PORTAL_RESOLVED",
        roles: resolutions.map((row) => ({
          role: row.evidence_role,
          status: row.resolution_status,
          portalId: row.portal_id,
          exactHost: row.exact_host,
        })),
        assignments,
        documentJobsQueued,
        externalWrite: false,
        transmitted: false,
      };
      await pool.query(
        "UPDATE tender.enrichment_runs SET status='SUCCESS',finished_at=now(),total=1,enriched=1 WHERE id=$1",
        [run.id],
      );
      await pool.query(
        "UPDATE tender.autopilot_queue SET status='SUCCEEDED',current_step=$2,progress_percent=100,finished_at=now(),heartbeat_at=now(),result_summary=$3::jsonb,error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL WHERE id=$1",
        [item.id, reviewRequired ? "PORTAL_ASSIGNMENT_REVIEW_REQUIRED" : "PORTAL_RESOLVED", json(summary)],
      );
      return summary;
    } catch (error) {
      console.error(JSON.stringify({
        component: "authoritative-portal-resolution",
        resolutionStage,
        errorCode: String(error?.code || "UNCLASSIFIED").slice(0, 32),
        errorPosition: String(error?.position || "").slice(0, 16),
        safeMessage: String(error?.message || "portal resolution failed").replace(/https?:\/\/\S+/gi, "[URL_MASKED]").slice(0, 180),
      }));
      const retry = Number(item.attempt || 0) < Number(item.max_attempts || 5);
      const code = error?.code === "23514" && String(error?.message || "").includes("exact_role_company_lot_portal_scope_required_before_enqueue")
        ? "PORTAL_CONTINUATION_SCOPE_REJECTED"
        : "PORTAL_RESOLUTION_FAILED";
      await pool.query(
        "UPDATE tender.enrichment_runs SET status='FAILED',finished_at=now(),total=1,failed=1 WHERE id=$1",
        [run.id],
      ).catch(() => {});
      await pool.query(
        `UPDATE tender.autopilot_queue SET status=$2,current_step=$3,error_code=$4,safe_error_code=$4,
           error_detail_safe=$5,
           next_attempt_at=CASE WHEN $2='RETRY' THEN now()+interval '30 seconds' ELSE next_attempt_at END,
           finished_at=CASE WHEN $2='DEAD_LETTER' THEN now() ELSE NULL END,heartbeat_at=now()
         WHERE id=$1`,
        [item.id, retry ? "RETRY" : "DEAD_LETTER", retry ? "RETRY_SCHEDULED" : "FAILED", code,
          `Read-only portal resolution stopped at ${resolutionStage} (${String(error?.code || "UNCLASSIFIED").replace(/[^A-Z0-9_]/gi, "_").slice(0, 32)}); no external write occurred.`],
      ).catch(() => {});
      return { resolutionStatus: code, retry, externalWrite: false, transmitted: false };
    }
  }
  const lot = item.lot_key
    ? (
        await pool.query(
          "SELECT lot_key,lifecycle_status,participation_status,participation_block_reason,offer_deadline FROM tender.tender_lot_lifecycles WHERE tender_id=$1 AND lot_key=$2 AND is_current",
          [item.tender_id, item.lot_key],
        )
      ).rows[0]
    : null;
  if (
    item.action_type !== "TEST_PORTAL_CONNECTION" &&
    (
      tender.source_lifecycle_status !== "ACTIVE" ||
      !["ELIGIBLE", "PARTIALLY_ELIGIBLE"].includes(
        tender.participation_status,
      ) ||
      !lot ||
      lot.lifecycle_status !== "ACTIVE" ||
      lot.participation_status !== "ELIGIBLE" ||
      !lot.offer_deadline ||
      new Date(lot.offer_deadline) <= new Date()
    )
  ) {
    const code =
        lot?.participation_block_reason ||
        tender.participation_block_reason ||
        "TENDER_NOT_PARTICIPATION_ELIGIBLE",
      summary = {
        status: "NOT_PARTICIPATION_ELIGIBLE",
        noticeClassification: tender.notice_classification,
        lifecycle: tender.source_lifecycle_status,
        lotKey: item.lot_key || null,
        reasonCode: code,
        externalWrite: false,
      };
    await pool.query(
      "UPDATE tender.autopilot_queue SET status='CANCELLED',current_step='PARTICIPATION_BLOCKED',progress_percent=100,finished_at=now(),terminal_at=now(),terminal_result='NOT_PARTICIPATION_ELIGIBLE',heartbeat_at=now(),error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL,result_summary=$3::jsonb||jsonb_build_object('terminalClassificationVersion','participation-terminal-v1','originalReasonCode',$2::text) WHERE id=$1",
      [item.id, code, json(summary)],
    );
    return summary;
  }
  // Downstream approvals and packages must expire against the selected lot,
  // never against an aggregate tender deadline.
  if (lot) tender.offer_deadline = lot.offer_deadline;
  const run = (
    await pool.query(
      "INSERT INTO tender.enrichment_runs(kind,status,mapper_version,parser_version) VALUES('AUTOPILOT_PIPELINE','RUNNING',$1,$1) RETURNING id",
      [PIPELINE_VERSION],
    )
  ).rows[0];
  try {
    const registered = (
      await pool.query(
        `SELECT 1 FROM tender.current_tender_company_portal_role_scopes scope
         WHERE scope.tender_id=$1::uuid AND scope.company_id=$2::uuid
           AND scope.portal_id=$3::uuid AND scope.credential_id=$4::uuid
           AND scope.source_lot_id=$5
           AND (scope.portal_role='DOCUMENT_PORTAL' OR $6<>ALL(ARRAY[
             'FETCH_DOCUMENTS','ANALYZE_DOCUMENTS','TEST_DOCUMENT_FETCH','RUN_FULL_PIPELINE'
           ]::text[])) LIMIT 2`,
        [item.tender_id, item.company_id, item.portal_id, item.credential_id, item.lot_key, item.action_type],
      )
    ).rows;
    const credentiallessPublicActions=new Set([
        "FETCH_DOCUMENTS","ANALYZE_DOCUMENTS","REFRESH_ENRICHMENT","VALIDATE_CALCULATION_INPUTS",
        "START_CALCULATION","REFRESH_REVIEW","GENERATE_RECOMMENDATION","RUN_FULL_PIPELINE",
        "GENERATE_BOARD_REPORT","EXPORT_REVIEW_REPORT","EXPORT_BOARD_BRIEF",
      ]),
      publicReadScope=!item.credential_id&&item.portal_id&&credentiallessPublicActions.has(item.action_type)
        ?(await pool.query(`SELECT resolution.portal_id
          FROM tender.tender_portal_resolutions resolution
          JOIN tender.portal_registry portal ON portal.id=resolution.portal_id
            AND portal.adapter_enabled=true AND portal.adapter_validation_status IN('VALIDATED','VALIDATED_READ_ONLY','PRODUCTION_VALIDATED')
            AND 'PUBLIC_DOCUMENTS_POSSIBLE'=ANY(coalesce(portal.capabilities,'{}'::text[]))
          JOIN LATERAL(SELECT candidate.id FROM tender.tender_versions candidate
            WHERE candidate.tender_id=resolution.tender_id ORDER BY candidate.version DESC LIMIT 1)version
            ON version.id=resolution.tender_version_id
          WHERE resolution.tender_id=$1 AND resolution.portal_id=$2
            AND resolution.evidence_role='PROCUREMENT_DOCUMENT' AND resolution.resolution_status='UNIQUE_EVIDENCE'
            AND EXISTS(SELECT 1 FROM tender.tender_external_links link WHERE link.tender_id=resolution.tender_id
              AND link.role='PROCUREMENT_DOCUMENT' AND link.public_access=true
              AND link.verification_status IN('DISCOVERED','HTTP_VERIFIED')
              AND (lower(coalesce(link.final_host,link.original_host))=lower(portal.canonical_domain)
                OR lower(coalesce(link.final_host,link.original_host))=ANY(portal.allowed_subdomains)
                OR lower(coalesce(link.final_host,link.original_host))=ANY(portal.download_domains)))`,
          [item.tender_id,item.portal_id])).rows:[];
    if (
      item.action_type !== "TEST_PORTAL_CONNECTION" &&
      registered.length !== 1 &&
      publicReadScope.length !== 1
    )
      throw Object.assign(
        Error("registered portal scope missing or ambiguous"),
        { code: "PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT" },
      );
    const summary = await processAction(pool, item, tender, run);
    await pool.query(
      "UPDATE tender.enrichment_runs SET status='SUCCESS',finished_at=now(),total=1,enriched=1 WHERE id=$1",
      [run.id],
    );
    await pool.query(
      "UPDATE tender.autopilot_queue SET status='SUCCEEDED',current_step='COMPLETED',progress_percent=100,finished_at=now(),heartbeat_at=now(),terminal_at=NULL,terminal_result=NULL,result_summary=$2::jsonb,error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL,blocking_reason=NULL WHERE id=$1",
      [item.id, json(summary)],
    );
    await refreshPipelineContext(pool, item);
    await pool.query(
      "INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES('autopilot_action_completed',$1,$2::jsonb)",
      [
        tender.id,
        json({
          jobId: item.id,
          requestId: item.request_id,
          actionType: item.action_type,
          externalWrite: false,
        }),
      ],
    );
    return summary;
  } catch (error) {
    const code = String(error.code || "TECHNISCHER_CONNECTORFEHLER").slice(
      0,
      80,
    );
    if (code === "NOT_ELIGIBLE") {
      const summary = {
        status: "SUPERSEDED_BY_CURRENT_RELEVANCE",
        reason:
          "company/lot context was replaced by the current real notice classification",
        externalWrite: false,
      };
      await pool.query(
        "UPDATE tender.enrichment_runs SET status='SUCCESS',finished_at=now(),total=1,enriched=0,metadata=$2::jsonb WHERE id=$1",
        [run.id, json(summary)],
      );
      await pool.query(
        "UPDATE tender.autopilot_queue SET status='SUCCEEDED',current_step='SUPERSEDED_BY_CURRENT_RELEVANCE',progress_percent=100,finished_at=now(),heartbeat_at=now(),terminal_at=NULL,terminal_result=NULL,result_summary=$2::jsonb,error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL,blocking_reason=NULL WHERE id=$1",
        [item.id, json(summary)],
      );
      await pool.query(
        "INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES('obsolete_pipeline_context_superseded',$1,$2::jsonb)",
        [
          tender.id,
          json({
            jobId: item.id,
            requestId: item.request_id,
            lotKey: item.lot_key,
            companyId: item.company_id,
            externalWrite: false,
          }),
        ],
      );
      return summary;
    }
    const continuationStatus = new Map([
      ["REGISTERED_PORTAL_SCOPE_NOT_FOUND", "ACCOUNT_SETUP_REQUIRED"],
      ["PORTALZUGANG_NICHT_KONFIGURIERT", "ACCOUNT_SETUP_REQUIRED"],
      ["CREDENTIAL_MISSING", "ACCOUNT_SETUP_REQUIRED"],
      ["REAUTH_REQUIRED", "REAUTH_REQUIRED"],
      ["BENUTZERNAME_ODER_PASSWORT_FALSCH", "REAUTH_REQUIRED"],
      ["PASSWORT_ABGELAUFEN", "REAUTH_REQUIRED"],
      ["KONTO_GESPERRT", "REAUTH_REQUIRED"],
      ["SESSION_NICHT_FUER_DOWNLOAD_GUELTIG", "REAUTH_REQUIRED"],
      ["SESSION_COOKIE_FEHLT", "REAUTH_REQUIRED"],
      ["CREDENTIAL_VERSION_SUPERSEDED", "REAUTH_REQUIRED"],
      ["MFA_BESTÄTIGUNG_ERFORDERLICH", "MANUAL_MFA_REQUIRED"],
      ["MFA_REQUIRED", "MANUAL_MFA_REQUIRED"],
      ["CAPTCHA_MANUELL_ERFORDERLICH", "MANUAL_CAPTCHA_REQUIRED"],
      ["CAPTCHA_REQUIRED", "MANUAL_CAPTCHA_REQUIRED"],
    ]).get(code);
    if (continuationStatus) {
      const summary = {
        status: continuationStatus,
        reasonCode: code,
        requiredAction: continuationStatus,
        externalWrite: false,
      };
      await pool.query(
        "UPDATE tender.enrichment_runs SET status='SUCCESS',finished_at=now(),total=1,enriched=0,metadata=$2::jsonb WHERE id=$1",
        [run.id, json(summary)],
      );
      await pool.query(
        "UPDATE tender.autopilot_queue SET status='CANCELLED',current_step='HUMAN_ACTION_REQUIRED',progress_percent=100,finished_at=now(),terminal_at=now(),terminal_result=$2,heartbeat_at=now(),result_summary=$3::jsonb||jsonb_build_object('terminalClassificationVersion','portal-human-continuation-v1'),error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL WHERE id=$1",
        [item.id, continuationStatus, json(summary)],
      );
      await pool.query(
        "INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES('portal_human_continuation_required',$1,$2::jsonb)",
        [tender.id, json({ jobId: item.id, companyId: item.company_id, portalId: item.portal_id, status: continuationStatus, reasonCode: code, externalWrite: false })],
      );
      return summary;
    }
    const repairContinuation = new Map([
      ["PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT", {
        status: "DATA_CONTEXT_REPAIR_REQUIRED",
        repairAction: "DOCUMENT_OR_SUBMISSION_PORTAL_FOR_EXACT_COMPANY_TENDER_LOT_CONFIRM",
      }],
      ["PORTAL_ASSIGNMENT_REVIEW_REQUIRED", {
        status: "DATA_CONTEXT_REPAIR_REQUIRED",
        repairAction: "DOCUMENT_OR_SUBMISSION_PORTAL_FOR_EXACT_COMPANY_TENDER_LOT_CONFIRM",
      }],
      ["FEHLENDER_PORTALKONTEXT", {
        status: "DATA_CONTEXT_REPAIR_REQUIRED",
        repairAction: "DOCUMENT_OR_SUBMISSION_PORTAL_FOR_EXACT_COMPANY_TENDER_LOT_CONFIRM",
      }],
      ["EXACT_ENRICHMENT_CONTEXT_REQUIRED", {
        status: "DATA_CONTEXT_REPAIR_REQUIRED",
        repairAction: "CANONICAL_LOT_ENRICHMENT_BINDING_REPAIR",
      }],
      ["LOGIN_FORMULAR_GEAENDERT", {
        status: "ADAPTER_REPAIR_REQUIRED",
        repairAction: "PORTAL_LOGIN_ADAPTER_VALIDATE_AND_REPAIR",
      }],
      ["LOGIN_REDIRECT_UNERWARTET", {
        status: "ADAPTER_REPAIR_REQUIRED",
        repairAction: "PORTAL_REDIRECT_PROFILE_VALIDATE_AND_REPAIR",
      }],
      ["DOKUMENTENLISTE_NICHT_ERMITTELT", {
        status: "ADAPTER_REPAIR_REQUIRED",
        repairAction: "PORTAL_DOCUMENT_LIST_ADAPTER_VALIDATE_AND_REPAIR",
      }],
      ["DOWNLOADLINK_NICHT_AUFGELOEST", {
        status: "ADAPTER_REPAIR_REQUIRED",
        repairAction: "PORTAL_DOCUMENT_LINK_ADAPTER_VALIDATE_AND_REPAIR",
      }],
      ["PORTAL_NICHT_VALIDIERT", {
        status: "ADAPTER_REPAIR_REQUIRED",
        repairAction: "PORTAL_ADAPTER_VALIDATE_AND_REPAIR",
      }],
      ["KEIN_ADAPTER_VERFUEGBAR", {
        status: "UNSUPPORTED_PORTAL_REQUIRES_ADAPTER",
        repairAction: "PORTAL_ADAPTER_IMPLEMENT_AND_VALIDATE",
      }],
      ["UNKNOWN_PORTAL_ADAPTER_REQUIRED", {
        status: "UNSUPPORTED_PORTAL_REQUIRES_ADAPTER",
        repairAction: "PORTAL_ADAPTER_IMPLEMENT_AND_VALIDATE",
      }],
      ["PORTAL_NICHT_ERREICHBAR", {
        status: "EXTERNAL_PORTAL_UNAVAILABLE",
        repairAction: "RETRY_AFTER_VERIFIED_PORTAL_RECOVERY",
      }],
    ]).get(code);
    if (repairContinuation) {
      const summary = {
        status: repairContinuation.status,
        reasonCode: code,
        requiredAction: repairContinuation.status,
        repairAction: repairContinuation.repairAction,
        externalWrite: false,
      };
      await pool.query(
        "UPDATE tender.enrichment_runs SET status='SUCCESS',finished_at=now(),total=1,enriched=0,metadata=$2::jsonb WHERE id=$1",
        [run.id, json(summary)],
      );
      await pool.query(
        "UPDATE tender.autopilot_queue SET status='CANCELLED',current_step='REPAIR_ACTION_REQUIRED',progress_percent=100,finished_at=now(),terminal_at=now(),terminal_result=$2,heartbeat_at=now(),result_summary=$3::jsonb||jsonb_build_object('terminalClassificationVersion','pipeline-repair-continuation-v1'),error_code=NULL,safe_error_code=NULL,error_detail_safe=NULL WHERE id=$1",
        [item.id, repairContinuation.status, json(summary)],
      );
      await pool.query(
        "INSERT INTO tender.audit_events(action,tender_id,metadata) VALUES('pipeline_repair_continuation_required',$1,$2::jsonb)",
        [tender.id, json({ jobId: item.id, companyId: item.company_id, portalId: item.portal_id, status: repairContinuation.status, reasonCode: code, repairAction: repairContinuation.repairAction, externalWrite: false })],
      );
      return summary;
    }
    const terminalCodes = new Set([
        "LOGIN_FORMULAR_GEAENDERT",
        "MFA_BESTÄTIGUNG_ERFORDERLICH",
        "CAPTCHA_MANUELL_ERFORDERLICH",
        "PASSWORT_ABGELAUFEN",
        "KONTO_GESPERRT",
        "PORTALZUGANG_NICHT_KONFIGURIERT",
        "CREDENTIAL_MISSING",
        "REAUTH_REQUIRED",
        "MFA_REQUIRED",
        "CAPTCHA_REQUIRED",
        "REGISTERED_PORTAL_SCOPE_NOT_FOUND",
        "PORTAL_DER_AUSSCHREIBUNG_NICHT_ERMITTELT",
        "PORTAL_ASSIGNMENT_REVIEW_REQUIRED",
        "PORTAL_NICHT_VALIDIERT",
        "KEIN_ADAPTER_VERFUEGBAR",
        "CREDENTIAL_VERSION_SUPERSEDED",
        "FEHLENDER_PORTALKONTEXT",
        "FEHLENDER_TENDERKONTEXT",
        "KEINE_DOKUMENTE_VORHANDEN",
        "UNKNOWN_PORTAL_ADAPTER_REQUIRED",
        "DOKUMENTENLISTE_NICHT_ERMITTELT",
        "DOKUMENTENBERECHTIGUNG_FEHLT",
        "DOWNLOADLINK_NICHT_AUFGELOEST",
        "SESSION_NICHT_FUER_DOWNLOAD_GUELTIG",
        "MALWARE_DETECTED",
        "DOCUMENT_TYPE_REJECTED",
        "NOT_ELIGIBLE",
        "TENDER_NOT_PARTICIPATION_ELIGIBLE",
      ]),
      retry =
        !terminalCodes.has(code) && item.attempt < (item.max_attempts || 3),
      detail = String(error.message || "processing failed")
        .replace(
          /(?:password|token|cookie|authorization)\s*[:=]\s*\S+/gi,
          "[MASKED]",
        )
        .slice(0, 240);
    await pool.query(
      "UPDATE tender.enrichment_runs SET status='FAILED',finished_at=now(),parser_errors=1,metadata=$2::jsonb WHERE id=$1",
      [run.id, json({ errorCode: code })],
    );
    await pool.query(
      "UPDATE tender.autopilot_queue SET status=$2,current_step=$3,error_code=$4,safe_error_code=$4,error_detail_safe=$5,next_attempt_at=CASE WHEN $2='RETRY' THEN now()+make_interval(secs=>$6) ELSE next_attempt_at END,finished_at=CASE WHEN $2='DEAD_LETTER' THEN now() ELSE NULL END,heartbeat_at=now() WHERE id=$1",
      [
        item.id,
        retry ? "RETRY" : "DEAD_LETTER",
        retry ? "RETRY_SCHEDULED" : "FAILED",
        code,
        detail,
        Math.min(3600, 60 * 2 ** item.attempt),
      ],
    );
    await refreshPipelineContext(pool, item).catch(() => {});
    throw error;
  }
}
export async function claimQueue(pool) {
  await pool.query(
    "UPDATE tender.autopilot_queue SET status='DEAD_LETTER',current_step='FAILED',error_code='LOGIN_TEST_TIMEOUT',safe_error_code='LOGIN_TEST_TIMEOUT',error_detail_safe='Die Portalprüfung hat innerhalb des zulässigen Zeitfensters keinen Fortschritt gemeldet.',finished_at=now(),terminal_at=now(),terminal_result='LOGIN_TEST_TIMEOUT',heartbeat_at=now() WHERE action_type IN('START_PORTAL_AUTHENTICATION','TEST_PORTAL_CONNECTION','TEST_DOCUMENT_FETCH') AND status IN('PENDING','QUEUED','CLAIMED','RUNNING','RETRY') AND coalesce(timeout_at,created_at+interval '3 minutes')<=now()",
  );
  await pool.query(
    "UPDATE tender.autopilot_queue SET status='RETRY',current_step='CLAIM_TIMEOUT_RELEASED',next_attempt_at=now(),worker_id=NULL WHERE status IN ('CLAIMED','RUNNING') AND COALESCE(heartbeat_at,claimed_at)<now()-interval '5 minutes'",
  );
  return (
    (
      await pool.query(
        `UPDATE tender.autopilot_queue SET status='RUNNING',current_step='CLAIMED',started_at=COALESCE(started_at,now()),heartbeat_at=now(),last_progress_at=now(),attempt=attempt+1,claimed_at=now(),worker_id=$1 WHERE id=(SELECT id FROM tender.autopilot_queue WHERE status IN ('PENDING','RETRY','QUEUED') AND next_attempt_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
        [
          String(
            process.env.WORKER_ID || process.env.HOSTNAME || "tender-worker",
          ).slice(0, 120),
        ],
      )
    ).rows[0] || null
  );
}

async function processPendingDocumentMalwareScans(pool, batchSize = 16) {
  const rows = (
    await pool.query(
      `SELECT scan.id,scan.payload_sha256,document.content
       FROM tender.document_malware_scans scan
       JOIN tender.enrichment_documents document
         ON document.id=scan.document_id AND document.payload_sha256=scan.payload_sha256
       WHERE scan.status IN('PENDING','SCAN_ERROR','QUARANTINED')
         AND (scan.next_retry_at IS NULL OR scan.next_retry_at<=now())
       ORDER BY scan.created_at,scan.id
       LIMIT $1`,
      [Math.max(1, Math.min(16, Number(batchSize) || 8))],
    )
  ).rows;
  if (!rows.length) return 0;
  const engineVersion = await scannerVersion(),scanConcurrency=Math.max(1,Math.min(4,
    Number(process.env.MALWARE_SCAN_CONCURRENCY||2)||2));
  for(let offset=0;offset<rows.length;offset+=scanConcurrency)await Promise.all(
    rows.slice(offset,offset+scanConcurrency).map(async (row) => {
      const result = await scanBuffer(row.content),
        status =
          result.status === "CLEAN"
            ? "CLEAN"
            : result.status === "INFECTED"
              ? "INFECTED"
              : "QUARANTINED";
      await pool.query(
        `UPDATE tender.document_malware_scans
         SET engine=$2,engine_version=$3,status=$4,detail_code=$5,attempt=attempt+1,
             next_retry_at=CASE WHEN $4='QUARANTINED' THEN now()+interval '15 minutes' ELSE NULL END,
             scanned_at=now()
         WHERE id=$1 AND payload_sha256=$6`,
        [row.id, result.engine, engineVersion, status, result.detail, row.payload_sha256],
      );
    }),
  );
  return rows.length;
}
export async function runWorker({ once = false } = {}) {
  const concurrency = Math.max(
      1,
      Math.min(8, Number(process.env.DOCUMENT_WORKFLOW_CONCURRENCY || 4) || 4),
    ),
    connectionString =
      process.env.DATABASE_URL ||
      readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim(),
    rawPool = new pg.Pool({ connectionString, max: concurrency + 3 }),
    workerId = String(
      process.env.WORKER_ID || process.env.HOSTNAME || "tender-worker",
    ).slice(0, 120);
  const backgroundScope = await loadBackgroundScope(rawPool);
  const pool = createFixedScopedPool(rawPool, backgroundScope).pool;
  const healthServer = once
    ? null
    : createServer((request, response) => {
        if (request.url === "/health" || request.url === "/healthz") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              status: "ok",
              component: "semantic-browser-worker",
              workerId,
              documentWorkflowConcurrency: concurrency,
            }),
          );
          return;
        }
        response.writeHead(404);
        response.end();
      });
  if (healthServer)
    await new Promise((resolve, reject) =>
      healthServer
        .once("error", reject)
        .listen(
          Number(process.env.PORT || 4240),
          process.env.HOST || "0.0.0.0",
          resolve,
        ),
    );
  const regionRecalculationWorker = once
    ? null
    : startRegionRecalculationWorker(pool, {
        logger: console,
        batchSize: Number(process.env.REGION_RECALCULATION_BATCH_SIZE || 100),
      });
  let bootRecovered = false;
  try {
    do {
      try {
        if (!bootRecovered) {
          await pool.query(
            "UPDATE tender.autopilot_queue SET status='RETRY',current_step='WORKER_RESTART_CLAIM_RELEASED',next_attempt_at=now(),worker_id=NULL,claimed_at=NULL,heartbeat_at=NULL,error_code='WORKER_RESTART_CLAIM_RELEASED',error_detail_safe='Claim released during verified single-worker restart' WHERE worker_id=$1 AND status IN('CLAIMED','RUNNING')",
            [workerId],
          );
          bootRecovered = true;
        }
        await processPendingDocumentMalwareScans(pool);
        const items = [];
        for (let lane = 0; lane < concurrency; lane++) {
          const item = await claimQueue(pool);
          if (!item) break;
          items.push(item);
        }
        if (!items.length) {
          const monitored = await monitorDueProcedure(pool).catch((error) => {
            console.error(
              JSON.stringify({
                component: "procedure-monitoring",
                error: String(error.message).slice(0, 160),
              }),
            );
            return false;
          });
          if (once || !monitored) await sleep(5000);
          continue;
        }
        await Promise.all(
          items.map((item) =>
            processQueueItem(pool, item).catch((error) =>
              console.error(
                JSON.stringify({ queueId: item.id, error: error.message }),
              ),
            ),
          ),
        );
        await processPendingDocumentMalwareScans(pool);
      } catch (error) {
        if (
          ![
            "57P01",
            "57P02",
            "57P03",
            "08000",
            "08001",
            "08003",
            "08004",
            "08006",
            "08007",
            "08P01",
            "ECONNREFUSED",
            "ECONNRESET",
            "EAI_AGAIN",
          ].includes(String(error.code || ""))
        )
          throw error;
        console.error(
          JSON.stringify({
            component: "worker-database-recovery",
            code: String(error.code || "DATABASE_UNAVAILABLE").slice(0, 30),
          }),
        );
        bootRecovered = false;
        await sleep(5000);
      }
    } while (!once);
  } finally {
    regionRecalculationWorker?.stop();
    if (healthServer)
      await new Promise((resolve) => healthServer.close(resolve));
    await pool.end();
  }
}
async function companyContexts(pool, tender) {
  const companies = (
      await pool.query(`SELECT company.*,scope.tenant_id,scope.canonical_service,scope.profile_id
    FROM tender.enterprise_company_links company JOIN tender.configuration_scopes scope ON scope.company_id=company.company_id AND scope.profile_id=company.tender_profile_id
    WHERE company.active=true ORDER BY company.legal_name`)
    ).rows,
    result = [];
  for (const company of companies) {
    const serviceLine =
      company.canonical_service === "facility_management"
        ? "facility-management"
        : company.canonical_service === "emergency_services"
          ? "emergency-services"
          : company.canonical_service;
    const [region, parameterRows, profile, costConfig] = await Promise.all([
      pool.query(
        "SELECT * FROM tender.current_scoped_region_evaluations WHERE tender_id=$1 AND company_id=$2 AND active_canonical_service=$3 AND lot_id IS NULL LIMIT 1",
        [tender.id, company.company_id, company.canonical_service],
      ),
      pool.query(
        `SELECT c.id,c.version_id,v.version_no,a.activated_at,a.company_id,a.service_line,a.parameter_key,c.new_value,c.unit,c.valid_from,c.valid_until,'ACTIVE'::text status,c.created_at
        FROM tender.configuration_active_parameters a JOIN tender.configuration_changes c ON c.id=a.change_id JOIN tender.configuration_versions v ON v.id=c.version_id
        WHERE a.company_id=$1 AND a.service_line=$2 AND v.tenant_id=$3 AND v.canonical_service=$4 AND v.profile_id=$5 ORDER BY a.parameter_key,v.version_no DESC`,
        [
          company.company_id,
          serviceLine,
          company.tenant_id,
          company.canonical_service,
          company.profile_id,
        ],
      ),
      pool.query("SELECT * FROM tender.company_profiles WHERE id=$1 LIMIT 1", [
        company.profile_id,
      ]),
      pool.query(
        "SELECT * FROM tender.cost_configurations WHERE company_id=$1 AND service_line=$2 AND status='ACTIVE' AND effective_from<=current_date ORDER BY version DESC LIMIT 1",
        [company.company_id, serviceLine],
      ),
    ]);
    const effective = resolveEffectiveParameters(parameterRows.rows, {
        asOf: new Date(),
      }),
      companyProfile = profile.rows[0] || null;
    const sourceManifest = Object.fromEntries(
      Object.entries(effective.parameters).map(([key, value]) => [
        key,
        {
          parameterId: value.parameterId,
          sourceVersionId: value.sourceVersionId,
          sourceVersion: value.sourceVersion,
          validFrom: value.validFrom,
          validUntil: value.validUntil,
        },
      ]),
    );
    const unified = buildEffectiveCompanyProfile({
      companyId: company.company_id,
      serviceArea: serviceLine,
      parameters: effective.parameters,
      companyProfile,
      sourceManifest,
    });
    const persisted = (
      await pool.query(
        `INSERT INTO tender.effective_profile_snapshots(company_id,service_line,effective_at,resolver_version,snapshot_sha256,parameters,ambiguities,source_manifest)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) ON CONFLICT(company_id,service_line,snapshot_sha256) DO UPDATE SET source_manifest=excluded.source_manifest RETURNING id`,
        [
          company.company_id,
          serviceLine,
          unified.resolvedAt,
          PIPELINE_SCHEMA_VERSION,
          unified.snapshotId,
          json(unified.parameters),
          json(effective.ambiguities),
          json({
            ...sourceManifest,
            __effectiveProfile: {
              companyProfileId: unified.companyProfileId,
              companyProfileVersion: unified.companyProfileVersion,
              additional: unified.additional,
              readiness: unified.readiness,
            },
          }),
        ],
      )
    ).rows[0];
    result.push({
      company,
      parameters: profileParameterRows(unified),
      profile: { ...companyProfile, effective: unified },
      profileSnapshot: {
        ...unified,
        id: persisted.id,
        ambiguities: effective.ambiguities,
      },
      region: region.rows[0] || null,
      costConfig: costConfig.rows[0] || null,
    });
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`)
  await runWorker({ once: process.env.AUTOPILOT_ONCE === "true" });
export { loadNotice,materializeDocumentContract,persistEnrichment };
