import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import Fastify from "fastify";
import { registerLocalPdfJsAssets } from "../platform/pdfjs-assets.mjs";

const base = "/admin/ausschreibungen";

test("base-path proxy exposes local PDF.js module and worker with JavaScript MIME", async (t) => {
  const app = Fastify();
  registerLocalPdfJsAssets(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  const proxy = createServer(async (request, response) => {
    const publicUrl = new URL(request.url, "http://proxy.test");
    if (!publicUrl.pathname.startsWith(`${base}/`)) {
      response.statusCode = 404;
      return response.end();
    }
    const upstreamPath = publicUrl.pathname.slice(base.length) + publicUrl.search;
    const upstream = await fetch(`http://127.0.0.1:${app.server.address().port}${upstreamPath}`);
    response.statusCode = upstream.status;
    for (const [name, value] of upstream.headers) response.setHeader(name, value);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());

  const origin = `http://127.0.0.1:${proxy.address().port}`;
  for (const [path, signature] of [
    ["pdf.mjs", "GlobalWorkerOptions"],
    ["pdf.worker.mjs", "WorkerMessageHandler"],
  ]) {
    const response = await fetch(`${origin}${base}/pdfjs/${path}`);
    const body = await response.text();
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /^application\/javascript\b/, path);
    assert.match(response.headers.get("cache-control"), /immutable/, path);
    assert.ok(body.includes(signature), `${path} is the packaged local PDF.js asset`);
  }
});

test("PDF.js assets are app-internal routes, not double-prefixed routes", async () => {
  const app = Fastify();
  registerLocalPdfJsAssets(app);
  const internal = await app.inject({ method: "GET", url: "/pdfjs/pdf.mjs" });
  const doublePrefixed = await app.inject({ method: "GET", url: `${base}/pdfjs/pdf.mjs` });
  assert.equal(internal.statusCode, 200);
  assert.match(internal.headers["content-type"], /^application\/javascript\b/);
  assert.equal(doublePrefixed.statusCode, 404);
  await app.close();
});

test("immutable PDF.js vendor assets do not depend on an authenticated UI session", async () => {
  const app = Fastify();
  registerLocalPdfJsAssets(app);
  const response = await app.inject({ method: "GET", url: "/pdfjs/pdf.worker.mjs" });
  assert.equal(response.statusCode, 200);
  await app.close();
});
