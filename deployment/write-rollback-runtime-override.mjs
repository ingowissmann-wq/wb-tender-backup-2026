#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const services = ["api", "worker", "scheduler"];
const [beforeDirectory, outputFile, candidateComposeFile] = process.argv.slice(2);

if (!beforeDirectory || !path.isAbsolute(beforeDirectory) || !outputFile || !path.isAbsolute(outputFile)
    || !candidateComposeFile || !path.isAbsolute(candidateComposeFile)) {
  throw new Error("absolute before directory, output file and candidate compose file are required");
}

const candidateCompose = JSON.parse(await readFile(candidateComposeFile, "utf8"));
const rollbackServices = [];
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
  let priorEnvironment;
  try {
    priorEnvironment = JSON.parse(await readFile(path.join(beforeDirectory, `${service}.environment.json`), "utf8"));
  } catch {
    throw new Error(`invalid prior environment JSON: ${service}`);
  }
  if (!Array.isArray(priorEnvironment) || priorEnvironment.some((entry) => typeof entry !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry))) {
    throw new Error(`invalid prior environment: ${service}`);
  }
  const environment = {};
  for (const entry of priorEnvironment) {
    const separator = entry.indexOf("=");
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  const candidateEnvironment = candidateCompose?.services?.[service]?.environment;
  if (!candidateEnvironment || typeof candidateEnvironment !== "object" || Array.isArray(candidateEnvironment)) {
    throw new Error(`invalid candidate environment: ${service}`);
  }
  for (const name of Object.keys(candidateEnvironment)) if (!(name in environment)) environment[name] = null;
  rollbackServices.push({ service, image, command, environment });
}

const lines = ["services:"];
for (const { service, image, command, environment } of rollbackServices) {
  lines.push(`  ${service}:`, `    image: ${JSON.stringify(image)}`, `    command: ${JSON.stringify(command)}`, "    environment:");
  for (const [name, value] of Object.entries(environment)) {
    lines.push(`      ${JSON.stringify(name)}: ${value === null ? "!reset null" : JSON.stringify(value)}`);
  }
}
await writeFile(outputFile, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
