import { readFileSync } from "node:fs";
import pg from "pg";
import {
  portalCatalogProfile,
  withTedServiceCatalog,
} from "./platform/portal-capability-policy.mjs";

const pool = new pg.Pool({
  connectionString: readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim(),
});
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const rows = (await client.query("SELECT * FROM tender.portal_registry ORDER BY display_name,canonical_domain")).rows;
  const catalog = withTedServiceCatalog(rows);
  const ted = catalog.filter((row) => row.catalog_profile.isTedService).map((row) => ({
    name: row.catalog_profile.officialName,
    host: row.catalog_profile.host,
    purpose: row.catalog_profile.purpose,
    login: row.catalog_profile.loginAvailable,
    registration: row.catalog_profile.registrationAvailable,
    capabilities: row.catalog_profile.capabilities,
    accountTypes: row.catalog_profile.accountTypes,
    validation: row.catalog_profile.validationStatus,
    virtual: row.catalog_virtual === true,
  }));
  const profiles = catalog.map((row) => portalCatalogProfile(row));
  console.log(JSON.stringify({
    registryRows: rows.length,
    allVisible: catalog.length,
    tedVisible: ted.length,
    loginPortals: profiles.filter((profile) => profile.loginAvailable).length,
    credentialAdapterReady: rows.filter((row) => row.adapter_enabled === true && row.adapter_validation_status === "PRODUCTION_VALIDATED").length,
    submissionCapable: profiles.filter((profile) => profile.capabilities.includes("BID_SUBMISSION")).length,
    reviewRequired: profiles.filter((profile) => profile.validationStatus === "REVIEW_REQUIRED").length,
    ted,
  }, null, 2));
  await client.query("ROLLBACK");
} finally {
  client.release();
  await pool.end();
}
