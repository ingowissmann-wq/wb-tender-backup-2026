import test from "node:test";
import assert from "node:assert/strict";
import { patchPasswordResetMail, MARKER } from "../integrations/wb-admin-portal/candidate/tender-password-reset-mail-patch.mjs";

const transport = `function systemMailTransport() {
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

const fixture = `${transport}\nconst origin = String(process.env.PUBLIC_ORIGIN || "https://admin.wb-holding.ag").replace(/\\/+$/, ""), url = \`${'${origin}'}/admin/?reset=${'${encodeURIComponent(raw)}'}\`;\nfrom: process.env.SYSTEM_MAIL_FROM || "bewerbung@wb-holding.ag",\nsubject: "Passwort für das WB Adminportal zurücksetzen",`;

test("uses a secret file and the Tender reset URL", () => {
  const patched = patchPasswordResetMail(fixture);
  assert.match(patched, new RegExp(MARKER));
  assert.match(patched, /SMTP_PASSWORD_FILE/);
  assert.ok(patched.includes("/admin/ausschreibungen/login?reset="));
  assert.ok(patched.includes('process.env.SMTP_USER || "admin@wb-holding.ag"'));
  assert.equal(patchPasswordResetMail(patched), patched);
});

test("refuses an unknown runtime", () => {
  assert.throws(() => patchPasswordResetMail("unknown"), /transport_marker_count_0/);
});
