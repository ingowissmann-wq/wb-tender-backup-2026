#!/usr/bin/env bash
set -Eeuo pipefail

API=wb-tender-production-api
SMTP_USER=admin@wb-holding.ag
SMTP_HOST=smtp.ionos.de
SMTP_PORT=465
SECRET_DIR=/srv/wb-tender-production/secrets
SECRET_FILE="$SECRET_DIR/ionos-smtp-password"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d "/srv/wb-tender-recovery/admin-runtime-rehearsal-4/ionos-smtp-test-${STAMP}.XXXXXX")
TMP_SECRET="$WORK/smtp-password"
BACKUP="$WORK/ionos-smtp-password.before"

test -t 0
docker inspect "$API" >/dev/null
IMAGE=$(docker inspect "$API" --format '{{.Config.Image}}')
test -n "$IMAGE"
docker image inspect "$IMAGE" >/dev/null

printf 'IONOS-Passwort für %s (Eingabe bleibt unsichtbar): ' "$SMTP_USER"
IFS= read -rs SMTP_PASSWORD
printf '\n'
printf 'Passwort zur Bestätigung erneut eingeben: '
IFS= read -rs SMTP_CONFIRM
printf '\n'
test -n "$SMTP_PASSWORD"
if test "$SMTP_PASSWORD" != "$SMTP_CONFIRM"; then
  unset SMTP_PASSWORD SMTP_CONFIRM
  printf '%s\n' 'password_confirmation_mismatch' >&2
  exit 64
fi

umask 077
printf '%s' "$SMTP_PASSWORD" >"$TMP_SECRET"
unset SMTP_PASSWORD SMTP_CONFIRM

docker run --rm -i --network host --user 0:0   -v "$TMP_SECRET:/run/secrets/ionos-smtp-password:ro"   --entrypoint node "$IMAGE" --input-type=module - <<'NODE'
import fs from "node:fs";
import nodemailer from "nodemailer";

const user = "admin@wb-holding.ag";
const password = fs.readFileSync("/run/secrets/ionos-smtp-password", "utf8");
const transport = nodemailer.createTransport({
  host: "smtp.ionos.de",
  port: 465,
  secure: true,
  auth: { user, pass: password },
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
  from: user,
  to: user,
  subject: "WB Tender – SMTP-Funktion geprüft",
  text: "Der authentifizierte IONOS-Mailversand für den WB-Tender-Passwort-Reset funktioniert.",
  html: "<p>Der authentifizierte IONOS-Mailversand für den <strong>WB-Tender-Passwort-Reset</strong> funktioniert.</p>"
});
if (!result.accepted?.includes(user)) throw new Error("ionos_test_recipient_not_accepted");
transport.close();
console.log("smtp_verify=ok");
console.log("test_mail=accepted");
NODE

install -d -m 0700 "$SECRET_DIR"
if test -f "$SECRET_FILE"; then
  install -m 0600 "$SECRET_FILE" "$BACKUP"
fi
install -m 0600 "$TMP_SECRET" "$SECRET_FILE"
rm -f "$TMP_SECRET"

printf '%s\n' 'WB_IONOS_SMTP_SECRET=SUCCESS'
printf '%s\n' 'smtp_host=smtp.ionos.de'
printf '%s\n' 'smtp_port=465'
printf '%s\n' 'smtp_tls=implicit'
printf '%s\n' 'smtp_user=admin@wb-holding.ag'
printf '%s\n' 'test_email_sent=true'
printf '%s\n' 'secret_printed=false'
printf '%s\n' 'production_database_changed=false'
printf '%s\n' 'tender_external_submission_changed=false'
printf 'secret_file=%s\n' "$SECRET_FILE"
printf 'work_directory=%s\n' "$WORK"
