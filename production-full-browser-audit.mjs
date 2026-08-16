import fs from "node:fs";
import { chromium } from "playwright";

const proxyIp = process.env.GREEN_PROXY_IP;
if (!proxyIp) throw new Error("GREEN_PROXY_IP required");
const session = JSON.parse(fs.readFileSync("/tmp/green-admin-session.json", "utf8"));
const outputDir = process.env.BROWSER_OUTPUT_DIR || "/tmp/production-full-browser-audit";
fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/chromium-browser",
  args: [
    "--no-sandbox",
    `--host-resolver-rules=MAP www.wb-holding.ag ${proxyIp},MAP wb-holding.ag ${proxyIp},MAP admin.wb-holding.ag ${proxyIp},MAP kalkulator.wb-holding.ag ${proxyIp},EXCLUDE localhost`,
  ],
});

const routes = [
  ["website", "https://www.wb-holding.ag/"],
  ["career", "https://www.wb-holding.ag/karriere"],
  ["job", "https://www.wb-holding.ag/karriere/geschaeftsfuehrer-reinigung-m-w-d-augsburg"],
  ["application", "https://www.wb-holding.ag/application?job=geschaeftsfuehrer-reinigung-m-w-d-augsburg"],
  ["calculator", "https://kalkulator.wb-holding.ag/"],
  ["admin", "https://admin.wb-holding.ag/admin/"],
];
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
    for (const [name, url] of routes) {
      const page = await context.newPage();
      const consoleErrors = [];
      const failedRequests = [];
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300)); });
      page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`));
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(1_000);
      await page.evaluate(async () => {
        const step = Math.max(300, Math.floor(window.innerHeight * 0.75));
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        window.scrollTo(0, 0);
      });
      const imageCount = await page.locator("img").count();
      for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
        const image = page.locator("img").nth(imageIndex);
        await image.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(150);
      }
      await page.locator("img").evaluateAll(async (images) => {
        await Promise.all(images.map((image) => image.decode().catch(() => {})));
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1_000);
      const bodyText = (await page.locator("body").innerText()).trim();
      const visibleImages = await page.locator("img:visible").count();
      const brokenImages = await page.locator("img").evaluateAll((images) => images.filter((image) => !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1).length);
      const brokenImageDetails = await page.locator("img").evaluateAll((images) => images
        .filter((image) => !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1)
        .map((image) => ({
          src: image.getAttribute("src"),
          currentSrc: image.currentSrc,
          loading: image.loading,
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          display: getComputedStyle(image).display,
          visibility: getComputedStyle(image).visibility,
        })));
      const finalUrl = page.url();
      await page.screenshot({ path: `${outputDir}/${viewport.name}-${name}.png`, fullPage: true });
      results.push({
        viewport: viewport.name,
        name,
        status: response?.status(),
        finalUrl,
        title: await page.title(),
        bodyCharacters: bodyText.length,
        visibleImages,
        brokenImages,
        brokenImageDetails,
        consoleErrors,
        failedRequests,
      });
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const passed = results.every((row) => row.status === 200
  && row.bodyCharacters > 100
  && row.brokenImages === 0
  && row.consoleErrors.length === 0
  && row.failedRequests.filter((failure) => !failure.includes("www.googletagmanager.com")).length === 0
  && (row.name !== "admin" || !row.finalUrl.includes("login")));
console.log(JSON.stringify({ passed, results, outputDir }, null, 2));
if (!passed) process.exitCode = 1;
