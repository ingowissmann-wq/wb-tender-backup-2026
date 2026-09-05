#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

for (const name of ["E2E_EMAIL", "E2E_PASSWORD", "E2E_TOTP"]) if (String(process.env[name] || "")) throw new Error(`inline_secret_forbidden_${name.toLowerCase()}`);
const baseUrl = String(process.env.PRODUCTION_BASE_URL || "").replace(/\/$/, "");
const uiBase = String(process.env.TENDER_UI_BASE || "/admin/ausschreibungen");
const apiBase = String(process.env.TENDER_API_BASE || "/api/tender");
let parsedBase;
try { parsedBase = new URL(baseUrl); } catch { throw new Error("production_base_url_invalid"); }
if (!baseUrl || (parsedBase.protocol !== "https:" && process.env.ALLOW_LOOPBACK_HTTP !== "true")) throw new Error("production_base_url_https_required");
if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash || parsedBase.pathname !== "/" || parsedBase.origin !== baseUrl) throw new Error("production_base_url_must_be_origin_only");
for (const [name, value] of [["tender_ui_base", uiBase], ["tender_api_base", apiBase]]) if (!/^\/(?:[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*(?:\/[A-Za-z0-9_~-]+(?:\.[A-Za-z0-9_~-]+)*)*)?$/.test(value)
    || value === "/" || value.endsWith("/") || value.includes("//")) throw new Error(`${name}_invalid`);
const readSecret = (name) => {
  const pathname = String(process.env[`${name}_FILE`] || "");
  if (!path.isAbsolute(pathname)) throw new Error(`${name.toLowerCase()}_file_required`);
  const stat = fs.lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600) throw new Error(`${name.toLowerCase()}_file_must_be_root_owned_mode_0600`);
  return fs.readFileSync(pathname, "utf8").trim();
};
const email = readSecret("E2E_EMAIL"), password = readSecret("E2E_PASSWORD"), totpSecret = readSecret("E2E_TOTP");
const base32 = (value) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("totp_secret_invalid");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
};
const totp = () => {
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = crypto.createHmac("sha1", base32(totpSecret)).update(input).digest(), offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const authRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.includes("/iam/")) authRequests.push(url.pathname);
  });
  const returnTo = `${uiBase}/?productionIamCanary=1`;
  await page.goto(`${baseUrl}${uiBase}/login?returnTo=${encodeURIComponent(returnTo)}`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("E-Mail").fill(email);
  await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Weiter" }).click();
  await page.getByLabel("Authenticator-Code").waitFor({ state: "visible" });
  assert.equal((await context.cookies()).some((cookie) => cookie.name === "wb_session"), false, "password step created a session before MFA");
  await page.getByLabel("Authenticator-Code").fill(totp());
  await Promise.all([
    page.waitForURL(`${baseUrl}${returnTo}`),
    page.getByRole("button", { name: "Sicher anmelden" }).click(),
  ]);
  assert.deepEqual(authRequests, [`${apiBase}/iam/login`, `${apiBase}/iam/mfa`]);
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "wb_session");
  assert.ok(session?.httpOnly && session.secure && session.sameSite === "Strict", "authenticated session cookie contract failed");
  const health = await context.request.get(`${baseUrl}${apiBase}/healthz`);
  assert.equal(health.status(), 200, "configured public API prefix health failed");
  console.log(JSON.stringify({ passed: true, passwordMfaReturnTo: true, noManualReload: true, uiBase, apiBase, authenticatedReadOnly: true, businessWrites: 0, externalSubmission: false, secretsLogged: false }));
} finally {
  await browser.close();
}
