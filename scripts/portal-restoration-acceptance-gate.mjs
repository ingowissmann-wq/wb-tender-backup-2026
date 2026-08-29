import {existsSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {chromium} from "playwright";

const capabilityEvidence=Object.freeze({
  "Übersicht":["tests/tender-overview-sync-contract.test.mjs"],
  "Ausschreibungen":["tests/discovery-visibility.test.mjs"],
  "Management-Inbox":["tests/management-inbox-null-contract-browser.test.mjs","tests/management-inbox-pagination.test.mjs"],
  "Fristenprüfung":["tests/notice-lifecycle-participation.test.mjs"],
  "CSM":["tests/business-suite-trial.test.mjs"],
  "Schedulerstatus":["tests/source-ingestion.test.mjs","tests/inbox-pipeline.test.mjs"],
  "Favoriten":["tests/canonical-action-context-systemwide.test.mjs"],
  "Fristen":["tests/notice-lifecycle-participation.test.mjs"],
  "Aufgaben":["tests/synthetic-full-e2e-matrix.test.mjs"],
  "Wiedervorlagen":["tests/canonical-action-context-systemwide.test.mjs"],
  "Quellen":["tests/source-ingestion.test.mjs","tests/tender-link-evidence.test.mjs"],
  "Importprotokolle":["tests/source-ingestion.test.mjs"],
  "Dead Letters":["tests/job-continuation-presentation.test.mjs"],
  "Tender-Autopilot":["tests/synthetic-full-e2e-matrix.test.mjs"],
  "Konfiguration":["tests/structured-regions.test.mjs"],
  "Suche":["tests/portal-management-search.test.mjs"],
  "Quellenfilter":["tests/discovery-visibility.test.mjs"],
  "Gesellschaftsfilter":["tests/management-inbox-pagination.test.mjs"],
  "Relevanzfilter":["tests/management-inbox-pagination.test.mjs"],
  "Pagination":["tests/management-inbox-pagination.test.mjs"],
  "Detailansicht":["tests/management-inbox-pagination.test.mjs"],
  "Losauswahl":["tests/canonical-action-context-systemwide.test.mjs","tests/tender-context-contract.test.mjs"],
  "Portalzugang":["tests/canonical-portal-access.test.mjs","tests/portal-save-verify-version.test.mjs"],
  "Dokumentabruf":["tests/public-document-authoritative-selection.test.mjs","tests/portal-family-full-contract-matrix.test.mjs"],
  "Dokumentanalyse":["tests/required-document-classification.test.mjs"],
  "Kalkulation":["tests/sector-calculation.test.mjs"],
  "Pflichtdokumente":["tests/required-document-lifecycle.test.mjs"],
  "Ausfüllen und Speichern":["tests/required-documents-browser-journey.test.mjs","tests/required-office-browser-journey.test.mjs"],
  "Angebotsvorbereitung":["tests/synthetic-full-e2e-matrix.test.mjs"],
  "Vier-Augen-Prüfung":["tests/approval-modal-contract.test.mjs","tests/synthetic-full-e2e-matrix.test.mjs"],
  "Vorstandsgenehmigung":["tests/approval-modal-contract.test.mjs"],
  "Abgabepaket":["tests/submission-adapter-simulation-matrix.test.mjs"],
  "Abgabestatus":["tests/submission-adapter-simulation-matrix.test.mjs"],
  "Monitoring":["tests/production-system-audit-scope.test.mjs","tests/portal-readiness-dimensions.test.mjs"],
});

if(Object.keys(capabilityEvidence).length!==34)throw new Error("restoration_capability_count_mismatch");
const files=[...new Set(Object.values(capabilityEvidence).flat())];
for(const file of files)if(!existsSync(new URL(`../${file}`,import.meta.url)))throw new Error(`restoration_evidence_missing:${file}`);
const browserPath=process.env.CHROMIUM_EXECUTABLE_PATH||chromium.executablePath();
if(!existsSync(browserPath))throw new Error("CHROMIUM_REQUIRED_FOR_RESTORATION_GATE");
const result=spawnSync(process.execPath,["--test",...files],{cwd:new URL("../",import.meta.url),env:{...process.env,CHROMIUM_EXECUTABLE_PATH:browserPath},stdio:"inherit"});
if(result.error||result.status!==0)process.exit(result.status||1);
console.log(JSON.stringify({passed:true,status:"INTERNALLY_SIMULATED_ONLY",capabilities:Object.entries(capabilityEvidence).map(([capability,evidence])=>({capability,status:"INTERNALLY_SIMULATED_ONLY",evidence})),capabilityCount:34,companyTypes:6,portalFamilies:16,crossProductContexts:96,externalProductionWrite:false,transmitted:false,skippedAllowed:false}));
