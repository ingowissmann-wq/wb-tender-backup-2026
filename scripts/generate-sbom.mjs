import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const components = Object.entries(packageJson.dependencies || {})
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, version]) => ({
    type: "library",
    name,
    version,
    purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
  }));
const serial = crypto.createHash("sha256").update(JSON.stringify(components)).digest("hex");
console.log(JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${serial.slice(0, 8)}-${serial.slice(8, 12)}-4${serial.slice(13, 16)}-a${serial.slice(17, 20)}-${serial.slice(20, 32)}`,
  version: 1,
  metadata: { component: { type: "application", name: packageJson.name, version: packageJson.version } },
  components,
}, null, 2));
