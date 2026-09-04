import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const keyFile = process.env.TLS_KEY_FILE;
const certFile = process.env.TLS_CERT_FILE;
if (!keyFile || !certFile) throw new Error("tls_file_configuration_required");
const upstream = new URL(process.env.TLS_PROXY_UPSTREAM || "http://api:4240");
const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (request, response) => {
  const forwarded = http.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: request.method,
    path: request.url,
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
