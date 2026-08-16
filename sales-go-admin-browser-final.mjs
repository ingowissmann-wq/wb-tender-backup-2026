import fs from "node:fs";
import { chromium } from "playwright";

const proxyIp = process.env.GREEN_PROXY_IP;
if (!proxyIp) throw new Error("GREEN_PROXY_IP required");
const session = JSON.parse(fs.readFileSync("/tmp/green-admin-session.json", "utf8"));
const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/chromium-browser",
  args: ["--no-sandbox", `--host-resolver-rules=MAP admin.wb-holding.ag ${proxyIp},EXCLUDE localhost`],
});
const results = [];

try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, locale: "de-DE" });
    await context.addCookies([
      { name: "wb_session", value: session.token, url: "https://admin.wb-holding.ag", secure: true, httpOnly: true, sameSite: "Lax" },
      { name: "wb_csrf", value: session.csrf, url: "https://admin.wb-holding.ag", secure: true, sameSite: "Lax" },
    ]);
    const root = await context.newPage();
    await root.goto("https://admin.wb-holding.ag/admin/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    const discovered = await root.locator("a[href^='/admin/']").evaluateAll((links) => [...new Set(links.map((link) => link.href))]);
    await root.close();
    const urls = [...new Set([
      "https://admin.wb-holding.ag/admin/",
      ...discovered,
      "https://admin.wb-holding.ag/admin/ausschreibungen",
      "https://admin.wb-holding.ag/admin/ausschreibungen/autopilot",
    ])];
    for (const url of urls) {
      const page = await context.newPage();
      const consoleErrors = [];
      const requestFailures = [];
      page.on("console", (message) => {
        if (message.type() === "error" && !message.text().includes("Permissions policy violation: compute-pressure")) consoleErrors.push(message.text());
      });
      page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`));
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(750);
      const bodyCharacters = (await page.locator("body").innerText()).trim().length;
      results.push({ viewport: viewport.name, url, finalUrl: page.url(), status: response?.status(), bodyCharacters, consoleErrors, requestFailures });
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const passed = results.length > 0 && results.every((row) => row.status === 200 && row.bodyCharacters > 80 && row.consoleErrors.length === 0 && row.requestFailures.length === 0);
console.log(JSON.stringify({ passed, count: results.length, results }, null, 2));
if (!passed) process.exitCode = 1;
