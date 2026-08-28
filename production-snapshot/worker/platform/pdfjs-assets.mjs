import { readFileSync } from "node:fs";

const moduleBody = readFileSync(
  new URL("../node_modules/pdfjs-dist/build/pdf.min.mjs", import.meta.url),
);
const workerBody = readFileSync(
  new URL("../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
);

const assets = Object.freeze([
  ["/pdfjs/pdf.mjs", moduleBody],
  ["/pdfjs/pdf.worker.mjs", workerBody],
]);

export function registerLocalPdfJsAssets(app, authenticate) {
  for (const [path, body] of assets) {
    const handler = async (_, reply) =>
      reply
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .type("application/javascript")
        .send(body);
    if (authenticate) app.get(path, authenticate, handler);
    else app.get(path, handler);
  }
}
