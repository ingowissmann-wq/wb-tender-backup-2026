import fs from "node:fs";

const session = JSON.parse(fs.readFileSync("/tmp/green-admin-session.json", "utf8"));
const response = await fetch("http://127.0.0.1:4240/api/tools/action/transmit", {
  method: "POST",
  headers: {
    host: "admin.wb-holding.ag",
    "x-forwarded-host": "admin.wb-holding.ag",
    "x-forwarded-proto": "https",
    "content-type": "application/json",
    "x-csrf-token": session.csrf,
    cookie: `wb_session=${session.token}; wb_csrf=${session.csrf}`,
  },
  body: "{}",
});
const body = await response.json();
const result = {
  status: response.status,
  error: body.error,
  externalSubmissionEnabled: body.external_submission_enabled,
  transmitted: body.transmitted,
};
console.log(JSON.stringify(result));
if (response.status !== 423 || body.external_submission_enabled !== false || body.transmitted !== false) process.exitCode = 1;
