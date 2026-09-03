import { createServer } from "node:http";
createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/v1/health") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ system: "WIKOS", partner: "KYNTRIVEX", readOnly: true }));
}).listen(8080, "0.0.0.0");
