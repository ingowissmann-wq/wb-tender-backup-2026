#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const services = ["api", "worker", "scheduler"];
const [beforeDirectory, outputFile] = process.argv.slice(2);

if (!beforeDirectory || !path.isAbsolute(beforeDirectory) || !outputFile || !path.isAbsolute(outputFile)) {
  throw new Error("absolute before directory and output file are required");
}

const override = { services: {} };
for (const service of services) {
  const image = (await readFile(path.join(beforeDirectory, `${service}.image-id`), "utf8")).trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`invalid prior image ID: ${service}`);

  let command;
  try {
    command = JSON.parse(await readFile(path.join(beforeDirectory, `${service}.command.json`), "utf8"));
  } catch {
    throw new Error(`invalid prior command JSON: ${service}`);
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((argument) => typeof argument !== "string")) {
    throw new Error(`invalid prior command: ${service}`);
  }
  override.services[service] = { image, command };
}

await writeFile(outputFile, `${JSON.stringify(override, null, 2)}\n`, { flag: "wx", mode: 0o600 });
