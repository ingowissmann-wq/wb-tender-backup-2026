import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function patchAdminMfaQr(root) {
  const apiPath = path.join(root, "apps/api/dist/server.js");
  const htmlPath = path.join(root, "apps/admin/dist/index.html");
  const assetsPath = path.join(root, "apps/admin/dist/assets");
  const html = fs.readFileSync(htmlPath, "utf8");
  const assetMatch = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  if (!assetMatch) throw new Error("Referenced Admin JavaScript bundle not found");
  const asset = assetMatch[1];
  const clientPath = path.join(assetsPath, asset);
  if (!fs.existsSync(clientPath)) throw new Error("Referenced Admin JavaScript bundle is missing");

  let api = fs.readFileSync(apiPath, "utf8");
  const importBefore = `import nodemailer from "nodemailer";`;
  if ((api.split(importBefore).length - 1) !== 1) throw new Error("Expected current nodemailer import not found exactly once");
  api = api.replace(importBefore, `${importBefore}\nimport QRCode from "qrcode";`);

  const uriBefore = `        const label = encodeURIComponent(user.email), issuer = encodeURIComponent("WB Holding Admin");
        return {
            mfaRequired: true,
            mfaSetupRequired: true,
            challenge,
            secret,
            uri: \`otpauth://totp/\${issuer}:\${label}?secret=\${secret}&issuer=\${issuer}&algorithm=SHA1&digits=6&period=30\`,
        };`;
  const uriAfter = `        const label = encodeURIComponent(user.email), issuer = encodeURIComponent("WB Holding Admin");
        const uri = \`otpauth://totp/\${issuer}:\${label}?secret=\${secret}&issuer=\${issuer}&algorithm=SHA1&digits=6&period=30\`;
        return {
            mfaRequired: true,
            mfaSetupRequired: true,
            challenge,
            secret,
            uri,
            qrDataUrl: await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2, width: 240 }),
        };`;
  if ((api.split(uriBefore).length - 1) !== 1) throw new Error("Expected current MFA setup response not found exactly once");
  api = api.replace(uriBefore, uriAfter);
  fs.writeFileSync(apiPath, api);

  let client = fs.readFileSync(clientPath, "utf8");
  const clientBefore = `i.jsx("p",{className:"notice",children:"Richten Sie jetzt die verpflichtende Zwei-Faktor-Authentifizierung in Ihrer Authenticator-App ein. Eine Sitzung wird erst nach erfolgreicher Codeprüfung erstellt."}),i.jsxs("label",{children:["Manueller Schlüssel"`;
  const clientAfter = `i.jsx("p",{className:"notice",children:"Richten Sie jetzt die verpflichtende Zwei-Faktor-Authentifizierung in Ihrer Authenticator-App ein. Eine Sitzung wird erst nach erfolgreicher Codeprüfung erstellt."}),i.jsx("img",{src:R.qrDataUrl,alt:"QR-Code für die Authenticator-App",width:240,height:240}),i.jsxs("label",{children:["Manueller Schlüssel"`;
  if ((client.split(clientBefore).length - 1) !== 1) throw new Error("Expected current MFA setup view not found exactly once");
  client = client.replace(clientBefore, clientAfter);

  const fingerprint = crypto.createHash("sha256").update(client).digest("hex").slice(0, 10);
  const fingerprintedAsset = `index-${fingerprint}.js`;
  const fingerprintedClientPath = path.join(assetsPath, fingerprintedAsset);
  fs.writeFileSync(fingerprintedClientPath, client);
  fs.writeFileSync(htmlPath, html.replace(`assets/${asset}`, `assets/${fingerprintedAsset}`));
  fs.unlinkSync(clientPath);
  return { apiPath, clientPath: fingerprintedClientPath, htmlPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  patchAdminMfaQr(process.argv[2] || "/app");
}
