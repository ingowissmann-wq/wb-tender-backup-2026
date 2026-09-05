import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const keyFile = process.env.TLS_KEY_FILE;
const certFile = process.env.TLS_CERT_FILE;
if (!keyFile || !certFile) throw new Error("tls_file_configuration_required");
const upstream = new URL(process.env.TLS_PROXY_UPSTREAM || "http://api:4240");
const stripUiBase = process.env.TLS_PROXY_STRIP_UI_BASE || "";
if (stripUiBase && !/^\/[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.-]+)*$/.test(stripUiBase)) throw new Error("tls_proxy_strip_ui_base_invalid");
const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (request, response) => {
  const incoming = new URL(request.url, "https://rehearsal.invalid");
  // Preserve the bare public base so the application's canonical 308 route is
  // exercised; strip only paths below it, matching the location-with-slash proxy.
  const stripUi = stripUiBase && incoming.pathname.startsWith(`${stripUiBase}/`);
  const forwardedPath = stripUi ? `${incoming.pathname.slice(stripUiBase.length) || "/"}${incoming.search}` : request.url;
  const forwarded = http.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: request.method,
    path: forwardedPath,
    headers: { ...request.headers, host: upstream.host, "x-forwarded-proto": "https" },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  forwarded.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end('{"error":"rehearsal_proxy_unavailable"}');
  });
  request.pipe(forwarded);
});
server.listen(4443, "0.0.0.0");
