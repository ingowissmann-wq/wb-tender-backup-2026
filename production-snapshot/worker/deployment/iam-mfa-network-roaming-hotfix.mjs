import fs from "node:fs";

const target = "/app/apps/api/dist/server.js";
const source = fs.readFileSync(target, "utf8");
const before = `    if (preauth.networkHash !== hashValue(ipPrefix(req.ip)) ||
        preauth.userAgentHash !== hashValue(req.headers["user-agent"] || ""))
        return reply.code(401).send({ error: "invalid_mfa" });`;
const after = `    // A TOTP challenge must survive legitimate network changes between the
    // password and MFA requests (for example Safari Private Relay or mobile
    // handoff). The random, short-lived, one-time challenge remains bound to
    // the initiating browser user agent and protected by MFA rate limits.
    if (preauth.userAgentHash !== hashValue(req.headers["user-agent"] || ""))
        return reply.code(401).send({ error: "invalid_mfa" });`;

if (!source.includes(before)) {
  throw new Error("Expected production MFA pre-auth guard was not found");
}
const updated = source.replace(before, after);
if (updated === source || updated.includes(before)) {
  throw new Error("MFA pre-auth guard replacement failed");
}
fs.writeFileSync(target, updated);

