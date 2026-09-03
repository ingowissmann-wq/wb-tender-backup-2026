import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function patchTenderPasswordResetUi(source) {
  const marker = "WB_TENDER_PASSWORD_RESET_UI";
  if (source.includes(marker)) return source;

  const submitButton = '<button type="submit">Weiter</button>';
  const submitCount = source.split(submitButton).length - 1;
  if (submitCount !== 1) throw new Error(`login_submit_marker_count_${submitCount}`);

  const forgotUi = `${submitButton}<button type="button" id="forgot-open">Passwort vergessen?</button>`;
  source = source.replace(submitButton, forgotUi);

  const loginForm = '<form id="login-form">';
  const loginStart = source.indexOf(loginForm);
  if (loginStart < 0) throw new Error("login_form_missing");
  const loginEnd = source.indexOf("</form>", loginStart);
  if (loginEnd < 0) throw new Error("login_form_end_missing");

  const forgotForm = '<form id="forgot-form" class="hidden"><h2>Passwort zurücksetzen</h2><p>Geben Sie die E-Mail-Adresse Ihres berechtigten Kontos ein. Sie erhalten einen 30 Minuten gültigen Einmallink.</p><label>E-Mail<input name="email" type="email" maxlength="254" autocomplete="username" required></label><button type="submit">Rücksetzlink anfordern</button><button type="button" id="forgot-back">Zurück zur Anmeldung</button></form>';
  source = source.slice(0, loginEnd + 7) + forgotForm + source.slice(loginEnd + 7);

  const jsMarker = 'const target=safeReturn(),login=document.querySelector("#login-form"),mfa=document.querySelector("#mfa-form");';
  const jsCount = source.split(jsMarker).length - 1;
  if (jsCount !== 1) throw new Error(`login_js_marker_count_${jsCount}`);

  const jsReplacement = `/* ${marker} */
  const adminForgot=async body=>{const response=await fetch("/api/admin/v1/iam/password/forgot",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(body)});let data={};try{data=await response.json()}catch{}if(!response.ok)throw new Error(data.message||"Der Rücksetzlink konnte nicht angefordert werden.");return data};
  const target=safeReturn(),login=document.querySelector("#login-form"),mfa=document.querySelector("#mfa-form"),forgot=document.querySelector("#forgot-form"),forgotOpen=document.querySelector("#forgot-open"),forgotBack=document.querySelector("#forgot-back");
  forgotOpen.onclick=()=>{const current=login.querySelector('input[name="email"]').value;forgot.querySelector('input[name="email"]').value=current;login.classList.add("hidden");mfa.classList.add("hidden");forgot.classList.remove("hidden");show("Geben Sie Ihre E-Mail-Adresse ein.")};
  forgotBack.onclick=()=>{forgot.classList.add("hidden");login.classList.remove("hidden");show("Melden Sie sich mit Ihrem persönlichen Passwort an.")};
  forgot.onsubmit=async event=>{event.preventDefault();const body=new FormData(forgot);try{event.submitter.disabled=true;const data=await adminForgot({email:body.get("email")});show(data.message||"Falls ein berechtigtes Konto besteht, wurde eine E-Mail zum Zurücksetzen versendet.")}catch(error){show(error.message,true)}finally{if(event.submitter)event.submitter.disabled=false}};`;

  source = source.replace(jsMarker, jsReplacement);
  if (!source.includes(marker) || !source.includes("/api/admin/v1/iam/password/forgot"))
    throw new Error("password_reset_patch_verification_failed");
  return source;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error("owner_auth_path_required");
  fs.writeFileSync(file, patchTenderPasswordResetUi(fs.readFileSync(file, "utf8")));
}
