import fs from "node:fs";

const secretFile = process.env.SMTP_PASSWORD_FILE;
if (!secretFile) throw new Error("smtp_password_file_missing");
const password = fs.readFileSync(secretFile, "utf8").trimEnd();
if (!password) throw new Error("smtp_password_missing");
process.env.SMTP_PASSWORD = password;
process.setgid("node");
process.setuid("node");
await import("/app/apps/api/dist/server.js");
