import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export function patchAdminLoginMfa(root) {
  const apiPath = path.join(root, "apps/api/dist/server.js");
  const assetsPath = path.join(root, "apps/admin/dist/assets");
  const asset = fs.readdirSync(assetsPath).find((name) => /^index-.*\.js$/.test(name));
  if (!asset) throw new Error("Admin JavaScript bundle not found");
  const clientPath = path.join(assetsPath, asset);

  let api = fs.readFileSync(apiPath, "utf8");
  const importsBefore = `import nodemailer from "nodemailer";`;
  const importsAfter = `import nodemailer from "nodemailer";\nimport QRCode from "qrcode";`;
  if (!api.includes(importsBefore)) throw new Error("Expected production nodemailer import not found");
  api = api.replace(importsBefore, importsAfter);
  const loginBefore = `    if (!user.mfa_required || !user.mfa_secret_encrypted)
        return reply.code(403).send({ error: "mfa_setup_required" });
    const challenge = randomToken();
    await redis.set(\`iam:preauth:\${hashToken(challenge)}\`, JSON.stringify({
        userId: user.id,
        networkHash,
        userAgentHash: hashValue(req.headers["user-agent"] || ""),
    }), "EX", 300, "NX");
    return { mfaRequired: true, challenge };`;
  const loginAfter = `    const challenge = randomToken();
    const preauth = {
        userId: user.id,
        networkHash,
        userAgentHash: hashValue(req.headers["user-agent"] || ""),
    };
    if (!user.mfa_required || !user.mfa_secret_encrypted) {
        const secret = generateTotpSecret();
        preauth.mfaSetupSecret = encryptSecret(secret);
        await redis.set(\`iam:preauth:\${hashToken(challenge)}\`, JSON.stringify(preauth), "EX", 300, "NX");
        const label = encodeURIComponent(user.email), issuer = encodeURIComponent("WB Holding Admin");
        const uri = \`otpauth://totp/\${issuer}:\${label}?secret=\${secret}&issuer=\${issuer}&algorithm=SHA1&digits=6&period=30\`;
        return {
            mfaRequired: true,
            mfaSetupRequired: true,
            challenge,
            secret,
            uri,
            qrDataUrl: await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2, width: 240 }),
        };
    }
    await redis.set(\`iam:preauth:\${hashToken(challenge)}\`, JSON.stringify(preauth), "EX", 300, "NX");
    return { mfaRequired: true, challenge };`;
  if (!api.includes(loginBefore)) throw new Error("Expected production login block not found");
  api = api.replace(loginBefore, loginAfter);

  const verifyBefore = `        valid = Boolean(user.mfa_secret_encrypted &&
            verifyTotp(decryptSecret(user.mfa_secret_encrypted), parsed.data.code));`;
  const verifyAfter = `        const encryptedSecret = preauth.mfaSetupSecret || user.mfa_secret_encrypted;
        valid = Boolean(encryptedSecret &&
            verifyTotp(decryptSecret(encryptedSecret), parsed.data.code));`;
  if (!api.includes(verifyBefore)) throw new Error("Expected production TOTP verification block not found");
  api = api.replace(verifyBefore, verifyAfter);

  const recoveryBefore = `    else {
        const codeHash = hashToken(parsed.data.code.trim().toUpperCase()), used = await query("UPDATE iam.recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id", [user.id, codeHash]);`;
  const recoveryAfter = `    else if (!preauth.mfaSetupSecret) {
        const codeHash = hashToken(parsed.data.code.trim().toUpperCase()), used = await query("UPDATE iam.recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id", [user.id, codeHash]);`;
  if (!api.includes(recoveryBefore)) throw new Error("Expected production recovery-code block not found");
  api = api.replace(recoveryBefore, recoveryAfter);

  const persistBefore = `    await redis.del(key);
    await redis.del(mfaRateKey);
    await query("UPDATE iam.users SET failed_attempts=0,locked_until=NULL WHERE id=$1", [user.id]);`;
  const persistAfter = `    if (preauth.mfaSetupSecret) {
        const enrolled = await query("UPDATE iam.users SET mfa_required=true,mfa_secret_encrypted=$1,updated_at=now() WHERE id=$2 AND mfa_secret_encrypted IS NULL RETURNING id", [preauth.mfaSetupSecret, user.id]);
        if (!enrolled.rowCount) {
            await redis.del(key);
            return reply.code(409).send({ error: "mfa_setup_changed" });
        }
        await audit({ auth: { userId: user.id }, id: req.id }, "mfa_self_enrollment", "user", user.id, ["mfa_required"]);
    }
    await redis.del(key);
    await redis.del(mfaRateKey);
    await query("UPDATE iam.users SET failed_attempts=0,locked_until=NULL WHERE id=$1", [user.id]);`;
  if (!api.includes(persistBefore)) throw new Error("Expected production MFA completion block not found");
  api = api.replace(persistBefore, persistAfter);
  fs.writeFileSync(apiPath, api);

  let client = fs.readFileSync(clientPath, "utf8");
  const replacements = [
    ["M(F.challenge),C(\"mfa\")", "M(F),C(\"mfa\")"],
    ["{challenge:R,code:X.get(\"code\")}", "{challenge:R.challenge,code:X.get(\"code\")}"],
    ["children:\"Zwei-Faktor-Authentifizierung\"}),i.jsx(\"p\",{children:\"Geben Sie den sechsstelligen Code Ihrer Authenticator-App oder einen gültigen Wiederherstellungscode ein.\"})", "children:\"Zwei-Faktor-Authentifizierung\"}),R.mfaSetupRequired&&i.jsxs(i.Fragment,{children:[i.jsx(\"p\",{className:\"notice\",children:\"Richten Sie jetzt die verpflichtende Zwei-Faktor-Authentifizierung in Ihrer Authenticator-App ein. Eine Sitzung wird erst nach erfolgreicher Codeprüfung erstellt.\"}),i.jsx(\"img\",{src:R.qrDataUrl,alt:\"QR-Code für die Authenticator-App\",width:240,height:240}),i.jsxs(\"label\",{children:[\"Manueller Schlüssel\",i.jsx(\"input\",{readOnly:!0,value:R.secret})]}),i.jsxs(\"label\",{children:[\"Konfigurations-URI\",i.jsx(\"textarea\",{readOnly:!0,value:R.uri})]})]}),i.jsx(\"p\",{children:R.mfaSetupRequired?\"Geben Sie zur Bestätigung den sechsstelligen Code Ihrer Authenticator-App ein.\":\"Geben Sie den sechsstelligen Code Ihrer Authenticator-App oder einen gültigen Wiederherstellungscode ein.\"})"],
  ];
  for (const [before, after] of replacements) {
    if (!client.includes(before)) throw new Error(`Expected production client marker not found: ${before.slice(0, 48)}`);
    client = client.replace(before, after);
  }
  fs.writeFileSync(clientPath, client);
  const fingerprint = crypto.createHash("sha256").update(client).digest("hex").slice(0, 10);
  const fingerprintedClientPath = path.join(assetsPath, `index-${fingerprint}.js`);
  const htmlPath = path.join(root, "apps/admin/dist/index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  if (!html.includes(`assets/${asset}`)) throw new Error("Expected production HTML asset reference not found");
  fs.writeFileSync(htmlPath, html.replace(`assets/${asset}`, `assets/${path.basename(fingerprintedClientPath)}`));
  fs.renameSync(clientPath, fingerprintedClientPath);
  return { apiPath, clientPath: fingerprintedClientPath, htmlPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  patchAdminLoginMfa(process.argv[2] || "/app");
}
