import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

for (const workerPath of [
  "../platform/autopilot-pipeline-worker.mjs",
  "../deployment/context-portal-readiness-128-overlay/platform/autopilot-pipeline-worker.mjs",
]) {
  const workerUrl = new URL(workerPath, import.meta.url);
  if (!fs.existsSync(workerUrl)) continue;
  test(`portal document pages isolate non-document child links: ${workerPath}`, () => {
    const source = fs.readFileSync(workerUrl, "utf8");
    const start = source.indexOf("async function processDocuments");
    const end = source.indexOf("function extractedSegments", start);
    assert.ok(start >= 0 && end > start);
    const implementation = source.slice(start, end);
    assert.match(implementation, /if \(error\?\.code !== "DOCUMENT_TYPE_REJECTED"\) throw error/);
    assert.match(implementation, /rejectedNonDocumentLinkCount/);
    assert.match(implementation, /documentListReviewRequired/);
    assert.match(implementation, /path: rejectedUrl\.pathname\.slice\(0, 240\)/);
    assert.doesNotMatch(implementation, /rejectedUrl\.href/);
    assert.match(source, /rejectedDocumentTypeCount/);
    assert.match(source, /documentsDownloaded: succeeded/);
    assert.match(source, /documentsFailed: failed/);
  });
}
