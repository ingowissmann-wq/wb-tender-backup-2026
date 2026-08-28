import fs from "node:fs";
import { verifyTotp } from "/app/apps/api/dist/security.js";

const source = fs.readFileSync("/app/apps/api/dist/server.js", "utf8");
const start = source.indexOf("const preauth = JSON.parse(raw)");
const block = source.slice(start, source.indexOf("const result = await query", start));
const required = [
  '"EX", 300, "NX"',
  "if (mfaAttempts > 8)",
  "iam:totp-used:",
  "await redis.del(key)",
];

if (block.includes("preauth.networkHash")) throw new Error("IP binding remains");
if (block.includes("preauth.userAgentHash") === false) throw new Error("UA binding missing");
for (const invariant of required) {
  if (source.includes(invariant) === false) throw new Error(`Missing invariant: ${invariant}`);
}

const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
if (verifyTotp(rfcSecret, "287082", 59_000) === false) throw new Error("Current TOTP rejected");
if (verifyTotp(rfcSecret, "287082", 89_000) === false) throw new Error("Adjacent TOTP rejected");
if (verifyTotp(rfcSecret, "287082", 119_000)) throw new Error("Out-of-window TOTP accepted");

console.log("MFA protocol security invariants passed");
