import { parentPort, workerData } from "node:worker_threads";
import { parseBinaryDocument } from "./binary-parsers.mjs";

try {
  const input = {
    ...workerData.input,
    buffer: Buffer.from(workerData.input.buffer),
  };
  parentPort.postMessage({ ok: true, result: await parseBinaryDocument(input) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      code: error?.message || "parser_failed",
      name: error?.name || "Error",
    },
  });
}
