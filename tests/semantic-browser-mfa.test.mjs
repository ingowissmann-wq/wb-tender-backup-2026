import test from "node:test";
import assert from "node:assert/strict";
import { authoritativeMfaChallenge,portalAvailabilityFailure,portalNavigationFailure } from "../platform/semantic-browser-auth.mjs";

test("generic MFA information never becomes an active challenge", () => {
  assert.equal(authoritativeMfaChallenge({text:"MFA kann in den Kontoeinstellungen aktiviert werden."}), false);
  assert.equal(authoritativeMfaChallenge({text:"Mehr Sicherheit mit Zwei-Faktor-Authentifizierung."}), false);
});

test("visible one-time-code input is authoritative MFA evidence", () => {
  assert.equal(authoritativeMfaChallenge({otpVisible:true,text:"Code eingeben"}), true);
});

test("explicit push approval instruction is authoritative MFA evidence", () => {
  assert.equal(authoritativeMfaChallenge({text:"Bestätigen Sie diese Anmeldung per Push in Ihrer Authenticator-App."}), true);
});

test("portal maintenance and HTTP 5xx are not misclassified as changed login forms", () => {
  assert.equal(portalAvailabilityFailure({status:503,title:"Wartungsarbeiten - eVergabe"}),true);
  assert.equal(portalAvailabilityFailure({status:200,text:"Service temporarily unavailable"}),true);
  assert.equal(portalAvailabilityFailure({status:200,title:"Anmelden",text:"Benutzername Passwort"}),false);
});

test("TLS and DNS navigation failures are temporary portal outages", () => {
  assert.equal(portalNavigationFailure(new Error("page.goto: net::ERR_SSL_UNRECOGNIZED_NAME_ALERT")),true);
  assert.equal(portalNavigationFailure(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED")),true);
});

test("connector programming errors remain technical connector failures", () => {
  assert.equal(portalNavigationFailure(new TypeError("locator is not a function")),false);
});
