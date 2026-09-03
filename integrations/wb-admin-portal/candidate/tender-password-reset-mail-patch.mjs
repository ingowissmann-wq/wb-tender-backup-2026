import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const MARKER = "WB_TENDER_PASSWORD_RESET_MAIL_V1";

export function patchPasswordResetMail(source) {
  if (source.includes(MARKER)) return source;

  const transportBefore = `function systemMailTransport() {
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"])
        if (!process.env[key])
            throw new Error("smtp_configuration_missing");
    const port = Number(process.env.SMTP_PORT || 587);
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465 || String(process.env.SMTP_SECURE).toLowerCase() === "true",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
}`;
  const transportAfter = `/* ${MARKER} */
function systemMailTransport() {
    const passwordFile = process.env.SMTP_PASSWORD_FILE || "/run/secrets/ionos-smtp-password";
    const password = process.env.SMTP_PASSWORD || (fs.existsSync(passwordFile)
        ? fs.readFileSync(passwordFile, "utf8").trimEnd()
        : "");
    if (!password)
        throw new Error("smtp_password_missing");
    const host = process.env.SMTP_HOST || "smtp.ionos.de";
    const user = process.env.SMTP_USER || "admin@wb-holding.ag";
    const port = Number(process.env.SMTP_PORT || 465);
    return nodemailer.createTransport({
        host,
        port,
        secure: port === 465 || String(process.env.SMTP_SECURE).toLowerCase() === "true",
        auth: { user, pass: password },
        requireTLS: true,
        tls: { minVersion: "TLSv1.2", servername: host },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
        disableFileAccess: true,
        disableUrlAccess: true,
    });
}`;

  const linkBefore = 'const origin = String(process.env.PUBLIC_ORIGIN || "https://admin.wb-holding.ag").replace(/\\/+$/, ""), url = `${origin}/admin/?reset=${encodeURIComponent(raw)}`;';
  const linkAfter = 'const origin = String(process.env.PUBLIC_ORIGIN || "https://www.enwi.online").replace(/\\/+$/, ""), url = `${origin}/admin/ausschreibungen/login?reset=${encodeURIComponent(raw)}`;';
  const subjectBefore = 'subject: "Passwort für das WB Adminportal zurücksetzen",';
  const subjectAfter = 'subject: "Passwort für WB Tender zurücksetzen",';
  const fromBefore = 'from: process.env.SYSTEM_MAIL_FROM || "bewerbung@wb-holding.ag",';
  const fromAfter = 'from: process.env.SYSTEM_MAIL_FROM || process.env.SMTP_USER || "admin@wb-holding.ag",';

  for (const [name, before] of [["transport", transportBefore], ["link", linkBefore], ["subject", subjectBefore], ["from", fromBefore]]) {
    const count = source.split(before).length - 1;
    if (count !== 1) throw new Error(`${name}_marker_count_${count}`);
  }
  source = source.replace(transportBefore, transportAfter);
  source = source.replace(linkBefore, linkAfter);
  source = source.replace(subjectBefore, subjectAfter);
  source = source.replace(fromBefore, fromAfter);
  if (!source.includes(MARKER) || !source.includes("SMTP_PASSWORD_FILE") || !source.includes("/admin/ausschreibungen/login?reset="))
    throw new Error("password_reset_mail_patch_verification_failed");
  return source;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error("server_path_required");
  fs.writeFileSync(file, patchPasswordResetMail(fs.readFileSync(file, "utf8")));
}
