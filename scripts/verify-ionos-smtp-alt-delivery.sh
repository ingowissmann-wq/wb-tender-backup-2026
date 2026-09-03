#!/usr/bin/env bash
set -Eeuo pipefail

API=wb-tender-production-api
SECRET=/srv/wb-tender-production/secrets/ionos-smtp-password
SENDER=admin@wb-holding.ag
RECIPIENT=ingo.wissmann@wb-holding.ag
IMAGE=$(docker inspect "$API" --format '{{.Config.Image}}')

test "$(id -u)" -eq 0
test -s "$SECRET"
test -n "$IMAGE"
docker image inspect "$IMAGE" >/dev/null

docker run --rm --network host --user 0:0 \
  -v "$SECRET:/run/secrets/ionos-smtp-password:ro" \
  --entrypoint node "$IMAGE" --input-type=module - <<'NODE'
import fs from "node:fs";
import nodemailer from "nodemailer";

const sender = "admin@wb-holding.ag";
const recipient = "ingo.wissmann@wb-holding.ag";
const password = fs.readFileSync("/run/secrets/ionos-smtp-password", "utf8");
const transport = nodemailer.createTransport({
  host: "smtp.ionos.de",
  port: 465,
  secure: true,
  auth: { user: sender, pass: password },
  requireTLS: true,
  tls: { minVersion: "TLSv1.2", servername: "smtp.ionos.de" },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
  disableFileAccess: true,
  disableUrlAccess: true
});
await transport.verify();
const result = await transport.sendMail({
  envelope: { from: sender, to: [recipient] },
  from: `WB Tender <${sender}>`,
  to: recipient,
  replyTo: sender,
  subject: "WB Tender – externer Zustelltest",
  text: "Dies ist der Zustelltest für den Passwort-Reset des WB-Tender-Portals. Bitte diese Nachricht nicht beantworten.",
  html: "<p>Dies ist der Zustelltest für den Passwort-Reset des <strong>WB-Tender-Portals</strong>.</p><p>Bitte diese Nachricht nicht beantworten.</p>"
});
if (!result.accepted?.some(value => value.toLowerCase() === recipient)) {
  throw new Error("recipient_not_accepted");
}
console.log("smtp_verify=ok");
console.log("recipient_accepted=true");
console.log("recipient=ingo.wissmann@wb-holding.ag");
console.log("message_id_present=" + Boolean(result.messageId));
transport.close();
NODE

printf '%s\n' 'WB_IONOS_SMTP_ALT_DELIVERY_TEST=SUCCESS'
printf '%s\n' 'secret_printed=false'
printf '%s\n' 'application_changed=false'
printf '%s\n' 'database_changed=false'
printf '%s\n' 'external_submission_changed=false'
