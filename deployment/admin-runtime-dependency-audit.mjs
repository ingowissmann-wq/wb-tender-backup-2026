import fs from "node:fs";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";

const root = "/app/apps/api/dist";
const requireFromApp = createRequire("/app/package.json");
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(candidate);
    return entry.isFile() && entry.name.endsWith(".js") ? [candidate] : [];
  });
}

const specifiers = new Set();
const patterns = [
  /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

for (const file of files(root)) {
  const source = fs.readFileSync(file, "utf8");
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
}

const external = [...specifiers]
  .filter((name) =>
    !name.startsWith(".") &&
    !name.startsWith("/") &&
    !name.startsWith("file:") &&
    !name.startsWith("data:") &&
    !builtins.has(name)
  )
  .sort();

const missing = [];

for (const name of external) {
  try {
    requireFromApp.resolve(name);
    console.log(`${name}|present`);
  } catch {
    missing.push(name);
    console.error(`${name}|missing`);
  }
}

console.log(`compiled_admin_external_dependencies=${external.length}`);
console.log(`compiled_admin_missing_dependencies=${missing.length}`);

if (missing.length) process.exit(1);
