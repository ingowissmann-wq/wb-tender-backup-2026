#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const fail = (message) => { console.error(message); process.exit(78); };
const base = String(process.env.PRODUCTION_BASE_URL || "").replace(/\/$/, "");
const apiBase = String(process.env.TENDER_API_BASE || "/api/tender");
const sessionFile = String(process.env.PRODUCTION_SESSION_FILE || "");
let parsedBase;
try { parsedBase = new URL(base); } catch { fail("production base URL is invalid"); }
const loopbackHttp = process.env.ALLOW_LOOPBACK_HTTP === "true" && ["127.0.0.1", "::1", "localhost"].includes(parsedBase.hostname);
if (parsedBase.protocol !== "https:" && !loopbackHttp) fail("production base URL must use HTTPS");
if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash || parsedBase.pathname !== "/" || parsedBase.origin !== base) fail("production base URL must be origin-only");
if (!/^\/(?:[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*(?:\/[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*)*)?$/.test(apiBase)
    || apiBase === "/" || apiBase.endsWith("/") || apiBase.includes("//")) fail("tender API base path is invalid");
const stat = fs.lstatSync(sessionFile);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) > 0o600) fail("production session file must be root-owned mode 0600 or stricter");
const config = fs.readFileSync(sessionFile, "utf8");
const lines = config.split(/\r?\n/).filter(Boolean);
if (lines.length !== 2 || !lines.some((line) => /^cookie\s*=\s*"[^"\r\n]*wb_session=[^";\s]+[^"\r\n]*wb_csrf=[^";\s]+[^"\r\n]*"$/.test(line)) || !lines.some((line) => /^header\s*=\s*"x-csrf-token: [A-Za-z0-9_-]{32,512}"$/i.test(line))) fail("production session file has an invalid exact curl-config shape");
const tempDirectory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "wb-tender-http-gate-"));
const temp = path.join(tempDirectory, "response.json");
try {
  const health = spawnSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "15", `${base}${apiBase}/healthz`], { encoding: "utf8" });
  if (health.status !== 0) fail("real HTTP health probe failed");
  const locked = spawnSync("curl", ["--silent", "--show-error", "--max-time", "30", "--config", sessionFile, "--request", "POST", "--output", temp, "--write-out", "%{http_code}", `${base}${apiBase}/tools/action/transmit`], { encoding: "utf8" });
  if (locked.status !== 0 || locked.stdout !== "423") fail(`authenticated external-action probe did not return HTTP 423 (${locked.stdout || "curl_failed"})`);
  const body = JSON.parse(fs.readFileSync(temp, "utf8"));
  if (body.external_submission_enabled !== false || body.transmitted !== false) fail("HTTP 423 response did not prove the external submission lock");
  console.log(JSON.stringify({ passed: true, health: "real-http", authenticated: true, externalActionPayload: "none", httpStatus: 423, external_submission_enabled: false, transmitted: false }));
} finally {
  try { if (fs.existsSync(temp)) fs.writeFileSync(temp, "", { mode: 0o600 }); fs.rmSync(tempDirectory, { recursive: true }); } catch {}
}
