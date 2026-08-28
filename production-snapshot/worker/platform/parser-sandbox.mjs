import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./parser-worker.mjs", import.meta.url);

export function parseBinaryDocumentIsolated(input, options = {}) {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs || 15_000), 100), 30_000);
  const buffer = Buffer.from(input.buffer || []);
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { input: { ...input, buffer } },
      resourceLimits: {
        maxOldGenerationSizeMb: Math.min(Number(options.maxOldGenerationSizeMb || 192), 256),
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    const timer = setTimeout(async () => {
      await worker.terminate();
      reject(new Error("parser_timeout"));
    }, timeoutMs);
    worker.once("message", (message) => {
      clearTimeout(timer);
      if (message.ok) resolve(message.result);
      else reject(Object.assign(new Error(message.error.code), { name: message.error.name }));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error("parser_worker_failed"));
      }
    });
  });
}
