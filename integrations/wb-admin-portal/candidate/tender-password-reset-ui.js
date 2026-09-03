(() => {
  "use strict";
  const marker = "WB_TENDER_PASSWORD_RESET_UI_NGINX";
  if (document.documentElement.dataset.wbTenderPasswordReset === marker) return;

  const login = document.querySelector("#login-form");
  if (!login) return;
  const submit = login.querySelector('button[type="submit"]');
  const email = login.querySelector('input[name="email"]');
  if (!submit || !email) return;

  document.documentElement.dataset.wbTenderPasswordReset = marker;

  const open = document.createElement("button");
  open.type = "button";
  open.id = "forgot-open";
  open.textContent = "Passwort vergessen?";
  submit.insertAdjacentElement("afterend", open);

  const form = document.createElement("form");
  form.id = "forgot-form";
  form.style.display = "none";
  form.innerHTML = [
    "<h2>Passwort zurücksetzen</h2>",
    "<p>Geben Sie die E-Mail-Adresse Ihres berechtigten Kontos ein. Sie erhalten einen 30 Minuten gültigen Einmallink.</p>",
    '<label>E-Mail<input name="email" type="email" maxlength="254" autocomplete="username" required></label>',
    '<button type="submit">Rücksetzlink anfordern</button>',
    '<button type="button" id="forgot-back">Zurück zur Anmeldung</button>',
    '<p id="forgot-status" role="status" aria-live="polite"></p>'
  ].join("");
  login.insertAdjacentElement("afterend", form);

  const resetEmail = form.querySelector('input[name="email"]');
  const status = form.querySelector("#forgot-status");
  const back = form.querySelector("#forgot-back");

  open.addEventListener("click", () => {
    resetEmail.value = email.value;
    login.style.display = "none";
    form.style.display = "";
    status.textContent = "";
    resetEmail.focus();
  });

  back.addEventListener("click", () => {
    form.style.display = "none";
    login.style.display = "";
    email.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = "Rücksetzlink wird angefordert …";
    try {
      const response = await fetch("/api/admin/v1/iam/password/forgot", {
        method: "POST",
        credentials: "same-origin",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({email: resetEmail.value})
      });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(data.message || "Der Rücksetzlink konnte nicht angefordert werden.");
      status.textContent = data.message || "Falls ein berechtigtes Konto besteht, wurde eine E-Mail zum Zurücksetzen versendet.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Der Rücksetzlink konnte nicht angefordert werden.";
    } finally {
      button.disabled = false;
    }
  });
})();
