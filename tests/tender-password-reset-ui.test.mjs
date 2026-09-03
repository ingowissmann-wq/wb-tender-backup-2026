import test from "node:test";
import assert from "node:assert/strict";
import { patchTenderPasswordResetUi } from "../integrations/wb-admin-portal/candidate/tender-password-reset-ui-patch.mjs";

const fixture = `
export function page() {
  return \`<form id="login-form"><label>E-Mail<input name="email"></label><label>Passwort<input name="password"></label><button type="submit">Weiter</button></form><form id="mfa-form"></form><script>
(()=>{
  const target=safeReturn(),login=document.querySelector("#login-form"),mfa=document.querySelector("#mfa-form");
})();
</script>\`;
}
`;

test("adds a non-enumerating password reset flow to the Tender login", () => {
  const patched = patchTenderPasswordResetUi(fixture);
  assert.match(patched, /Passwort vergessen\?/);
  assert.match(patched, /id="forgot-form"/);
  assert.match(patched, /\/api\/admin\/v1\/iam\/password\/forgot/);
  assert.match(patched, /30 Minuten gültigen Einmallink/);
  assert.match(patched, /WB_TENDER_PASSWORD_RESET_UI/);
});

test("is idempotent and refuses an unknown login runtime", () => {
  const patched = patchTenderPasswordResetUi(fixture);
  assert.equal(patchTenderPasswordResetUi(patched), patched);
  assert.throws(() => patchTenderPasswordResetUi("export default true"), /login_submit_marker_count_0/);
});
