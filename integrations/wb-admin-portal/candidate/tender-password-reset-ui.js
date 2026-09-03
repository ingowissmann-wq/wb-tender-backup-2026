(() => {
  "use strict";
  const marker = "WB_TENDER_PASSWORD_RESET_UI_NGINX_V2";
  if (document.documentElement.dataset.wbTenderPasswordReset === marker) return;

  const login = document.querySelector("#login-form");
  if (!login) return;
  const submit = login.querySelector('button[type="submit"]');
  const email = login.querySelector('input[name="email"]');
  if (!submit || !email) return;

  document.documentElement.dataset.wbTenderPasswordReset = marker;
  const status = document.createElement("p");
  status.id = "password-reset-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const open = document.createElement("button");
  open.type = "button";
  open.id = "forgot-open";
  open.textContent = "Passwort vergessen?";
  submit.insertAdjacentElement("afterend", open);

  const forgot = document.createElement("form");
  forgot.id = "forgot-form";
  forgot.style.display = "none";
  forgot.innerHTML = [
    "<h2>Passwort zurücksetzen</h2>",
    "<p>Geben Sie die E-Mail-Adresse Ihres berechtigten Kontos ein. Sie erhalten einen 30 Minuten gültigen Einmallink.</p>",
    '<label>E-Mail<input name="email" type="email" maxlength="254" autocomplete="username" required></label>',
    '<button type="submit">Rücksetzlink anfordern</button>',
    '<button type="button" id="forgot-back">Zurück zur Anmeldung</button>'
  ].join("");
  forgot.append(status);
  login.insertAdjacentElement("afterend", forgot);

  const reset = document.createElement("form");
  reset.id = "password-reset-form";
  reset.style.display = "none";
  reset.innerHTML = [
    "<h2>Neues Passwort festlegen</h2>",
    "<p>Das neue Passwort muss mindestens 12 Zeichen lang sein.</p>",
    '<label>Neues Passwort<input name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></label>',
    '<label>Passwort bestätigen<input name="confirmation" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></label>',
    '<button type="submit">Passwort speichern</button>'
  ].join("");
  const resetStatus = status.cloneNode(false);
  resetStatus.id = "password-reset-submit-status";
  reset.append(resetStatus);
  forgot.insertAdjacentElement("afterend", reset);

  const forgotEmail = forgot.querySelector('input[name="email"]');
  const showLogin = (message = "") => {
    forgot.style.display = "none";
    reset.style.display = "none";
    login.style.display = "";
    status.textContent = message;
    if (message) login.append(status);
    email.focus();
  };

  open.addEventListener("click", () => {
    forgotEmail.value = email.value;
    login.style.display = "none";
    reset.style.display = "none";
    forgot.style.display = "";
    status.textContent = "";
    forgotEmail.focus();
  });
  forgot.querySelector("#forgot-back").addEventListener("click", () => showLogin());

  forgot.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = forgot.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = "Rücksetzlink wird angefordert …";
    try {
      const response = await fetch("/api/admin/v1/iam/password/forgot", {
        method: "POST", credentials: "same-origin",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({email: forgotEmail.value})
      });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(data.message || "Der Rücksetzlink konnte nicht angefordert werden.");
      status.textContent = data.message || "Falls ein berechtigtes Konto besteht, wurde eine E-Mail zum Zurücksetzen versendet.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Der Rücksetzlink konnte nicht angefordert werden.";
    } finally { button.disabled = false; }
  });

  const token = new URL(window.location.href).searchParams.get("reset");
  if (token) {
    login.style.display = "none";
    forgot.style.display = "none";
    reset.style.display = "";
    reset.querySelector('input[name="password"]').focus();
  }

  reset.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = reset.querySelector('button[type="submit"]');
    const password = reset.querySelector('input[name="password"]').value;
    const confirmation = reset.querySelector('input[name="confirmation"]').value;
    if (password !== confirmation) {
      resetStatus.textContent = "Die Passwörter stimmen nicht überein.";
      return;
    }
    button.disabled = true;
    resetStatus.textContent = "Passwort wird gespeichert …";
    try {
      const response = await fetch("/api/admin/v1/iam/password/reset", {
        method: "POST", credentials: "same-origin",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({token, password, confirmation})
      });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(data.message || "Das Passwort konnte nicht gespeichert werden.");
      history.replaceState({}, "", window.location.pathname);
      showLogin("Das Passwort wurde geändert. Sie können sich jetzt anmelden.");
    } catch (error) {
      resetStatus.textContent = error instanceof Error ? error.message : "Das Passwort konnte nicht gespeichert werden.";
    } finally { button.disabled = false; }
  });
})();
