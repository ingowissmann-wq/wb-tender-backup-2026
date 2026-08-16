import fs from "node:fs";
import { chromium } from "playwright";

const proxyIp = process.env.GREEN_PROXY_IP;
if (!proxyIp) throw new Error("GREEN_PROXY_IP required");
const session = JSON.parse(fs.readFileSync("/tmp/green-admin-session.json", "utf8"));
const outputDir = process.env.BROWSER_OUTPUT_DIR || "/tmp/sales-go-comprehensive-browser";
fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/chromium-browser",
  args: [
    "--no-sandbox",
    `--host-resolver-rules=MAP www.wb-holding.ag ${proxyIp},MAP wb-holding.ag ${proxyIp},MAP admin.wb-holding.ag ${proxyIp},MAP kalkulator.wb-holding.ag ${proxyIp},EXCLUDE localhost`,
  ],
});

const output = { public: [], admin: [], textRisks: [], screenshots: [] };
const technicalCopy = /\b(codex|localhost|stack\s*trace|green\s*(?:release|deployment)|blue\s*(?:release|deployment)|phase\s*4|acceptance[- ]code)\b/i;

async function inspect(page, url, group, viewport) {
  const errors = [];
  const failures = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 300)); });
  page.on("requestfailed", (request) => failures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || "failed"}`));
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.75));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, 0);
  });
  const imageCount = await page.locator("img").count();
  for (let index = 0; index < imageCount; index += 1) {
    await page.locator("img").nth(index).scrollIntoViewIfNeeded().catch(() => {});
  }
  await page.locator("img").evaluateAll(async (nodes) => Promise.all(nodes.map((image) => image.decode().catch(() => {}))));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  const text = (await page.locator("body").innerText()).trim();
  const images = await page.locator("img").evaluateAll((nodes) => nodes.map((image) => ({
    src: image.currentSrc || image.src,
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    width: image.getBoundingClientRect().width,
    height: image.getBoundingClientRect().height,
    display: getComputedStyle(image).display,
    visibility: getComputedStyle(image).visibility,
    opacity: getComputedStyle(image).opacity,
  })));
  const visibleImages = images.filter((image) => image.width > 0 && image.height > 0 && image.display !== "none" && image.visibility !== "hidden" && Number(image.opacity) > 0);
  const brokenImages = visibleImages.filter((image) => !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1);
  let embeddedCalculator = null;
  if (new URL(url).pathname === "/preiskalkulator") {
    const frame = page.frames().find((candidate) => candidate.url().startsWith("https://kalkulator.wb-holding.ag/"));
    embeddedCalculator = frame ? { url: frame.url(), bodyCharacters: (await frame.locator("body").innerText()).trim().length } : null;
  }
  const relevantFailures = failures.filter((failure) => !failure.includes("googletagmanager.com") && !failure.includes("connect.facebook.net"));
  const result = { viewport, url, finalUrl: page.url(), status: response?.status(), bodyCharacters: text.length, images: images.length, visibleImages: visibleImages.length, brokenImages, embeddedCalculator, errors, failures: relevantFailures };
  output[group].push(result);
  if (technicalCopy.test(text)) output.textRisks.push({ viewport, url, match: text.match(technicalCopy)?.[0] });
  return result;
}

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
    const sitemapPage = await context.newPage();
    const sitemapText = await (await sitemapPage.request.get("https://www.wb-holding.ag/sitemap.xml")).text();
    const publicUrls = [...new Set([...sitemapText.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]))];
    for (const required of [
      "https://www.wb-holding.ag/",
      "https://www.wb-holding.ag/karriere",
      "https://www.wb-holding.ag/karriere/geschaeftsfuehrer-reinigung-m-w-d-augsburg",
      "https://www.wb-holding.ag/application?job=geschaeftsfuehrer-reinigung-m-w-d-augsburg",
      "https://www.wb-holding.ag/datenschutz",
      "https://kalkulator.wb-holding.ag/",
    ]) if (!publicUrls.includes(required)) publicUrls.push(required);
    await sitemapPage.close();

    for (const url of publicUrls) {
      const page = await context.newPage();
      await inspect(page, url, "public", viewport.name);
      await page.close();
    }

    const root = await context.newPage();
    await inspect(root, "https://admin.wb-holding.ag/admin/", "admin", viewport.name);
    const discovered = await root.locator("a[href^='/admin/']").evaluateAll((links) => [...new Set(links.map((link) => link.href))]);
    const adminUrls = [...new Set([
      ...discovered,
      "https://admin.wb-holding.ag/admin/ausschreibungen",
      "https://admin.wb-holding.ag/admin/ausschreibungen/autopilot",
      "https://admin.wb-holding.ag/admin/ausschreibungen/portale",
      "https://admin.wb-holding.ag/admin/ausschreibungen/einstellungen",
    ])].slice(0, 40);
    await root.close();
    for (const url of adminUrls) {
      if (url === "https://admin.wb-holding.ag/admin/") continue;
      const page = await context.newPage();
      await inspect(page, url, "admin", viewport.name);
      await page.close();
    }
    const shot = await context.newPage();
    await shot.goto("https://admin.wb-holding.ag/admin/ausschreibungen", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await shot.waitForTimeout(800);
    const screenshot = `${outputDir}/${viewport.name}-tender-overview.png`;
    await shot.screenshot({ path: screenshot, fullPage: true });
    output.screenshots.push(screenshot);
    await shot.close();
    await context.close();
  }
} finally {
  await browser.close();
}

const rows = [...output.public, ...output.admin];
output.passed = rows.length > 0 && rows.every((row) => row.status === 200 && row.bodyCharacters > 80 && row.brokenImages.length === 0 && row.errors.length === 0 && row.failures.length === 0 && (new URL(row.url).pathname !== "/preiskalkulator" || (row.embeddedCalculator?.bodyCharacters || 0) > 100));
output.counts = {
  public: output.public.length,
  admin: output.admin.length,
  images: rows.reduce((sum, row) => sum + row.images, 0),
  brokenImages: rows.reduce((sum, row) => sum + row.brokenImages.length, 0),
  consoleErrors: rows.reduce((sum, row) => sum + row.errors.length, 0),
  failedRequests: rows.reduce((sum, row) => sum + row.failures.length, 0),
  technicalCopyRisks: output.textRisks.length,
};
console.log(JSON.stringify(output, null, 2));
if (!output.passed) process.exitCode = 1;
