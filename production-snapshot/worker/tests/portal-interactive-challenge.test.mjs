import assert from "node:assert/strict";
import test from "node:test";
import {classifyInteractiveLoginChallenge} from "../platform/semantic-browser-auth.mjs";
import {portalLoginAction} from "../platform/portal-login-action.mjs";

test("browser login stops for CAPTCHA and MFA instead of attempting a bypass",()=>{
  assert.equal(classifyInteractiveLoginChallenge({text:"Ich bin kein Roboter"}),"CAPTCHA_MANUELL_ERFORDERLICH");
  assert.equal(classifyInteractiveLoginChallenge({captchaVisible:true,text:"Anmelden"}),"CAPTCHA_MANUELL_ERFORDERLICH");
  assert.equal(classifyInteractiveLoginChallenge({otpVisible:true}),"MFA_BESTÄTIGUNG_ERFORDERLICH");
  assert.equal(classifyInteractiveLoginChallenge({text:"Normale Kontoansicht"}),null);
});

test("CAPTCHA has a dedicated safe continuation action",()=>{
  const action=portalLoginAction({tenderId:"t",companyId:"c",portalId:"p",configured:true,
    accessStatus:"CAPTCHA_REQUIRED",authenticationTargetConfigured:true});
  assert.deepEqual(action,{type:"CONFIRM_CAPTCHA",label:"CAPTCHA fortsetzen",reason:"CAPTCHA_REQUIRED",
    binding:{tender_id:"t",company_id:"c",portal_id:"p",lot_key:""}});
});
