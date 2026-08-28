import { readFileSync } from "node:fs";
import pg from "pg";
import { SmtpEmailAdapter, UnconfiguredEmailAdapter } from "./saas-adapters.mjs";
import { processTrialLifecycle, normalizeReminderOffsets } from "./trial-lifecycle.mjs";

for (const name of ["EXTERNAL_SUBMISSION_ENABLED", "WB_TENDER_ALLOW_EXTERNAL_SUBMISSION"])
  if (process.env[name] !== "false") throw new Error(`${name.toLowerCase()}_must_be_literal_false`);

const secretFile = (name) => process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], "utf8").trim() : "";
const connectionString = secretFile("SAAS_TRIAL_DATABASE_URL") || secretFile("DATABASE_URL");
if (!connectionString) throw new Error("trial_worker_database_url_file_missing");
const upgradeUrl = process.env.SAAS_UPGRADE_URL;
if (!/^https:\/\//.test(String(upgradeUrl || ""))) throw new Error("trial_upgrade_url_invalid");
const offsets = normalizeReminderOffsets(process.env.SAAS_TRIAL_REMINDER_OFFSETS || "5,2");
const emailAdapter = process.env.SAAS_EMAIL_ADAPTER === "smtp" ? new SmtpEmailAdapter({
  host: secretFile("SAAS_SMTP_HOST"), port: secretFile("SAAS_SMTP_PORT") || 587,
  secure: secretFile("SAAS_SMTP_SECURE") === "true", user: secretFile("SAAS_SMTP_USER"),
  password: secretFile("SAAS_SMTP_PASSWORD"), from: secretFile("SAAS_SMTP_FROM"), verificationBaseUrl: upgradeUrl,
}) : new UnconfiguredEmailAdapter();
const pool = new pg.Pool({ connectionString, max: 4 });
try {
  const result = await processTrialLifecycle(pool, { emailAdapter, upgradeUrl, reminderOffsets: offsets, workerId: process.env.WORKER_ID || "paid-trial-lifecycle" });
  console.log(JSON.stringify({ component: "paid-trial-lifecycle", ...result, externalSubmissionEnabled: false }));
} finally { await pool.end(); }
