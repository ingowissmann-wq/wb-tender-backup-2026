import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchAdminMfaQr } from "../integrations/wb-admin-portal/candidate/admin-mfa-qr-patch.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-admin-mfa-qr-"));
  const apiDir = path.join(root, "apps/api/dist");
  const adminDir = path.join(root, "apps/admin/dist");
  const assetsDir = path.join(adminDir, "assets");
  fs.mkdirSync(apiDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(adminDir, "index.html"), '<script type="module" src="/admin/assets/index-current.js"></script>');
  fs.writeFileSync(path.join(apiDir, "server.js"), `import nodemailer from "nodemailer";
async function login(user) {
        const label = encodeURIComponent(user.email), issuer = encodeURIComponent("WB Holding Admin");
        return {
            mfaRequired: true,
            mfaSetupRequired: true,
            challenge,
            secret,
            uri: \`otpauth://totp/\${issuer}:\${label}?secret=\${secret}&issuer=\${issuer}&algorithm=SHA1&digits=6&period=30\`,
        };
}`);
  fs.writeFileSync(path.join(assetsDir, "index-current.js"), `R.mfaSetupRequired&&i.jsxs(i.Fragment,{children:[i.jsx("p",{className:"notice",children:"Richten Sie jetzt die verpflichtende Zwei-Faktor-Authentifizierung in Ihrer Authenticator-App ein. Eine Sitzung wird erst nach erfolgreicher Codeprüfung erstellt."}),i.jsxs("label",{children:["Manueller Schlüssel",i.jsx("input",{readOnly:!0,value:R.secret})]})]})`);
  return root;
}

test("adds a fingerprinted visible QR image to the current Canary MFA build", () => {
  const root = fixture();
  try {
    const result = patchAdminMfaQr(root);
    const api = fs.readFileSync(result.apiPath, "utf8");
    const client = fs.readFileSync(result.clientPath, "utf8");
    const html = fs.readFileSync(result.htmlPath, "utf8");
    assert.match(api, /import QRCode from "qrcode"/);
    assert.match(api, /qrDataUrl: await QRCode\.toDataURL\(uri/);
    assert.match(client, /src:R\.qrDataUrl/);
    assert.match(client, /alt:"QR-Code für die Authenticator-App"/);
    assert.doesNotMatch(html, /index-current\.js/);
    assert.match(html, new RegExp(path.basename(result.clientPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(fs.existsSync(path.join(root, "apps/admin/dist/assets/index-current.js")), false);
    assert.throws(() => patchAdminMfaQr(root), /Expected current/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
