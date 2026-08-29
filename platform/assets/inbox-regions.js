(() => {
  const API = location.port ? "/api" : "/api/tender",
    content = document.querySelector("#content"),
    tabs = document.querySelector("#tabs"),
    esc = (value) =>
      String(value ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      ),
    recordOrNull = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null,
    canonicalCredentialStatuses = new Set([
      "NOT_CONFIGURED", "CREDENTIAL_SCOPE_CONFLICT", "CONFIGURED_UNVERIFIED", "VALID", "MFA_REQUIRED",
      "CAPTCHA_OR_USER_ACTION_REQUIRED", "EXPIRED", "INVALID", "LOCKED",
      "PORTAL_UNAVAILABLE", "VALIDATION_PENDING",
    ]),
    preferenceKey = "wb-tender-management-company";
  let active = false,
    inboxRequestSequence = 0,
    inboxRequestController = null,
    state = {
      company: "",
      regionClass: "all",
      relevance: "relevant",
      serviceLine: "",
      page: 1,
      pageSize: 50,
    };
  const labels = {
    CORE_REGION: "Kernregion",
    STRATEGIC_REGION: "Strategische/bedingte Region",
    OUTSIDE_CORE_REGION: "Außerhalb der Kernregion",
    EXCLUDED_REGION: "Ausgeschlossene Region",
    REGION_UNRESOLVED: "Region nicht eindeutig ermittelbar",
    REGION_CONFIG_CONFLICT: "Widersprüchliche Regionskonfiguration",
    MULTI_REGION_REVIEW: "Mehrere Regionen – Einzelprüfung erforderlich",
    REGION_CONFIGURATION_MISSING: "Regionskonfiguration fehlt",
    NOT_APPLICABLE: "Nicht anwendbar",
  };
  const calculationLabels = {
      NOT_STARTED: "Noch nicht verarbeitet",
      CALCULATION_QUEUED: "Kalkulation eingeplant",
      CALCULATING: "Kalkulation läuft",
      CALCULATED: "Kalkulation abgeschlossen",
      CALCULATED_REAL: "Vollständige reale Kalkulation",
      CALCULATION_COMPLETED: "Kalkulation abgeschlossen",
      CALCULATION_PARTIAL: "Reale Teilkalkulation",
      DOCUMENT_FETCH_QUEUED: "Vergabeunterlagen werden verarbeitet",
      CALCULATION_BLOCKED_MISSING_INPUT:
        "Kalkulation blockiert – Ausschreibungsangaben fehlen",
      CALCULATION_BLOCKED_DOCUMENTS_NOT_AVAILABLE:
        "Kalkulation blockiert – Vergabeunterlagen nicht verfügbar",
      CALCULATION_FAILED_RETRYING:
        "Technischer Fehler – erneuter Versuch läuft",
      CALCULATION_FAILED: "Technischer Fehler",
      NOT_APPLICABLE_AWARD_NOTICE:
        "Keine Kalkulation – Zuschlagsbekanntmachung",
      NOT_APPLICABLE_CANCELLED: "Keine Kalkulation – aufgehoben",
      NOT_APPLICABLE_EXPIRED: "Keine Kalkulation – Frist abgelaufen",
      TECHNICAL_STATUS_ERROR: "Technischer Fehler – Status unbekannt",
    },
    nextActionLabels = {
      AUTOMATIC_RETRIGGER_ON_NEW_DOCUMENTS:
        "Automatischer erneuter Abruf bei neuen Vergabeunterlagen",
      AUTOMATIC_DOCUMENT_RETRY: "Automatischer erneuter Dokumentenabruf",
      IMMEDIATE_PROCESSING_QUEUE: "Unmittelbare Verarbeitung eingeplant",
      NO_AUTOMATIC_ACTION: "Kein weiterer automatischer Schritt",
      FEHLENDE_DATEN_ERGÄNZEN:
        "Automatischer erneuter Abruf bei neuen Vergabeunterlagen",
      PORTALZUGANG_KONFIGURIEREN:
        "Automatischer erneuter Abruf nach verfügbarem Portalzugang",
    };
  const calculationLabel = (status) =>
    calculationLabels[status] || "Technischer Fehler – Status unbekannt";
  const safeExternalUrl = (value) => {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol !== "https:" || url.username || url.password || /;jsessionid=/i.test(url.pathname)) return null;
      for (const key of url.searchParams.keys()) if (/^(?:access_?token|auth(?:entication|orization)?|bearer|code|credential|id_?token|jwt|key|password|refresh_?token|secret|session(?:id)?|sid|ticket|token)$/i.test(key)) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  };
  const evidenceLink = (link) => {
    const url = safeExternalUrl(link?.url);
    return url ? `<a class="button-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-target-type="${esc(link.targetType || "EXTERNAL")}">${esc(link.label)} <small>(${esc(link.provenanceLabel || link.portalName || "offizielle Quelle")})</small></a>` : "";
  };
  const sourceDisplayName = (item) => item?.linkEvidence?.source?.displayName || ({DOE:"oeffentlichevergabe.de",TED:"TED (Tenders Electronic Daily)"}[String(item?.source_code || "").toUpperCase()] || item?.source_code || "Nicht ermittelt");
  const portalManageUrl = (item, portalId) => `${location.port ? "" : "/admin/ausschreibungen"}/autopilot/portal-access?tender=${encodeURIComponent(item.tender_id)}&lot=${encodeURIComponent(item.lot_key || "")}&company=${encodeURIComponent(item.company_id)}&portal=${encodeURIComponent(portalId)}`;
  const portalManageButton = (item, portalValue = null) => {
    const target = String(item?.portal_navigation_href || "");
    if (!target.startsWith("/admin/ausschreibungen/portalzugaenge")) return "";
    const portal = recordOrNull(portalValue),
      status = canonicalCredentialStatuses.has(portal?.credential_status) ? portal.credential_status : null,
      label = status === "NOT_CONFIGURED"
        ? "Zugangsdaten hinterlegen"
        : ["EXPIRED", "INVALID"].includes(status)
          ? "Zugang aktualisieren"
          : status || item?.portal_navigation_mode === "edit"
            ? "Zugangsdaten verwalten"
            : "Portalzuordnung prüfen";
    return `<a class="button-link" data-portal-navigation="${esc(item.portal_navigation_mode || (portal?.portalId || portal?.portal_id ? "edit" : "search"))}" href="${esc(target)}">${esc(label)}</a>`;
  };
  const renderTenderLinkEvidence = (item, detail = false) => {
    const evidence = item?.linkEvidence,
      missing = evidence?.missingReasons || {};
    if (!evidence) return `<section class="tender-link-evidence"><h${detail ? "2" : "3"}>Offizielle externe Ziele</h${detail ? "2" : "3"}><p class="muted">Linknachweis konnte nicht geladen werden. Bitte erneut versuchen.</p></section>`;
    const links = [
      evidence.originalNotice,
      evidence.procurementPortal,
      evidence.documents?.[0],
      evidence.login,
      evidence.registration,
      evidence.electronicSubmission,
      evidence.technicalSource,
    ].map(evidenceLink).filter(Boolean).join("");
    const reasons = [
      missing.originalNotice,
      missing.procurementPortal,
      missing.documents,
      missing.login,
      missing.registration,
      missing.electronicSubmission,
    ].filter(Boolean).map((reason) => `<li>${esc(reason)}</li>`).join("");
    const manage = portalManageButton(item,evidence.procurementPortal);
    return `<section class="tender-link-evidence" aria-label="Offizielle externe Ziele"><h${detail ? "2" : "3"}>Offizielle externe Ziele</h${detail ? "2" : "3"}><div class="card-actions">${links}${manage}</div>${reasons ? `<ul class="muted">${reasons}</ul>` : ""}</section>`;
  };
  const documentEvidenceSummary = (item) => {
    const evidence = item?.documentEvidence || item?.linkEvidence?.documentEvidence;
    if (!evidence) return { label: "Dokumentstatus nicht belegbar", reason: "Link- und Abrufnachweis konnte nicht geladen werden.", counts: "Nicht ermittelt" };
    const counts = evidence.code === "DOCUMENTS_FOUND"
      ? `${evidence.linksFound} Link${evidence.linksFound === 1 ? "" : "s"} · ${evidence.fetched} erfolgreich abgerufen${evidence.failed ? ` · ${evidence.failed} fehlgeschlagen` : ""}`
      : "Kein erfolgreicher Abruf belegt";
    return { label: evidence.label, reason: evidence.reason, counts };
  };
  const formatDate = (value, fallback = "–") => {
    if (!value) return fallback;
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat("de-DE", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date);
  };
  const displayValue = (value, fallback = "–") => {
    if (value === null || value === undefined || value === "") return fallback;
    if (Array.isArray(value)) return value.map((entry) => displayValue(entry, "")).filter(Boolean).join(", ") || fallback;
    if (typeof value === "object")
      return Object.entries(value)
        .map(([key, entry]) => `${key}: ${displayValue(entry, "–")}`)
        .join(" · ");
    return String(value);
  };
  const documentIdentity = (document = {}) => {
    const raw = String(document.filename || document.sourceDocumentId || "Dokument"),
      uuid = raw.match(/^[{(]?([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})[)}]?(\.[a-z0-9]{1,8})?$/i);
    return uuid
      ? { name: `Portal-Dokument${uuid[2] || ""}`, reference: uuid[1], opaque: true }
      : { name: raw, reference: document.sourceDocumentId && document.sourceDocumentId !== raw ? String(document.sourceDocumentId) : "", opaque: false };
  };
  const documentList = (documents, details = false) => {
    const items = (documents || []).map((document) => {
      const identity = documentIdentity(document),
        reference = identity.reference ? `<small class="document-reference">Referenz: <code title="${esc(identity.reference)}">${esc(identity.opaque ? `${identity.reference.slice(0, 8)}…${identity.reference.slice(-4)}` : identity.reference)}</code></small>` : "",
        metadata = details ? `<small>Download: ${esc(documentStatusLabel(document.downloadStatus || document.fetchStatus))} · Parser: ${esc(document.parserStatus || "Noch nicht analysiert")} · ${esc(document.mimeType || "MIME wird nach erfolgreichem Abruf bestimmt")} · letzter Versuch: ${esc(formatDate(document.lastAttempt))}</small>` : "";
      return `<li><strong class="document-name">${esc(identity.name)}</strong>${reference}${metadata}</li>`;
    }).join("");
    return `<ul class="affected-document-list">${items || "<li>Keine Dokumentreferenz vorhanden</li>"}</ul>`;
  };
  const portalTruthMessage = (portalValue, long = false) => {
    const portal = recordOrNull(portalValue);
    if (!portal) return "Portalzugangsstatus ist technisch nicht verfügbar; der Ausschreibungskontext muss geprüft werden.";
    if (portal.credential_status_message) return portal.credential_status_message;
    const type = portal.login_action?.type;
    if (type === "OPEN_PORTAL_READ_ONLY") return portal.documents_complete ? "Alle erforderlichen Vergabeunterlagen sind vollständig geladen und analysiert. Das Portal kann schreibgeschützt geöffnet werden." : "Das Portal kann schreibgeschützt geöffnet werden; ein Dokumentabruf ist eine separate Aktion.";
    if (type === "AUTHENTICATION_TARGET_UNAVAILABLE") return "Für dieses Portal ist kein autoritatives, freigegebenes Login- oder Bieterbereichsziel konfiguriert. Bitte Portalprofil administrativ ergänzen.";
    if (type === "START_LOGIN") return "Die gespeicherte Portalsitzung konnte nicht sicher wiederhergestellt werden. Erneut anmelden; erst danach wird automatisch fortgesetzt.";
    if (type === "CONFIRM_MFA") return "MFA-Bestätigung erforderlich. Erst nach erfolgreicher Bestätigung wird automatisch fortgesetzt.";
    if (type === "MANAGE_CREDENTIALS") return portal.credential?.configured ? "Der vorhandene Portalzugang muss aktualisiert werden." : "Für dieses Portal ist ein Zugang einzurichten.";
    if (type === "NONE" && portal.session_verification_status === "VERIFIED_RESTORED_READ_ONLY_PAGE") return long ? "Die Portalsitzung wurde in einem unabhängigen Browser auf einer authentifizierten, schreibgeschützten Seite bestätigt. Die Verarbeitung darf automatisch fortgesetzt werden." : "Portalsitzung unabhängig und schreibgeschützt bestätigt; Verarbeitung wird automatisch fortgesetzt.";
    return "Keine unabhängig bestätigte Portalsitzung vorhanden.";
  };
  const missingLabel = (item) =>
    typeof item === "string"
      ? item
      : displayValue(
          item?.label || item?.field || item?.key || item?.code,
          "Fehlende Ausschreibungsangabe",
        );
  const statusLabel = (status) => ({
    RELEVANT: "Relevant",
    POTENTIALLY_RELEVANT: "Voraussichtlich relevant",
    NOT_RELEVANT: "Nicht relevant",
    EXCLUDED: "Ausgeschlossen",
    PASSED: "Fachlich passend",
    FAILED: "Fachlich nicht passend",
    FULL_PIPELINE_ALLOWED: "Vollständige automatische Verarbeitung zulässig",
    NOT_CREATED: "Noch nicht erzeugt",
    GENERATED: "Erzeugt",
    READY: "Bereit",
    NICHT_KALKULIERBAR_FEHLENDE_TENDERUNTERLAGEN:
      "Erzeugt – erforderliche Tenderangaben fehlen",
    NO_PIPELINE_ATTEMPT: "Noch keine Verarbeitung",
    DOCUMENTS_FETCHED: "Dokumente geladen",
    DATA_EXTRACTED: "Daten extrahiert",
    GENERATE_RECOMMENDATION: "Managementempfehlung erzeugt",
    MANAGEMENT_OUTPUT_GENERATED: "Managementausgabe erzeugt",
  })[status] || displayValue(status);
  const csrf = () =>
    decodeURIComponent(
      document.cookie
        .split("; ")
        .find((x) => x.startsWith("wb_csrf="))
        ?.split("=")
        .slice(1)
        .join("=") || "",
    );
  const request = async (path, options = {}) => {
    const response = await fetch(API + path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.method && options.method !== "GET"
          ? { "content-type": "application/json", "x-csrf-token": csrf() }
          : {}),
        ...(options.headers || {}),
      },
    });
    let body = {};
    try {
      body = await response.json();
    } catch {}
    if (!response.ok)
      throw Object.assign(Error(body.message || (response.status === 401 ? "Anmeldung oder MFA-Sitzung erforderlich." : response.status === 403 ? "Keine Berechtigung für diese Aktion." : response.status === 409 ? "Der Stand hat sich geändert. Bitte laden Sie die Ansicht neu." : response.status === 423 ? "Diese rechtlich bindende Portalaktion ist gesperrt. Es wurde nichts übermittelt." : response.status >= 500 ? "Die Aktion konnte wegen eines technischen Fehlers nicht abgeschlossen werden." : `Die Aktion konnte nicht abgeschlossen werden (${response.status}).`)), {
        status: response.status,
        retryAfter: Number(response.headers.get("retry-after")) || null,
      });
    return body;
  };
  const activeJobKey = (tenderId, companyId) =>
    `wb-tender-action-job:${tenderId}:${companyId}`;
  const renderJob = (job) =>
    `<strong>${esc(job.action_type || "")}</strong> · Job-ID ${esc(job.job_id || "")} · Status ${esc(job.status || "")} · Schritt ${esc(job.current_step || "–")} · Fortschritt ${esc(job.progress_percent || 0)} % · Erfolgreich ${esc(job.successful_items || 0)}, übersprungen ${esc(job.skipped_items || 0)}, fehlgeschlagen ${esc(job.failed_items || 0)}${job.error_code ? ` · Fehlerklasse ${esc(job.error_code)}` : ""}${job.finished_at ? ` · Abschluss ${esc(job.finished_at)}` : ""}`;
  const jobPollers = new Map(),
    pollOwner =
      sessionStorage.getItem("wb-inbox-job-poll-owner") || crypto.randomUUID();
  sessionStorage.setItem("wb-inbox-job-poll-owner", pollOwner);
  const terminalJob = new Set([
      "SUCCEEDED",
      "PARTIAL_SUCCESS",
      "FAILED",
      "CANCELLED",
      "DEAD_LETTER",
    ]),
    jobLease = (id) => `wb-tender-job-lease:${id}`;
  function acquireJobLease(id) {
    const now = Date.now();
    let lease = {};
    try {
      lease = JSON.parse(localStorage.getItem(jobLease(id)) || "{}");
    } catch {}
    if (lease.owner && lease.owner !== pollOwner && lease.until > now)
      return false;
    localStorage.setItem(
      jobLease(id),
      JSON.stringify({ owner: pollOwner, until: now + 35000 }),
    );
    return true;
}

// One shared, server-bound contract for dashboard cards and tender detail cards.
// Capture phase prevents the legacy handler from queuing a fetch before an
// external portal session has actually been established.
const correlatedPortalLogins = new Map();
const reconnectFailureStatuses = new Set(["LOGIN_FAILED","SESSION_EXPIRED","MFA_REQUIRED","WRONG_ACCOUNT_CONTEXT","WRONG_ORGANIZATION_CONTEXT","LOGIN_FORM_CHANGED"]);
const reconnectErrorText = (state, error) => `${state?.message || error?.message || "Die Portalverbindung konnte nicht bestätigt werden."}${state?.detail ? ` Technische Diagnose: ${state.detail}.` : ""} Fehler-ID: ${state?.errorId || error?.requestId || "nicht verfügbar"}. Sie können den Vorgang sicher erneut starten.`;
document.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-portal-login]");
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (button.disabled) return;
  const scope = button.closest("[data-portal-access]") || document,
    status = scope.querySelector(`[data-portal-login-status="${CSS.escape(button.dataset.portalLogin)}"]`),
    tenderId = button.dataset.tender || new URL(location.href).searchParams.get("tender"),
    companyId = button.dataset.company || new URL(location.href).searchParams.get("company"),
    lotKey = button.dataset.lot || new URL(location.href).searchParams.get("lot") || null,
    correlationKey = [button.dataset.portalLogin,tenderId,companyId,lotKey||""].join(":");
  try {
    let entry = correlatedPortalLogins.get(correlationKey);
    if (!entry) {
      button.disabled = true;
      button.setAttribute("aria-busy","true");
      button.textContent = "Verbindung wird aufgebaut …";
      if (status) status.textContent = "Der einmalige, portalscharf gebundene Loginvorgang wird angelegt …";
      const continuation = await request(`/portal-access/${encodeURIComponent(button.dataset.portalLogin)}/login-continuations`, {method:"POST",body:JSON.stringify({tender_id:tenderId,company_id:companyId,lot_key:lotKey,blocked_action:button.dataset.blockedAction||"DOCUMENT_FETCH"})});
      entry = {continuation,polling:false};
      correlatedPortalLogins.set(correlationKey,entry);
      button.dataset.continuationId = continuation.continuationId;
      button.dataset.portalAdapterId = continuation.portalAdapterId;
      button.dataset.credentialId = continuation.credentialId;
      button.dataset.portalHost = continuation.portalHost;
      button.textContent = continuation.verificationAction || "Anmeldung abgeschlossen – Verbindung prüfen";
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (status) status.textContent = "Der korrelierte Loginvorgang ist bereit. Nach Abschluss der Portalanmeldung Verbindung prüfen.";
      return;
    }
    if (entry.polling) { if (status) status.textContent = "Die Verbindung wird bereits geprüft …"; return; }
    entry.polling = true;
    const continuation = entry.continuation;
    button.disabled = true;
    button.setAttribute("aria-busy","true");
    button.textContent = "Verbindung wird geprüft …";
    if (status) status.textContent = "Portalsitzung, Account-, Gesellschafts-, Tender- und Losbindung werden geprüft …";
    const startedAt = Date.now();
    const fail = (state,error=null) => {
      correlatedPortalLogins.delete(correlationKey);
      entry.polling=false;
      button.disabled=false;
      button.removeAttribute("aria-busy");
      button.textContent=state?.recoveryAction?.label||(state?.status==="MFA_REQUIRED"?"Persönliche MFA erforderlich":"Erneut anmelden");
      if(state?.status==="MFA_REQUIRED")button.textContent="MFA-Anmeldung erneut starten";
      if(status)status.textContent=reconnectErrorText(state,error);
    };
    const poll = async () => {
      const state = await request(`/portal-access/login-continuations/${encodeURIComponent(continuation.continuationId)}/status`, {method:"POST",body:JSON.stringify({correlationToken:continuation.correlationToken})});
      const processingMessages={LOGIN_SUCCESSFUL:"Portalverbindung wurde autoritativ geprüft und hergestellt.",AUTOMATIC_PROCESSING_PLANNED:"Automatische Verarbeitung wird gestartet.",AUTOMATIC_PROCESSING_ACTIVE:"Automatische Verarbeitung läuft.",DOCUMENT_DOWNLOAD_ACTIVE:"Vergabeunterlagen werden geladen.",DOCUMENT_WORKFLOW_COMPLETED:"Vergabeunterlagen wurden verarbeitet.",FUNCTIONAL_BLOCKER_REACHED:"Vergabeunterlagen wurden verarbeitet. Der nächste fachliche Schritt benötigt Angaben.",TECHNICAL_BLOCKER:"Die Portalsitzung ist gültig, die automatische Verarbeitung ist technisch blockiert."};
      if (processingMessages[state.status]) {
        if (status) status.textContent=processingMessages[state.status];
        if (state.job?.job_id) { localStorage.setItem(activeJobKey(tenderId, companyId), state.job.job_id); if (document.querySelector("#job-status")) pollJob(tenderId, companyId, state.job.job_id); }
        if (["AUTOMATIC_PROCESSING_PLANNED","AUTOMATIC_PROCESSING_ACTIVE","DOCUMENT_DOWNLOAD_ACTIVE"].includes(state.status)) window.setTimeout(()=>poll().catch(error=>fail(null,error)),2000); else {entry.polling=false;button.disabled=false;button.removeAttribute("aria-busy");}
        if (state.sessionValid) { correlatedPortalLogins.delete(correlationKey); button.textContent="Portal verbunden"; button.disabled=true; button.removeAttribute("aria-busy"); if(status)status.textContent=`Portal verbunden · geprüft ${new Intl.DateTimeFormat("de-DE",{dateStyle:"medium",timeStyle:"short"}).format(new Date())}. Der blockierte Dokumentabruf wird fortgesetzt.`; window.setTimeout(()=>location.reload(),1200); }
        return;
      }
      if (reconnectFailureStatuses.has(state.status)) return fail(state);
      if(state.status==="LOGIN_RETRY_SCHEDULED"&&status)status.textContent=`${state.message || "Die Verbindung wird erneut geprüft."} Fehler-ID: ${state.errorId||"nicht verfügbar"}. Verbindung wird weiter geprüft …`;
      if(Date.now()-startedAt>=60000){entry.polling=false;button.disabled=false;button.removeAttribute("aria-busy");button.textContent="Anmeldung abgeschlossen – Verbindung prüfen";if(status)status.textContent=`Die Prüfung dauert länger als erwartet. Fehler-ID: ${state.errorId||"nicht verfügbar"}. Sie können die Statusprüfung erneut ausführen.`;return;}
      window.setTimeout(()=>poll().catch(error=>fail(null,error)),2000);
    };
    await poll();
  } catch (error) {
    correlatedPortalLogins.delete(correlationKey);
    button.textContent="Erneut anmelden";
    button.removeAttribute("aria-busy");
    if (status) status.textContent = reconnectErrorText(null,error);
    button.disabled = false;
  }
}, true);
document.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-portal-document-refresh]");
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (button.disabled) return;
  const scope = button.closest("[data-portal-access]") || document,
    status = scope.querySelector(`[data-portal-login-status="${CSS.escape(button.dataset.portalDocumentRefresh)}"]`);
  button.disabled = true;
  try {
    const job = await request(`/management-inbox/autopilot/${encodeURIComponent(button.dataset.tender)}/jobs`, {
      method: "POST",
      body: JSON.stringify({ action_type: "FETCH_DOCUMENTS", company_id: button.dataset.company, lot_key: button.dataset.lot || null }),
    });
    if (status) status.textContent = `Dokumentenaktualisierung gestartet · Job ${job.job_id}.`;
  } catch (error) {
    if (status) status.textContent = `Dokumentenaktualisierung konnte nicht gestartet werden: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}, true);
  function stopPollJob(jobId, { removeKey = null } = {}) {
    const state = jobPollers.get(jobId);
    if (!state) return;
    clearTimeout(state.timer);
    state.controller?.abort();
    jobPollers.delete(jobId);
    try {
      const lease = JSON.parse(localStorage.getItem(jobLease(jobId)) || "{}");
      if (lease.owner === pollOwner) localStorage.removeItem(jobLease(jobId));
    } catch {}
    if (removeKey) localStorage.removeItem(removeKey);
  }
  function pollJob(tenderId, companyId, jobId) {
    if (jobPollers.has(jobId)) return jobPollers.get(jobId);
    const storageKey = activeJobKey(tenderId, companyId),
      state = {
        timer: null,
        controller: null,
        polls: 0,
        backoff: 0,
        stopped: false,
      },
      output = () => document.querySelector("#job-status"),
      schedule = (delay) => {
        clearTimeout(state.timer);
        state.timer = setTimeout(
          tick,
          document.visibilityState === "hidden"
            ? Math.max(30000, delay)
            : Math.max(2000, delay),
        );
      },
      tick = async () => {
        if (state.stopped || state.controller) return;
        if (!output()) {
          stopPollJob(jobId);
          return;
        }
        if (!acquireJobLease(jobId)) {
          schedule(3000);
          return;
        }
        state.controller = new AbortController();
        try {
          const job = await request(
            `/management-inbox/autopilot/jobs/${encodeURIComponent(jobId)}`,
            { signal: state.controller.signal },
          );
          state.polls++;
          state.backoff = 0;
          const delay = state.polls === 1 ? 5000 : 10000;
          output().innerHTML = `${renderJob(job)} · letzter Statusabruf ${esc(new Date().toLocaleTimeString())}${terminalJob.has(job.status) ? "" : ` · nächster Statusabruf ${esc(new Date(Date.now() + (document.visibilityState === "hidden" ? 30000 : delay)).toLocaleTimeString())}`}`;
          localStorage.setItem(
            `wb-tender-job-snapshot:${jobId}`,
            JSON.stringify({
              ...job,
              lastCheckedAt: Date.now(),
              nextCheckAt: Date.now() + delay,
            }),
          );
          if (terminalJob.has(job.status)) {
            stopPollJob(jobId, { removeKey: storageKey });
            return;
          }
          schedule(delay);
        } catch (error) {
          if (error.name === "AbortError") return;
          if (error.status === 401 || error.status === 403) {
            output().textContent = `Job-ID ${jobId} · Statusabruf beendet: Anmeldung oder MFA-Sitzung erforderlich.`;
            stopPollJob(jobId);
            return;
          }
          state.backoff = Math.min(state.backoff + 1, 4);
          const base =
              error.status === 429
                ? error.retryAfter
                  ? error.retryAfter * 1000
                  : Math.min(60000, 5000 * 2 ** (state.backoff - 1))
                : Math.min(60000, 5000 * 2 ** (state.backoff - 1)),
            delay = base + Math.floor(Math.random() * 500),
            seconds = Math.ceil(delay / 1000);
          output().textContent =
            error.status === 429
              ? `Job-ID ${jobId} · Der Job läuft weiter. Der Status wird wegen zu vieler Abfragen in ${seconds} Sekunden erneut geprüft.`
              : `Job-ID ${jobId} · Statusabruf vorübergehend nicht möglich. Erneuter Versuch in ${seconds} Sekunden.`;
          schedule(delay);
        } finally {
          state.controller = null;
        }
      };
    jobPollers.set(jobId, state);
    schedule(2000 + Math.floor(Math.random() * 500));
    return state;
  }
  addEventListener("pagehide", () =>
    [...jobPollers].forEach(([id, state]) => {
      state.stopped = true;
      stopPollJob(id);
    }),
  );
  async function queueJob(context, action, button) {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const output = document.querySelector("#job-status");
    output.textContent = "Aktion wird gestartet …";
    try {
      const job = await request(
        `/management-inbox/autopilot/${encodeURIComponent(context.tender_id)}/jobs`,
        {
          method: "POST",
          body: JSON.stringify({ ...context, action_type: action }),
        },
      );
      localStorage.setItem(
        activeJobKey(context.tender_id, context.company_id),
        job.job_id,
      );
      output.innerHTML = renderJob(job);
      void pollJob(context.tender_id, context.company_id, job.job_id);
    } catch (error) {
      output.textContent = `Aktion fehlgeschlagen: ${error.message || error.status || "Unbekannter Fehler"}.`;
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
  const count = (data, key) => Number(data.counts?.[key] || 0),
    regionName = (item) =>
      (item.detected_states || []).join(", ") || "Nicht eindeutig ermittelt";
  function controls(data) {
    const companies = data.companies || [];
    const page=Number(data.page||1),pageSize=Number(data.pageSize||50),first=data.total?((page-1)*pageSize)+1:0,last=Math.min(page*pageSize,Number(data.total||0));
    const recalculation=(data.recalculations||[]).find(item=>["QUEUED","RUNNING","FAILED"].includes(item.status)),recalculationNotice=recalculation?`<section class="panel" role="status"><strong>${recalculation.status==="FAILED"?"Regionsprüfung benötigt technische Prüfung":"Regionsprüfung wird im Hintergrund aktualisiert"}</strong><p>${esc(recalculation.processed_count||0)} von ${esc(recalculation.total_count||0)} verarbeitet. Bis zum konsistenten Abschluss wird die letzte vollständig berechnete Inbox-Version angezeigt.</p></section>`:"";
    const configurationNotice=data.regionConfigurationStatus==="REGION_CONFIGURATION_MISSING"||count(data,"REGION_CONFIGURATION_MISSING")?`<section class="panel error" role="alert"><strong>REGION_CONFIGURATION_MISSING</strong><p>Für die ausgewählte Gesellschaft fehlt eine aktive autoritative Regionskonfiguration. Die Treffer bleiben gesperrt, bis die fachliche Konfiguration freigegeben wurde.</p></section>`:"";
    return `${configurationNotice}${recalculationNotice}<section class="toolbar region-toolbar"><label>Gesellschaft<select id="inbox-company"><option value="all">Alle relevanten Gesellschaften</option>${companies.map((x) => `<option value="${esc(x.company_id)}">${esc(x.legal_name)}</option>`).join("")}</select></label><label>Leistungsbereich<select id="inbox-service"><option value="">Alle Leistungsbereiche</option><option value="cleaning">Cleaning</option><option value="security">Security</option><option value="facility-management">Facility Management</option><option value="sicherheitstechnik">Sicherheitstechnik</option><option value="emergency-services">Emergency Services</option></select></label><label>Relevanzstatus<select id="inbox-relevance"><option value="relevant">Relevant</option><option value="review">Prüfung erforderlich</option><option value="excluded">Ausgeschlossen</option><option value="all">Alle</option></select></label><label>Regionsfilter<select id="inbox-region-filter"><option value="default">Kernregionen und strategische Regionen</option><option value="CORE_REGION">Kernregionen</option><option value="STRATEGIC_REGION">Strategische/bedingte Regionen</option><option value="OUTSIDE_CORE_REGION">Außerhalb der Kernregionen</option><option value="EXCLUDED_REGION">Ausgeschlossene Regionen</option><option value="REGION_UNRESOLVED">Region ungeklärt</option><option value="REGION_CONFIG_CONFLICT">Regionskonflikt</option><option value="MULTI_REGION_REVIEW">Mehrere Regionen – Einzelprüfung</option><option value="REGION_CONFIGURATION_MISSING">Regionskonfiguration fehlt</option><option value="all">Alle Regionen</option></select></label></section><section class="region-counts"><span>Kernregionen: <strong>${count(data, "CORE_REGION")}</strong></span><span>Strategisch: <strong>${count(data, "STRATEGIC_REGION")}</strong></span><span>Außerhalb: <strong>${count(data, "OUTSIDE_CORE_REGION")}</strong></span><span>Ausgeschlossen: <strong>${count(data, "EXCLUDED_REGION")}</strong></span><span>Ungeklärt: <strong>${count(data, "REGION_UNRESOLVED")}</strong></span><span>Regionskonflikt: <strong>${count(data, "REGION_CONFIG_CONFLICT")}</strong></span><span>Mehrregionenprüfung: <strong>${count(data, "MULTI_REGION_REVIEW")}</strong></span><span>Konfiguration fehlt: <strong>${count(data, "REGION_CONFIGURATION_MISSING")}</strong></span></section><nav class="toolbar inbox-pagination" aria-label="Seitennavigation"><button type="button" id="inbox-prev" ${page<=1?'disabled aria-disabled="true"':''}>Zurück</button><span>${first}–${last} von ${esc(data.total||0)}</span><button type="button" id="inbox-next" ${!data.hasMore?'disabled aria-disabled="true"':''}>Weiter</button></nav>`;
  }
  function portalCardAccess(item, portalAccess) {
    if (portalAccess?.loadError) return `<section class="card-portal-access" aria-label="Portalzugang"><p class="error">Portalzugangsstatus konnte nicht geladen werden. Die Ausschreibung und die belegten externen Ziele bleiben verfügbar.</p><a class="button-link" href="${esc(`${location.port ? "" : "/admin/ausschreibungen"}/autopilot/portal-access?company=${encodeURIComponent(item.company_id)}`)}">Portalzugangsverwaltung öffnen</a></section>`;
    const sourceItems = Array.isArray(portalAccess?.items) ? portalAccess.items : [],
      invalidItemCount = sourceItems.filter((portal) => !recordOrNull(portal)).length,
      seen = new Set(),
      portals = sourceItems.filter((portal) => {
        if (!recordOrNull(portal)) return false;
        const key = `${item.tender_id}|${item.lot_key || ""}|${portal.portal_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (!portals.length) return invalidItemCount
      ? `<section class="card-portal-access" aria-label="Portalzugang"><p class="error">Portalzugangsstatus enthält ${esc(invalidItemCount)} ungültige Datensätze. Die Portalzuordnung muss technisch geprüft werden.</p></section>`
      : "";
    return `<section class="card-portal-access" aria-label="Portalzugang">${invalidItemCount ? `<p class="error">${esc(invalidItemCount)} ungültige Portalzugangsdatensätze wurden nicht als fehlender Zugang interpretiert.</p>` : ""}${portals.map((p) => {
      const approvalState = p.access_status === "EXTERNAL_DOCUMENT_REQUEST_REQUIRED" && p.request_effect === "BIDDER_LIST_REGISTRATION_POSSIBLE" && !p.global_document_request_approval,
        manageUrl = `${location.port ? "" : "/admin/ausschreibungen"}/autopilot/portal-access?tender=${encodeURIComponent(item.tender_id)}&lot=${encodeURIComponent(item.lot_key || "")}&company=${encodeURIComponent(item.company_id)}&portal=${encodeURIComponent(p.portal_id)}`,
        missing = (p.missing_calculation_inputs || []).map(missingLabel);
      const documentCounts = p.documents_found == null && !p.last_attempt
        ? "Noch nicht abgerufen"
        : `${Number(p.documents_downloaded || 0)} / ${Number(p.documents_analyzed || 0)} von ${Number(p.documents_found || 0)}`;
      return `<article class="portal-access-card" data-portal-access="${esc(p.portal_id)}"><h3>${esc(p.portal_name || p.domain || "Vergabeportal")}</h3><dl><dt>Zugangsstatus</dt><dd><strong>${esc(credentialStatusLabel(p))}</strong></dd><dt>Dokumentstatus</dt><dd><strong>${esc(portalStatusLabel(p.document_status || p.access_status))}</strong></dd><dt>Gesellschaftsbezogener Zugang</dt><dd>${esc(p.credential?.configured ? `Vorhanden · ${p.credential.usernameMasked || "sicher maskiert"}` : "Noch nicht hinterlegt")}</dd><dt>Ursache</dt><dd>${esc(p.processing_blocker || p.login_required_reason || p.last_error || "Noch nicht ermittelt")}</dd><dt>Betroffene Dokumente</dt><dd>${documentList(p.affected_document_items)}</dd><dt>Geladen / analysiert</dt><dd>${esc(documentCounts)}</dd><dt>Verarbeitung</dt><dd>${esc(statusLabel(p.current_processing_step || p.processing_status || "Noch nicht gestartet"))}</dd><dt>Fehlende Kalkulationswerte</dt><dd>${esc(displayValue(missing, "Keine"))}</dd><dt>Letzter Abruf</dt><dd>${esc(formatDate(p.last_attempt))}</dd><dt>Nächster Retry</dt><dd>${esc(documentRetryLabel(p))}</dd></dl><div class="card-actions">${approvalState?`<button type="button" disabled aria-disabled="true">Freigabe für Dokumentenanforderung erforderlich</button>`:portalLoginPrimaryAction(p,manageUrl,{tender:item.tender_id,company:item.company_id,lot:item.lot_key})}${portalDocumentRefreshAction(p)}${evidenceLink(p.login_url ? {url:p.login_url,label:"Beim Vergabeportal anmelden",targetType:"LOGIN",provenanceLabel:"verifiziertes Portalregister"}:null)}${evidenceLink(p.registration_url ? {url:p.registration_url,label:"Beim Vergabeportal registrieren",targetType:"REGISTRATION",provenanceLabel:"verifiziertes Portalregister"}:null)}${portalManageButton(item,p)}</div><p class="muted portal-progress" data-portal-login-status="${esc(p.portal_id)}" aria-live="polite">${approvalState?'Keine externe Aktion ohne ausdrückliche tenderbezogene Freigabe.':esc(portalTruthMessage(p))}</p></article>`;
    }).join("")}</section>`;
  }
  function selectedCard(item, portalAccess = null) {
    item = { ...item, source_code: sourceDisplayName(item) };
    const missing = item.missingCalculationInputs || [];
    const route=(view)=>`${location.port?"":"/admin/ausschreibungen"}/autopilot/${view}?tender=${encodeURIComponent(item.tender_id)}&lot=${encodeURIComponent(item.lot_key||"")}&company=${encodeURIComponent(item.company_id)}`,
      calculated=["CALCULATED","CALCULATED_REAL","CALCULATION_COMPLETED"].includes(item.calculationStatus),
      managementReady=item.managementOutputStatus&&item.managementOutputStatus!=="NOT_CREATED",
      approvalRequested=item.approval_status==="REQUESTED",totals=item.calculation_totals||{},recommendation=item.management_recommendation?.decision||item.management_recommendation?.reason||"–",documentTruth=documentEvidenceSummary(item),portalTruth=item.linkEvidence?.procurementPortal?.portalName||item.linkEvidence?.missingReasons?.procurementPortal||"Vergabeportal-Nachweis nicht geladen";
    if(item.classification==="REGION_CONFIGURATION_MISSING")return `<article class="card region-card region-configuration-missing"><p><strong>REGION_CONFIGURATION_MISSING</strong></p><h2>${esc(item.title)}</h2><p>${esc(item.buyer||"–")}</p><dl><dt>Gesellschaft</dt><dd>${esc(item.company_name||"–")}</dd><dt>Leistungsbereich</dt><dd>${esc(item.service_line||"–")}</dd><dt>Handlungsstatus</dt><dd>Fachliche Regionskonfiguration erforderlich</dd><dt>Teilnahme / Submission</dt><dd>Gesperrt</dd></dl><p>Für diese Gesellschaft ist keine aktive autoritative Regionskonfiguration vorhanden. Es werden keine Regionen aus anderen Gesellschaften übernommen.</p><div class="card-actions"><button type="button" data-region-detail="${esc(item.tender_id)}" data-company="${esc(item.company_id)}" data-lot="${esc(item.lot_key||"")}">Details</button></div></article>`;
    if(!item.lot_key&&!item.noticeLifecycle)return `<article class="card region-card"><h2>${esc(item.title)}</h2><p>${esc(item.buyer||"–")}</p><dl><dt>Los</dt><dd>Auswahl erforderlich</dd><dt>Primärgesellschaft</dt><dd>${esc(item.company_name||"Keine")}</dd><dt>Leistungsbereich</dt><dd>${esc(item.service_line||"Konfiguration erforderlich")}</dd><dt>Region</dt><dd>${esc(labels[item.classification]||item.classification||"Ungeklärt")}</dd><dt>Frist</dt><dd>${esc(formatDate(item.offer_deadline))}</dd><dt>Teilnahmestatus</dt><dd>Loswahl erforderlich</dd></dl>${renderTenderLinkEvidence(item)}<p class="muted">Vor Teilnahme, Portal-, Dokument-, Kalkulations- oder Abgabeaktionen muss ein eindeutig teilnahmefähiges Los ausgewählt werden.</p><div class="card-actions"><button type="button" data-region-detail="${esc(item.tender_id)}" data-company="${esc(item.company_id)}">Teilnahmefähiges Los auswählen</button></div></article>`;
    if(item.noticeLifecycle){const life=item.noticeLifecycle,original=life.original,originalUrl=original?`${location.port?"":"/admin/ausschreibungen"}/autopilot/detail?tender=${encodeURIComponent(original.tenderId)}&company=${encodeURIComponent(item.company_id)}`:null;return `<article class="card region-card award-notice-card"><p><strong>${esc(life.statusLabel)}</strong></p><h2>${esc(item.title)}</h2><p>${esc(item.buyer||"–")}</p><dl><dt>Typ</dt><dd>${esc(life.noticeTypeLabel)}</dd><dt>Ergebnis</dt><dd>${esc(life.resultLabel)}</dd><dt>Los</dt><dd>${esc(item.lot_key||"Gesamt")}</dd><dt>Angebot</dt><dd>${esc(life.offerLabel)}</dd><dt>Portalzugriff</dt><dd>${esc(life.portalAccessLabel)}</dd><dt>Dokumentenstatus</dt><dd>${esc(life.documentStatusLabel)}</dd><dt>Kalkulation</dt><dd>${esc(life.calculationLabel)}</dd><dt>Managementfreigabe</dt><dd>Nicht erforderlich</dd><dt>Teilnahme / Submission</dt><dd>Nicht erforderlich</dd><dt>Monitoring</dt><dd>${esc(life.monitoringLabel)}</dd><dt>Zuschlagsdatum</dt><dd>${esc(formatDate(life.awardDate,"Nicht verfügbar"))}</dd></dl><div class="card-actions"><a class="button-link" href="${esc(route("detail"))}">Zuschlagsbekanntmachung öffnen</a>${originalUrl?`<a class="button-link primary-action" href="${esc(originalUrl)}">Zugehörige ursprüngliche Ausschreibung öffnen</a>`:""}</div>${original?"":'<p class="muted">Im Autopiloten ist keine über eine identische Procedure-ID autoritativ verknüpfbare ursprüngliche Ausschreibung vorhanden.</p>'}</article>`}
    return `<article class="card region-card"><h2>${esc(item.title)}</h2><p>${esc(item.buyer || "–")}</p>${approvalRequested?'<p><strong>MANAGEMENTENTSCHEIDUNG ERFORDERLICH</strong></p>':""}<dl><dt>Los</dt><dd>${esc(item.lot_key || "Gesamt")}</dd><dt>Primärgesellschaft</dt><dd>${esc(item.company_name || "Keine")}</dd><dt>Leistungsbereich</dt><dd>${esc(item.service_line || "Konfiguration erforderlich")}</dd><dt>Veröffentlichungsplattform</dt><dd>${esc(item.source_code || "Nicht ermittelt")}</dd><dt>Teilnahme-/Abgabeportal</dt><dd>${esc(portalTruth)}</dd><dt>Portalzugangstatus</dt><dd>${esc(item.portal_access_status ? statusLabel(item.portal_access_status) : "Noch nicht geprüft")}</dd><dt>Dokumentstatus</dt><dd><strong>${esc(documentTruth.label)}</strong> · ${esc(documentTruth.reason)}</dd><dt>Dokumentnachweis</dt><dd>${esc(documentTruth.counts)}</dd><dt>Extraktionsstatus</dt><dd>${esc(statusLabel(item.lastProcessedStep || "NO_PIPELINE_ATTEMPT"))}</dd><dt>Kalkulationsstatus</dt><dd><strong>${esc(calculationLabel(item.calculationStatus))}</strong></dd><dt>Angebotswert</dt><dd>${esc(totals.totalPrice??"–")}</dd><dt>DB1</dt><dd>${esc(totals.db1??"–")}</dd><dt>DB2</dt><dd>${esc(totals.db2??"–")}</dd><dt>DB3</dt><dd>${esc(totals.db3??"–")}</dd><dt>Gewinn</dt><dd>${esc(totals.profit??"–")}</dd><dt>Empfehlung</dt><dd>${esc(recommendation)}</dd><dt>Managementausgabe</dt><dd>${esc(statusLabel(item.managementOutputStatus || "NOT_CREATED"))}</dd><dt>Approval-Status</dt><dd><strong>${esc(item.approval_status||"–")}</strong></dd><dt>Entscheidungsstatus</dt><dd>${esc(approvalRequested?"MANAGEMENTENTSCHEIDUNG ERFORDERLICH":calculated&&managementReady?"Entscheidung erforderlich":"Noch nicht entscheidungsreif")}</dd><dt>Teilnahmestatus</dt><dd>Vorbereitung möglich</dd><dt>Angebotsstatus</dt><dd>Nicht freigegeben</dd><dt>Monitoringstatus</dt><dd>${esc(statusLabel(item.monitoringStatus || "INACTIVE"))}${item.monitoringLastCheckedAt ? ` · zuletzt ${esc(formatDate(item.monitoringLastCheckedAt))}` : ""}${item.monitoringNextCheckAt ? ` · nächste Prüfung ${esc(formatDate(item.monitoringNextCheckAt))}` : ""}</dd><dt>Frist</dt><dd>${esc(formatDate(item.offer_deadline))}</dd><dt>Letzter Verarbeitungsschritt</dt><dd>${esc(statusLabel(item.lastProcessedStep || "NO_PIPELINE_ATTEMPT"))}</dd><dt>Letzte Verarbeitung</dt><dd>${esc(formatDate(item.lastProcessedAt))}</dd><dt>Nächster Schritt</dt><dd>${esc(nextActionLabels[item.nextAction] || statusLabel(item.nextAction))}</dd>${missing.length ? `<dt>Fehlend (${esc(missing.length)})</dt><dd>${esc(missing.slice(0, 5).map(missingLabel).join(", "))}</dd>` : ""}<dt>Zuständige Ansprechperson</dt><dd>${esc(item.responsible_contact || "Noch nicht zugewiesen")}</dd></dl>${renderTenderLinkEvidence(item)}${portalCardAccess(item, portalAccess) || `<section data-portal-slot="${esc(item.tender_id)}" data-company="${esc(item.company_id)}" data-lot="${esc(item.lot_key || "")}" aria-live="polite"></section>`}<div class="card-actions"><a class="button-link primary-action" href="${esc(route("participation"))}">Teilnahme vorbereiten</a><button type="button" data-region-detail="${esc(item.tender_id)}" data-company="${esc(item.company_id)}">Details</button><a class="button-link" href="${esc(route("documents"))}">Interne Unterlagenansicht öffnen</a><a class="button-link" href="${esc(route("calculation"))}">Kalkulation öffnen</a>${managementReady?`<a class="button-link" href="${esc(route("management-output"))}">Managementausgabe öffnen</a>`:""}${approvalRequested||calculated&&managementReady?`<a class="button-link primary-action" href="${esc(route("detail"))}#entscheidung">Kalkulation und Angebot freigeben</a><a class="button-link" href="${esc(route("detail"))}#entscheidung">Änderung anfordern</a><a class="button-link" href="${esc(route("detail"))}#entscheidung">Ausschreibung ablehnen</a>`:""}<a class="button-link" href="${esc(route("offer-documents"))}">Angebotspaket öffnen</a><a class="button-link" href="${esc(route("approvals"))}">Abgabestatus öffnen</a><a class="button-link" href="${esc(route("audit"))}">Monitoring öffnen</a></div></article>`;
  }
  function allCard(item) {
    return selectedCard(item);
  }
  async function renderRegionInbox(initial = false) {
    const requestSequence=++inboxRequestSequence;
    inboxRequestController?.abort();
    inboxRequestController=new AbortController();
    active = true;
    content.innerHTML =
      "<p>Fachlich relevante Ausschreibungen werden geladen …</p>";
    try {
      let company = state.company;
      if (initial && !company) company = "all";
      const url = () =>
        `/management-inbox?company=${encodeURIComponent(company)}&regionClass=${encodeURIComponent(state.regionClass)}&relevance=${encodeURIComponent(state.relevance)}&serviceLine=${encodeURIComponent(state.serviceLine)}&page=${encodeURIComponent(state.page)}&pageSize=${encodeURIComponent(state.pageSize)}`;
      let data = await request(url(),{signal:inboxRequestController.signal});
      if(requestSequence!==inboxRequestSequence||!active)return;
      if (initial) {
        const saved = localStorage.getItem(preferenceKey),
          valid =
            saved === "all" ||
            data.companies.some((x) => x.company_id === saved);
        state.company = valid ? saved || "all" : "all";
        company = state.company;
        if (state.company !== String(data.selectedCompany))
          data = await request(url(),{signal:inboxRequestController.signal});
        if(requestSequence!==inboxRequestSequence||!active)return;
      } else state.company = String(data.selectedCompany || company);
      content.innerHTML = `${controls(data)}${data.items.length ? `<div class="grid region-grid">${data.items.map((item) => selectedCard(item)).join("")}</div>` : '<section class="panel"><p>Keine Ausschreibungen aus registrierten Portalen vorhanden.</p><a class="button-link" href="/admin/ausschreibungen/autopilot/portal-access">Portalzugänge verwalten</a></section>'}`;
      document.querySelectorAll("[data-portal-slot]").forEach((slot) => {
        const card = slot.closest("article.region-card");
        if (!card) return;
        card.dataset.contextTender = slot.dataset.portalSlot || "";
        card.dataset.contextCompany = slot.dataset.company || "";
        card.dataset.contextLot = slot.dataset.lot || "";
        const detail = card.querySelector("[data-region-detail]");
        if (detail) detail.dataset.lot = slot.dataset.lot || "";
      });
      const itemByKey = new Map(data.items.map((item) => [`${item.tender_id}|${item.company_id}|${item.lot_key || ""}`, item])),
        portalRequests = new Map(),
        observer = new IntersectionObserver((entries) => entries.forEach(async (entry) => {
          if (!entry.isIntersecting) return;
          const slot = entry.target,
            item = itemByKey.get(`${slot.dataset.portalSlot}|${slot.dataset.company || ""}|${slot.dataset.lot || ""}`);
          observer.unobserve(slot);
          if (!item) return;
          const portalRequestKey = `${item.tender_id}|${item.company_id}|${item.lot_key || ""}`,
            portalQuery = `?company=${encodeURIComponent(item.company_id)}&lot=${encodeURIComponent(item.lot_key || "")}`;
          if (!portalRequests.has(portalRequestKey)) portalRequests.set(portalRequestKey, request(`/portal-access/for-tender/${encodeURIComponent(item.tender_id)}${portalQuery}`).catch(() => ({ items: [] })));
          const markup = portalCardAccess(item, await portalRequests.get(portalRequestKey));
          if (markup) slot.outerHTML = markup;
          bindPortalLoginActions();
        }), { rootMargin: "300px 0px" });
      document.querySelectorAll("[data-portal-slot]").forEach((slot) => observer.observe(slot));
      const cs = document.querySelector("#inbox-company"),
        rs = document.querySelector("#inbox-region-filter"),
        rel = document.querySelector("#inbox-relevance"),
        service = document.querySelector("#inbox-service");
      cs.value = state.company;
      rs.value = state.regionClass;
      rel.value = state.relevance;
      service.value = state.serviceLine;
      cs.onchange = () => {
        state.company = cs.value;
        state.page = 1;
        const selected=data.companies.find(x=>String(x.company_id)===state.company);
        state.serviceLine=selected?.service_line||"";
        localStorage.setItem(preferenceKey, state.company);
        renderRegionInbox();
      };
      rs.onchange = () => {
        state.regionClass = rs.value;
        state.page = 1;
        renderRegionInbox();
      };
      rel.onchange = () => {
        state.relevance = rel.value;
        state.page = 1;
        renderRegionInbox();
      };
      service.onchange = () => {
        state.serviceLine = service.value;
        state.page = 1;
        if(state.company!=="all"&&state.serviceLine){const matching=data.companies.filter(x=>x.service_line===state.serviceLine);if(matching.length===1){state.company=String(matching[0].company_id);localStorage.setItem(preferenceKey,state.company)}}
        renderRegionInbox();
      };
      const previous=document.querySelector("#inbox-prev"),next=document.querySelector("#inbox-next");
      if(previous)previous.onclick=()=>{if(state.page>1){state.page-=1;renderRegionInbox()}};
      if(next)next.onclick=()=>{if(data.hasMore){state.page+=1;renderRegionInbox()}};
    } catch (error) {
      if(error.name==="AbortError"||requestSequence!==inboxRequestSequence)return;
      content.innerHTML = `<p class="error">Relevanzbewertung konnte nicht geladen werden (${esc(error.status || error.message)}).</p>`;
    }
  }
  const rows = (items) =>
    `<dl>${items.map((x) => `<dt>${esc(x.label || x.name || x.parameter)}</dt><dd><strong>${esc(x.status || "")}</strong>${x.value !== null && x.value !== undefined ? ` · ${esc(typeof x.value === "object" ? JSON.stringify(x.value) : x.value)}` : ""}${x.provenance ? `<details class="field-source"><summary>Quelle anzeigen</summary><dl><dt>Quelldokument</dt><dd>${esc(x.provenance.sourceDocument)}</dd><dt>Dateiname</dt><dd>${esc(x.provenance.filename)}</dd><dt>Version</dt><dd>${esc(x.provenance.documentVersion)}</dd><dt>Fundstelle</dt><dd>${esc(x.provenance.location)}</dd><dt>Extraktion</dt><dd>${esc(formatDate(x.provenance.extractedAt))}</dd><dt>Parser</dt><dd>${esc(x.provenance.parser)} · ${esc(x.provenance.parserVersion)}</dd></dl></details>` : ""}</dd>`).join("")}</dl>`;
  function section(title, body) {
    return `<section class="review-section"><h2>${esc(title)}</h2>${body}</section>`;
  }
  function renderReview(r) {
    if (!r) return "";
    const docs =
      (r.documents || [])
        .map(
          (x) =>
            `<li><strong>${esc(x.filename || "Dokument")}</strong> · Download: ${esc(x.status)} · Parser: ${esc(x.parserStatus || x.parser || "NOCH_NICHT_ANALYSIERT")} · ${esc(x.mimeType || "MIME unbekannt")}${x.url ? `<br><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Öffentliche Quelle öffnen</a>` : ""}</li>`,
        )
        .join("") || "<li>QUELLE_ENTHÄLT_KEINE_ANGABE</li>";
    return `<div class="review-result"><p class="review-decision">${esc(r.recommendation.decision)}</p><p>${esc(r.recommendation.reason)}</p><p class="muted">Datenanreicherung: ${esc(r.enrichmentStatus)} · Version ${esc(r.enrichmentVersion || "–")}</p>${section("1. Vergabedaten", rows(r.procurement))}${section("2. Leistungsumfang", rows(r.scope))}${section("Ausschreibungsunterlagen", `<ul>${docs}</ul>`)}${section("3. Leistungs- und CPV-Matching", `<p><strong>${esc(r.serviceMatching.status)}</strong> · ${esc(r.serviceMatching.reason)}</p>${rows(r.serviceMatching.checks)}`)}${section("4. Regionsprüfung", `<p><strong>${esc(r.region.status || r.region.classification)}</strong> · ${esc(r.region.explanation)}</p>`)}${section("5. Eignung und Nachweise", rows(r.evidence))}${section("6. Kapazität und Umsetzbarkeit", `<p><strong>${esc(r.capacity.status)}</strong> · ${esc(r.capacity.reason)}</p>${rows(r.capacity.checks)}`)}${section("7. Kalkulation", `<p><strong>${esc(r.calculation.status)}</strong></p>${r.calculation.missing?.length ? `<p>Fehlende Angaben: ${esc(r.calculation.missing.join(", "))}</p>` : ""}${r.calculation.targetPrice ? `<dl><dt>Benötigte Stunden</dt><dd>${esc(r.calculation.neededHours)}</dd><dt>Direkte Lohnkosten</dt><dd>${esc(r.calculation.directWages)}</dd><dt>Preisuntergrenze</dt><dd>${esc(r.calculation.priceFloor)}</dd><dt>Zielpreis</dt><dd>${esc(r.calculation.targetPrice)}</dd></dl>` : ""}`)}${section("8. Risiko und Wirtschaftlichkeit", rows(r.risks))}${section("9. Abschließende Empfehlung", `<dl><dt>Erfüllte Gates</dt><dd>${esc(r.recommendation.fulfilledGates.join(", ") || "Keine")}</dd><dt>Nicht erfüllte Gates</dt><dd>${esc(r.recommendation.failedGates.join(", ") || "Keine")}</dd><dt>Fehlende Unterlagen</dt><dd>${esc(r.recommendation.missingDocuments.join(", ") || "Keine")}</dd><dt>Offene Fragen</dt><dd>${esc(r.recommendation.openQuestions.join(", ") || "Keine")}</dd><dt>Nächste Schritte</dt><dd>${esc(r.recommendation.nextSteps.join(", ") || "Keine")}</dd><dt>Empfohlener Angebotspreis</dt><dd>${esc(r.recommendation.recommendedPrice ?? "Nicht belastbar")}</dd><dt>Zuschlagswahrscheinlichkeit</dt><dd>${esc(r.recommendation.awardProbability ?? "Keine belastbare Schätzung")} · ${esc(r.recommendation.awardProbabilityReason)}</dd></dl>`)}<p class="muted">Version ${esc(r.evaluationVersion)} · ${esc(formatDate(r.evaluatedAt))}</p></div>`;
  }
  const portalStatusLabel = (status) => ({
    LOGIN_REQUIRED: "Anmeldung erforderlich",
    MFA_REQUIRED: "MFA-Bestätigung erforderlich",
    SESSION_EXPIRED: "Portalsitzung abgelaufen",
    SESSION_MISSING: "Portalsitzung fehlt",
    LOGIN_FAILED: "Anmeldung fehlgeschlagen",
    CREDENTIALS_NOT_CONFIGURED: "Portalzugang nicht konfiguriert",
    PORTAL_UNREACHABLE: "Portal technisch nicht erreichbar",
    DOWNLOAD_LINK_UNRESOLVED: "Downloadlink wird erneut aufgelöst",
    EXTERNAL_DOCUMENT_REQUEST_REQUIRED: "Dokumentenfreischaltung erforderlich",
    DOCUMENT_NOT_FOUND: "Dokument nicht gefunden",
    ACCESS_DENIED: "Dokumentzugriff verweigert",
    DOWNLOAD_SUCCEEDED: "Download erfolgreich",
    DOCUMENTS_AVAILABLE: "Dokumente vollständig verfügbar",
    DOCUMENTS_PARTIALLY_AVAILABLE: "Dokumente teilweise verfügbar",
  })[status] || status || "Noch nicht geprüft";
  const credentialStatusLabel = (portalValue) => {
    const portal = recordOrNull(portalValue);
    if (!portal) return "Zugangsstatus technisch nicht verfügbar";
    return portal.credential_status_label || ({
    NOT_CONFIGURED: "Kein Portalzugang hinterlegt",
    CREDENTIAL_SCOPE_CONFLICT: "Gesellschaftszuordnung des Portalzugangs prüfen",
    CONFIGURED_UNVERIFIED: "Zugang gespeichert, noch nicht verifiziert",
    VALID: "Gültiger Portalzugang vorhanden",
    MFA_REQUIRED: "MFA-Bestätigung erforderlich",
    CAPTCHA_OR_USER_ACTION_REQUIRED: "Fortsetzung im Portal erforderlich",
    EXPIRED: "Portalzugang oder Sitzung abgelaufen",
    INVALID: "Portalzugang ungültig",
    LOCKED: "Portalzugang gesperrt",
    PORTAL_UNAVAILABLE: "Portal vorübergehend nicht erreichbar",
    VALIDATION_PENDING: "Zugangsprüfung läuft",
    })[portal.credential_status] || "Zugangsstatus technisch nicht verfügbar";
  };
  const documentRetryLabel = (portalValue) => {
    const portal = recordOrNull(portalValue);
    if (!portal) return "Kontextprüfung erforderlich";
    if (portal.documents_complete) return "Kein erneuter Abruf erforderlich";
    if (portal.next_retry) return formatDate(portal.next_retry);
    if (["NOT_CONFIGURED", "CREDENTIAL_SCOPE_CONFLICT", "CONFIGURED_UNVERIFIED", "MFA_REQUIRED", "CAPTCHA_OR_USER_ACTION_REQUIRED", "EXPIRED", "INVALID", "LOCKED"].includes(portal.credential_status))
      return "Aktualisierung nach erfolgreicher Portalzugangsprüfung";
    return "Nicht eingeplant";
  };
  function portalLoginPrimaryAction(p, manageUrl) {
    const action = p.login_action;
    if (!action || !action.binding) return "";
    const { type: actionType, label, binding } = action;
    if (actionType === "MANAGE_CREDENTIALS") return "";
    if (actionType === "OPEN_PORTAL_READ_ONLY" && p.portal_open_url)
      return `<a class="button-link primary-action" data-portal-open="${esc(binding.portal_id)}" href="${esc(p.portal_open_url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
    if (actionType === "AUTHENTICATION_TARGET_UNAVAILABLE")
      return `<button type="button" disabled aria-disabled="true" data-portal-login-unavailable="${esc(binding.portal_id)}">Portal-Login nicht konfiguriert</button>`;
    if (!["START_LOGIN", "CONFIRM_MFA", "CONFIRM_CAPTCHA"].includes(actionType)) return "";
    return `<button type="button" class="primary-action" data-portal-login="${esc(binding.portal_id)}" data-portal-url="${esc(p.portal_url || "")}" data-tender="${esc(binding.tender_id)}" data-company="${esc(binding.company_id)}" data-lot="${esc(binding.lot_key)}">${esc(label)}</button>`;
  }
  function portalDocumentRefreshAction(p) {
    const action = p.document_refresh_action,
      binding = action?.binding;
    if (action?.type !== "REFRESH_DOCUMENTS" || !binding) return "";
    return `<button type="button" data-portal-document-refresh="${esc(binding.portal_id)}" data-tender="${esc(binding.tender_id)}" data-company="${esc(binding.company_id)}" data-lot="${esc(binding.lot_key)}">${esc(action.label || "Dokumente aktualisieren")}</button>`;
  }
  const documentStatusLabel = (status) => ({
    PORTAL_ACCESS_REQUIRED: "Portalzugang erforderlich",
    DOWNLOAD_SUCCEEDED: "Download erfolgreich",
    DOWNLOAD_FAILED: "Download fehlgeschlagen",
    DOCUMENT_NOT_FOUND: "Dokument nicht gefunden",
    VORHANDEN: "Vorhanden",
  })[status] || status || "Noch nicht geladen";
  function bindPortalLoginActions(defaultContext = {}) {
    // The capture-phase continuation handler above owns both dashboard and
    // detail buttons. No fetch job is created before LOGIN_SUCCESSFUL.
  }
  function renderPortalAccess(data, x) {
    const sourceItems = Array.isArray(data?.items) ? data.items : [],
      invalidItemCount = sourceItems.filter((item) => !recordOrNull(item)).length,
      items = sourceItems.filter(recordOrNull);
    if (!items.length && invalidItemCount) return section("Detailunterlagen und Portalzugang", `<p class="error">Portalzugangsstatus enthält ${esc(invalidItemCount)} ungültige Datensätze. Dies wird nicht als fehlender Zugang oder leere Liste behandelt.</p>`);
    if (!items.length) return data?.loadError ? `<section class="review-section"><h2>Detailunterlagen und Portalzugang</h2><p class="error">Portalzugangsstatus konnte nicht geladen werden: ${esc(data.loadError)}. Die belegten Quelllinks oben bleiben davon unabhängig nutzbar.</p></section>` : "";
    return section("Detailunterlagen und Portalzugang", `${invalidItemCount ? `<p class="error">${esc(invalidItemCount)} ungültige Portalzugangsdatensätze wurden nicht als fehlender Zugang interpretiert.</p>` : ""}${items.map((p) => {
      const approvalState = p.access_status === "EXTERNAL_DOCUMENT_REQUEST_REQUIRED" && p.request_effect === "BIDDER_LIST_REGISTRATION_POSSIBLE" && !p.global_document_request_approval,
        manageUrl = `${contextUrl(x, "portal-access")}&portal=${encodeURIComponent(p.portal_id)}&tender=${encodeURIComponent(x.actionContext?.tender_id || "")}`,
        documents = documentList(p.affected_document_items, true);
      return `<article class="portal-access-detail" data-portal-access="${esc(p.portal_id)}"><dl><dt>Bekanntmachungsquelle</dt><dd>${esc(p.notice_source || "Nicht ermittelt")}</dd><dt>Zielportal für Detailunterlagen</dt><dd><strong>${esc(p.portal_name)}</strong> · ${esc(p.domain)}</dd><dt>Sichere Portalreferenz</dt><dd>${esc(p.portal_open_url || p.portal_url || p.domain)}</dd><dt>Zugangsstatus</dt><dd><strong>${esc(credentialStatusLabel(p))}</strong></dd><dt>Dokumentstatus</dt><dd><strong>${esc(portalStatusLabel(p.document_status || p.access_status))}</strong></dd><dt>Konkrete Ursache</dt><dd>${esc(p.login_required_reason)}</dd><dt>Letzter Abrufversuch</dt><dd>${esc(formatDate(p.last_attempt))}</dd><dt>Letzter Fehler</dt><dd>${esc(p.last_error || "Kein technischer Portalausfall festgestellt")}</dd><dt>Nächster Retry</dt><dd>${esc(documentRetryLabel(p))}</dd><dt>Dadurch fehlende Kalkulationswerte</dt><dd>${esc((p.missing_calculation_inputs || []).map(missingLabel).join(", ") || "Keine")}</dd></dl><h3>Betroffene Dokumente</h3>${documents}<div class="review-actions">${approvalState?`<button type="button" disabled aria-disabled="true">Freigabe für Dokumentenanforderung erforderlich</button>`:portalLoginPrimaryAction(p,manageUrl,{tender:x.actionContext?.tender_id,company:x.actionContext?.company_id,lot:x.actionContext?.lot_key})}${portalDocumentRefreshAction(p)}<a class="button-link" href="${esc(manageUrl)}">${esc(p.credential_status === "NOT_CONFIGURED" ? "Zugangsdaten hinterlegen" : ["EXPIRED","INVALID"].includes(p.credential_status) ? "Zugang aktualisieren" : "Zugangsdaten verwalten")}</a>${p.notice_url ? `<a href="${esc(p.notice_url)}" target="_blank" rel="noopener noreferrer">Öffentliche Bekanntmachung öffnen</a>` : ""}</div><p class="muted" data-portal-login-status="${esc(p.portal_id)}" aria-live="polite">${approvalState?'Keine externe Aktion ohne ausdrückliche tenderbezogene Freigabe.':esc(portalTruthMessage(p,true))}</p></article>`;
    }).join("")}`);
  }
  const actionButton = (label, attributes, allowed, reason) =>
    `<span class="action-control"><button type="button" ${attributes} ${allowed ? "" : `disabled aria-disabled="true" aria-describedby="reason-${attributes.match(/data-(?:action|job-action)=\"([^\"]+)/)?.[1] || "action"}"`}>${esc(label)}</button>${allowed ? "" : `<small class="action-unavailable" id="reason-${attributes.match(/data-(?:action|job-action)=\"([^\"]+)/)?.[1] || "action"}">${esc(reason)}</small>`}</span>`;
  const contextUrl = (x, view = "detail") => {
    const url = new URL(
        `${location.port ? "" : "/admin/ausschreibungen"}/autopilot/${view}`,
        location.origin,
      ),
      c = x.actionContext || {};
    [
      ["tender", c.tender_id],
      ["ausschreibung", c.tender_id],
      ["lot", c.lot_key || c.lot_id],
      ["company", c.company_id],
      ["service", c.service_scope],
      ["enrichment", c.enrichment_version_id],
      ["version", x.autopilot?.result_version || c.assessment_version_id],
    ].forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "")
        url.searchParams.set(key, value);
    });
    return url.pathname + url.search;
  };
  async function downloadExport(path, label, button) {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const status = document.querySelector("#action-status"),
      requestId = crypto.randomUUID();
    status.textContent = `${label} wird erzeugt · Request-ID ${requestId}`;
    try {
      const response = await fetch(API + path, { credentials: "same-origin" });
      if (!response.ok) {
        let body = {};
        try {
          body = await response.json();
        } catch {}
        throw Error(body.message || (response.status === 401 ? "Anmeldung oder MFA-Sitzung erforderlich." : response.status === 403 ? "Keine Berechtigung für diese Aktion." : response.status === 409 ? "Der Stand hat sich geändert. Bitte laden Sie die Ansicht neu." : response.status === 423 ? "Diese rechtlich bindende Portalaktion ist gesperrt. Es wurde nichts übermittelt." : response.status >= 500 ? "Die Aktion konnte wegen eines technischen Fehlers nicht abgeschlossen werden." : `Die Aktion konnte nicht abgeschlossen werden (${response.status}).`));
      }
      const blob = await response.blob(),
        disposition = response.headers.get("content-disposition") || "",
        filename =
          disposition.match(/filename=\"?([^\";]+)\"?/i)?.[1] ||
          `${label}.json`,
        url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      status.textContent = `${label} wurde erstellt und heruntergeladen · Request-ID ${requestId} · ${filename}`;
    } catch (error) {
      status.textContent = `${label} fehlgeschlagen: ${error.message}.`;
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
  function showActionForm(kind, x) {
    const host = document.querySelector("#action-form"),
      c = x.actionContext,
      deadline = x.deadline?.value ? new Date(x.deadline.value) : null,
      defaultReminder = deadline
        ? new Date(deadline.getTime() - 86400000).toISOString().slice(0, 16)
        : "",
      status = document.querySelector("#action-status");
    if (kind === "task")
      host.innerHTML = `<form id="detail-action-form" class="detail-action-form"><h2>Aufgabe erstellen</h2><label>Titel<input name="title" required maxlength="300" value="${esc(`Ausschreibung prüfen: ${x.title}`)}"></label><label>Fällig am<input name="due_at" type="datetime-local" value="${esc(deadline ? deadline.toISOString().slice(0, 16) : "")}"></label><button type="submit">Aufgabe speichern</button><button type="button" data-form-cancel>Abbrechen</button></form>`;
    else if (kind === "reminder")
      host.innerHTML = `<form id="detail-action-form" class="detail-action-form"><h2>Wiedervorlage erstellen</h2><label>Zeitpunkt<input name="remind_at" type="datetime-local" required value="${esc(defaultReminder)}"></label><label>Grund<input name="reason" maxlength="500" value="Ausschreibung erneut prüfen"></label><button type="submit">Wiedervorlage speichern</button><button type="button" data-form-cancel>Abbrechen</button></form>`;
    else
      host.innerHTML = `<form id="detail-action-form" class="detail-action-form"><h2>Frist übernehmen</h2><dl><dt>Frist</dt><dd>${esc(x.deadline?.value || "Fehlt")}</dd><dt>Fristtyp</dt><dd>${esc(x.deadline?.type || "Nicht ermittelt")}</dd><dt>Quelle</dt><dd>${esc(x.deadline?.source || "Nicht ermittelt")}</dd></dl><button type="submit">Interne Frist speichern</button><button type="button" data-form-cancel>Abbrechen</button></form>`;
    host.hidden = false;
    host.querySelector("[data-form-cancel]").onclick = () => {
      host.hidden = true;
      host.innerHTML = "";
    };
    host.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      const submit = event.submitter;
      submit.disabled = true;
      const data = new FormData(event.currentTarget),
        payload = { ...c };
      if (kind === "task") {
        payload.title = data.get("title");
        payload.due_at = data.get("due_at")
          ? new Date(data.get("due_at")).toISOString()
          : null;
      } else if (kind === "reminder") {
        payload.remind_at = new Date(data.get("remind_at")).toISOString();
        payload.reason = data.get("reason");
      } else {
        payload.deadline_at = x.deadline?.value;
        payload.deadline_type = x.deadline?.type;
        payload.deadline_source = x.deadline?.source;
      }
      status.textContent = `${kind === "task" ? "Aufgabe" : kind === "reminder" ? "Wiedervorlage" : "Frist"} wird gespeichert …`;
      try {
        const result = await request(
          `/management-inbox/actions/${encodeURIComponent(c.tender_id)}/${kind}`,
          { method: "POST", body: JSON.stringify(payload) },
        );
        status.textContent = `Gespeichert · Request-ID ${result.request_id} · ID ${result.id || "vorhanden"}`;
        host.hidden = true;
        host.innerHTML = "";
      } catch (error) {
        status.textContent = `Speichern fehlgeschlagen: ${error.message}.`;
        submit.disabled = false;
      }
    };
  }
  async function showDetail(tenderId, companyId, lotKey = "") {
    content.innerHTML = "<p>Detail wird geladen …</p>";
    try {
      if(!lotKey){
        const saved=await request(`/lot-selections/${encodeURIComponent(tenderId)}?company=${encodeURIComponent(companyId)}`).catch(()=>({item:null}));
        lotKey=saved.item?.lotKey||"";
      }
      const x = await request(
          `/management-inbox/region-detail/${encodeURIComponent(tenderId)}?company=${encodeURIComponent(companyId)}&lot=${encodeURIComponent(lotKey)}`,
        ),
        c = x.actionContext || {},
        portalAccess = c.lot_key?await request(`/portal-access/for-tender/${encodeURIComponent(tenderId)}?company=${encodeURIComponent(companyId)}&lot=${encodeURIComponent(c.lot_key)}`).catch(error=>({items:[],loadError:error.message||"Unbekannter Fehler"})):{items:[]},
        missing = x.missingContext || [],
        contextReady = missing.length === 0,
        pipelineMissing = missing.filter((field) => field !== "enrichment_version_id"),
        initializableMissing = missing.filter((key) => key !== "enrichment_version_id"),
        initializableReady = pipelineMissing.length === 0,
        contextReason = contextReady
          ? ""
          : `Erforderlicher Kontext fehlt: ${missing.join(", ")}. Detailseite neu laden oder Tenderdaten vervollständigen.`,
        initializableContextReason = initializableReady
          ? ""
          : `Erforderlicher Kontext fehlt: ${initializableMissing.join(", ")}. Detailseite neu laden oder Tenderdaten vervollständigen.`,
        permission = (name, label, canInitialize = false) =>
          x.permissions?.[name]
            ? canInitialize ? initializableContextReason : contextReason
            : `Berechtigung ${label} fehlt.`,
        allowed = (name, canInitialize = false) => Boolean(x.permissions?.[name] && (canInitialize ? initializableReady : contextReady)),
        jobButtons = [
          ["Unterlagen abrufen und analysieren", "RUN_FULL_PIPELINE"],
          ["Anreicherung aktualisieren", "REFRESH_ENRICHMENT"],
          ["Dokumente erneut abrufen", "FETCH_DOCUMENTS"],
          ["Dokumente erneut analysieren", "ANALYZE_DOCUMENTS"],
        ]
          .map(([label, action]) =>
            actionButton(
              label,
              `data-job-action="${action}"`,
              allowed("evaluate", true),
              permission("evaluate", "tender.evaluate", true),
            ),
          )
          .join(""),
        calcUrl = contextUrl(x, "calculation");
      const savedLabels={favorite:"Favorit gespeichert",task_created:"Aufgabe gespeichert",internal_deadline_adopted:"Frist übernommen",reminder_created:"Wiedervorlage gespeichert"},saved=(x.savedInternalActions||[]).map(item=>`<li>${esc(savedLabels[item.action]||"Interne Aktion gespeichert")} · ${esc(formatDate(item.created_at))}</li>`).join("");
      x.source_code = sourceDisplayName(x);
      const eligibleLots=(x.lots||[]).filter(lot=>lot.lifecycle_status==="ACTIVE"&&lot.participation_status==="ELIGIBLE"&&lot.deadline_quality==="EXACT"&&lot.deadline&&new Date(lot.deadline)>new Date()),lotSelection=c.lot_key?"":`<section class="review-section"><h2>Teilnahmefähiges Los auswählen</h2>${eligibleLots.length?eligibleLots.map(lot=>`<button type="button" data-select-participation-lot="${esc(lot.external_id)}">${esc(lot.external_id)}${lot.title?` · ${esc(lot.title)}`:""} · Frist ${esc(formatDate(lot.deadline))}</button>`).join(""):"<p>Kein eindeutig teilnahmefähiges Los verfügbar.</p>"}</section>`,participationAction=contextReady?`<a class="button-link primary-action" href="${esc(contextUrl(x,"participation"))}">Teilnahme vorbereiten</a>`:"";
      content.innerHTML = `<article class="panel region-detail"><button type="button" id="region-back">← Zur Management-Inbox</button><h1>${esc(x.title)}</h1><dl><dt>Bewertete Gesellschaft</dt><dd>${esc(x.company_name)}</dd><dt>Los</dt><dd>${esc(c.lot_key || "Gesamt")}</dd><dt>Veröffentlichungsquelle</dt><dd>${esc(x.source_code || "Nicht ermittelt")}</dd><dt>Dokumentstatus</dt><dd>${esc(documentEvidenceSummary(x).label)} · ${esc(documentEvidenceSummary(x).reason)}</dd><dt>Leistungsort/Bundesland</dt><dd>${esc((x.detected_states || []).join(", ") || "Nicht eindeutig ermittelt")}</dd><dt>NUTS-Region</dt><dd>${esc((x.detected_nuts || []).join(", ") || "Fehlt")}</dd><dt>Angewendete Regionsregel</dt><dd>${esc(x.parameter_key || "Keine aktive Regionsregel")}</dd><dt>Aktive Konfigurationsversion</dt><dd>${esc(x.configuration_version_no || "Keine")}</dd><dt>Ergebnis</dt><dd>${esc(labels[x.classification] || x.classification)} · ${esc(x.regional_decision)}</dd><dt>Begründung</dt><dd>${esc(x.explanation)}</dd></dl>${renderTenderLinkEvidence(x,true)}${saved?`<section class="review-section"><h2>Gespeicherte interne Aktionen</h2><ul>${saved}</ul></section>`:""}<div class="review-actions">${actionButton("Prüfung aktualisieren", 'class="primary-action" id="run-full-review" data-job-action="REFRESH_REVIEW"', allowed("evaluate", true), permission("evaluate", "tender.evaluate", true))}${jobButtons}${actionButton("Prüfbericht exportieren", 'data-action="review-export"', Boolean(x.fullReview && x.permissions?.evaluate), x.fullReview ? "Berechtigung tender.evaluate fehlt." : "Noch kein Prüfbericht vorhanden. Zuerst Prüfung aktualisieren.")}${actionButton("Vorstandsvorlage exportieren", 'data-action="board-export"', Boolean(x.autopilot?.board_brief && x.permissions?.board), x.autopilot?.board_brief ? "Berechtigung tender.board.view fehlt." : "Noch keine Vorstandsvorlage vorhanden. Zuerst vollständige Prüfung ausführen.")}${x.favoriteSaved?actionButton("Favorit gespeichert", 'data-action="favorite-saved"', false, "Dieser Favorit ist dauerhaft gespeichert."):actionButton("Als Favorit speichern", 'data-action="favorite"', allowed("favorite"), permission("favorite", "tender.favorite"))}${actionButton("Aufgabe erstellen", 'data-action="task"', allowed("task"), permission("task", "tender.task.manage"))}${actionButton("Frist übernehmen", 'data-action="deadline"', Boolean(allowed("deadline") && x.deadline?.value), x.deadline?.value ? permission("deadline", "tender.deadline.manage") : "Keine Frist im Tender oder Los vorhanden.")}${actionButton("Wiedervorlage erstellen", 'data-action="reminder"', allowed("deadline"), permission("deadline", "tender.deadline.manage"))}${actionButton("Kalkulation öffnen", 'data-action="calculation"', allowed("calculation"), permission("calculation", "tender.view_assigned"))}<a class="button-link primary-action" data-tender-autopilot-detail href="${esc(contextUrl(x, "detail"))}">Im Tender-Autopiloten öffnen</a></div>${renderPortalAccess(portalAccess, x)}<section id="action-form" class="review-section" hidden></section><div id="review-output">${renderReview(x.fullReview)}</div><p id="job-status" aria-live="polite"></p><p id="action-status" aria-live="polite">${x.favoriteSaved?"Favorit ist gespeichert.":""}</p></article>`;
      const detailPanel=document.querySelector("article.region-detail");
      if(lotSelection)detailPanel?.querySelector("h1")?.insertAdjacentHTML("afterend",lotSelection);
      if(participationAction)detailPanel?.querySelector(".review-actions")?.insertAdjacentHTML("afterbegin",participationAction);
      detailPanel?.querySelectorAll("[data-select-participation-lot]").forEach(button=>button.addEventListener("click",async()=>{
        const selectedLot=button.dataset.selectParticipationLot||"";
        button.disabled=true;
        button.setAttribute("aria-pressed","true");
        const selectionStatus=document.createElement("p");selectionStatus.setAttribute("role","status");selectionStatus.textContent="Los wird gespeichert …";button.insertAdjacentElement("afterend",selectionStatus);
        try{await request(`/lot-selections/${encodeURIComponent(tenderId)}`,{method:"POST",body:JSON.stringify({companyId,lotKey:selectedLot})});selectionStatus.textContent="Los gespeichert.";await showDetail(tenderId,companyId,selectedLot)}
        catch(error){selectionStatus.textContent=`Los konnte nicht gespeichert werden: ${error.message}`;button.disabled=false;button.setAttribute("aria-pressed","false")}
      }));
      document.querySelector("#region-back").onclick = () =>
        renderRegionInbox();
      bindPortalLoginActions({ tenderId, companyId, lotKey: c.lot_key || null });
      document
        .querySelectorAll("[data-job-action]")
        .forEach(
          (button) =>
            (button.onclick = () =>
              queueJob(c, button.dataset.jobAction, button)),
        );
      const savedJob = localStorage.getItem(activeJobKey(tenderId, companyId));
      if (savedJob) void pollJob(tenderId, companyId, savedJob);
      document
        .querySelector('[data-action="review-export"]')
        ?.addEventListener("click", (event) =>
          downloadExport(
            `/management-inbox/full-review/${encodeURIComponent(tenderId)}/export?company=${encodeURIComponent(companyId)}&lot=${encodeURIComponent(c.lot_key || "")}`,
            "Prüfbericht",
            event.currentTarget,
          ),
        );
      document
        .querySelector('[data-action="board-export"]')
        ?.addEventListener("click", (event) =>
          downloadExport(
            `/management-inbox/autopilot/${encodeURIComponent(tenderId)}/board-brief?company=${encodeURIComponent(companyId)}&lot=${encodeURIComponent(c.lot_key || "")}`,
            "Vorstandsvorlage",
            event.currentTarget,
          ),
        );
      document
        .querySelector('[data-action="favorite"]')
        ?.addEventListener("click", async (event) => {
          const button = event.currentTarget;
          if (button.disabled) return;
          button.disabled = true;
          const status = document.querySelector("#action-status");
          status.textContent = "Favorit wird gespeichert …";
          try {
            const result = await request(
              `/management-inbox/actions/${encodeURIComponent(tenderId)}/favorite`,
              { method: "POST", body: JSON.stringify(c) },
            );
            status.textContent = `Als Favorit gespeichert · Request-ID ${result.request_id}`;
          } catch (error) {
            status.textContent = `Favorit fehlgeschlagen: ${error.message}.`;
            button.disabled = false;
          }
        });
      ["task", "deadline", "reminder"].forEach((action) =>
        document
          .querySelector(`[data-action="${action}"]`)
          ?.addEventListener("click", () => showActionForm(action, x)),
      );
      document
        .querySelector('[data-action="calculation"]')
        ?.addEventListener("click", () => {
          document.querySelector("#action-status").textContent =
            `Kalkulation wird geöffnet · Tender ${c.tender_id} · Los ${c.lot_key || "Gesamt"} · Gesellschaft ${c.company_id}`;
          location.assign(calcUrl);
        });
    } catch (error) {
      content.innerHTML = `<p class="error">Detail konnte nicht geladen werden (${esc(error.message || error.status)}).</p>`;
    }
  }
  document.addEventListener(
    "click",
    (event) => {
      const inbox = [...tabs.querySelectorAll("button")].find(
        (x) => x.textContent === "Management-Inbox",
      );
      if (event.target === inbox) {
        event.preventDefault();
        event.stopImmediatePropagation();
        [...tabs.children].forEach((x) => x.classList.remove("active"));
        inbox.classList.add("active");
        renderRegionInbox(true);
        return;
      }
      const detail = event.target.closest?.("[data-region-detail]");
      if (active && detail) {
        event.preventDefault();
        showDetail(
          detail.dataset.regionDetail,
          detail.dataset.company,
          detail.dataset.lot || "",
        );
      }
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      if (active && (event.target.id === "q" || event.target.id === "source"))
        event.stopImmediatePropagation();
    },
    true,
  );
})();
(() => {
  "use strict";
  const base = location.port ? "" : "/admin/ausschreibungen";
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const safeHttpsUrl = (value) => {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol !== "https:" || url.username || url.password) return null;
      for (const key of url.searchParams.keys()) if (/^(?:access_?token|auth(?:entication|orization)?|bearer|code|credential|id_?token|jwt|key|password|refresh_?token|secret|session(?:id)?|sid|ticket|token)$/i.test(key)) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  };
  const safeManageUrl = (value) => {
    try {
      const url = new URL(String(value || ""), location.origin);
      return url.origin === location.origin && url.pathname.endsWith("/autopilot/portal-access") ? `${url.pathname}${url.search}` : null;
    } catch { return null; }
  };
  const displayValue = (value, fallback = "Nicht hinterlegt") => value === null || value === undefined || value === "" ? fallback : String(value);
  const errorMessage = (status) => ({
    401: "Portalzugang konnte nicht geladen werden. Bitte melden Sie sich erneut mit MFA an.",
    403: "Sie besitzen keine Berechtigung zur Verwaltung dieses Portalzugangs.",
    404: "Das Vergabeportal oder die Ausschreibung konnte nicht gefunden werden.",
    409: "Die Portalzuordnung hat sich geändert. Bitte laden Sie sie erneut.",
  })[status] || "Portalzugang konnte nicht geladen werden.";
  const portalDialog = () => {
    let dialog = document.querySelector("#portal-access-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "portal-access-dialog";
      dialog.className = "portal-access-dialog";
      document.body.append(dialog);
    }
    return dialog;
  };
  const showDialog = (dialog) => {
    if (!dialog.open) dialog.showModal?.();
    if (!dialog.open) dialog.setAttribute("open", "");
  };
  const dialogFrame = (body, actions = "") => `<form method="dialog" class="panel"><h2>Portalzugang verwalten</h2><p class="muted">Mandanten- und gesellschaftsgebundene Metadaten. Geheimnisse und MFA-Codes werden hier niemals angezeigt.</p>${body}<div class="review-actions">${actions}<button type="submit">Abbrechen</button></div></form>`;
  const renderPortalAccess = (dialog, button, payload) => {
    const portal = payload?.items?.[0];
    if (!portal) {
      const reason = displayValue(payload?.reason, "Für diese Gesellschaft ist noch kein Portalzugang hinterlegt.");
      dialog.innerHTML = dialogFrame(`<div class="status-message" role="status"><p><strong>Kein Portalzugang verfügbar</strong></p><p>${escapeHtml(reason)}</p></div>`);
      return;
    }
    const credential = portal.credential || {};
    const loginUrl = safeHttpsUrl(portal.login_url);
    const registrationUrl = safeHttpsUrl(portal.registration_url);
    const manageUrl = payload.canManage === false ? null : safeManageUrl(button.dataset.manageUrl);
    const mfa = credential.mfaRequired === true ? "ja" : credential.mfaRequired === false ? "nein" : "unbekannt";
    const accessState = credential.configured ? displayValue(portal.access_status, "LOGIN_UNGEPRUEFT") : "Für diese Gesellschaft ist noch kein Portalzugang hinterlegt.";
    const body = `<dl><dt>Portal</dt><dd>${escapeHtml(displayValue(portal.portal_name, button.dataset.portalName))}</dd><dt>Kanonischer Portalhost</dt><dd>${escapeHtml(displayValue(portal.canonical_domain || portal.domain, button.dataset.portalHost))}</dd><dt>Gesellschaft</dt><dd>${escapeHtml(displayValue(button.dataset.companyName))}</dd><dt>Leistungsbereich</dt><dd>${escapeHtml(displayValue(button.dataset.service, "Nicht ermittelt"))}</dd><dt>Zugangsstatus</dt><dd>${escapeHtml(accessState)}</dd><dt>Benutzername / E-Mail</dt><dd>${escapeHtml(displayValue(credential.usernameMasked))}</dd><dt>Interner Kontoname</dt><dd>${escapeHtml(displayValue(credential.internalLabel))}</dd><dt>Verantwortliche Person</dt><dd>${escapeHtml(displayValue(credential.contactPerson))}</dd><dt>Registrierungsstatus</dt><dd>${escapeHtml(displayValue(credential.registrationStatus, "NICHT_REGISTRIERT"))}</dd><dt>Loginstatus</dt><dd>${escapeHtml(displayValue(credential.loginStatus, "LOGIN_UNGEPRUEFT"))}</dd><dt>MFA erforderlich</dt><dd>${escapeHtml(mfa)}</dd><dt>Letzte erfolgreiche Prüfung</dt><dd>${escapeHtml(displayValue(credential.lastManualCheckAt, "Nicht geprüft"))}</dd><dt>Loginadresse</dt><dd>${loginUrl ? `<a href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener noreferrer">Beim Vergabeportal anmelden</a>` : "Loginseite noch nicht verifiziert"}</dd><dt>Registrierungsadresse</dt><dd>${registrationUrl ? `<a href="${escapeHtml(registrationUrl)}" target="_blank" rel="noopener noreferrer">Beim Vergabeportal registrieren</a>` : "Registrierungsseite noch nicht verifiziert"}</dd><dt>Hinweise</dt><dd>${escapeHtml(displayValue(credential.notes, "Keine Hinweise"))}</dd></dl>${payload.canManage === false ? '<p class="status-message">Sie besitzen keine Berechtigung zur Verwaltung dieses Portalzugangs.</p>' : ""}`;
    const actions = `${manageUrl ? `<a class="button-link primary-action" href="${escapeHtml(manageUrl)}">Zugang auswählen oder Metadaten bearbeiten</a>` : ""}${loginUrl ? `<a class="button-link" href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener noreferrer">Loginseite öffnen</a>` : ""}`;
    dialog.innerHTML = dialogFrame(body, actions);
  };
  const loadPortalAccess = async (button) => {
    const dialog = portalDialog();
    dialog.innerHTML = dialogFrame('<p class="status-message" role="status">Portalzugang wird geladen …</p>');
    showDialog(dialog);
    const tenderId = String(button.dataset.tender || ""), companyId = String(button.dataset.company || "");
    if (!tenderId || !companyId || !button.dataset.portalHost) {
      dialog.innerHTML = dialogFrame('<p class="status-message" role="alert">Das Vergabeportal konnte nicht eindeutig ermittelt werden.</p>');
      return;
    }
    const query = new URLSearchParams({ company: companyId, lot: String(button.dataset.lot || "") });
    try {
      const response = await fetch(`${location.port ? "/api" : "/api/tender"}/portal-access/for-tender/${encodeURIComponent(tenderId)}?${query}`, { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!response.ok) throw Object.assign(new Error("portal_access_load_failed"), { status: response.status });
      renderPortalAccess(dialog, button, await response.json());
    } catch (error) {
      dialog.innerHTML = dialogFrame(`<p class="status-message" role="alert">${escapeHtml(errorMessage(error?.status))}</p>`, '<button type="button" data-retry-portal-access>Erneut versuchen</button>');
      dialog.querySelector("[data-retry-portal-access]")?.addEventListener("click", () => void loadPortalAccess(button), { once: true });
    }
  };
  const addMainEntry = () => {
    const nav = document.querySelector("#tabs");
    if (!nav || nav.querySelector("[data-tender-autopilot-entry]")) return;
    const link = document.createElement("a");
    link.dataset.tenderAutopilotEntry = "true";
    link.className = "button-link";
    link.href = `${base}/autopilot/overview`;
    link.textContent = "Tender-Autopilot";
    nav.append(link);
  };
  let selected = null;
  document.addEventListener(
    "click",
    (event) => {
      const portalButton = event.target.closest?.("[data-open-portal-access]");
      if (portalButton) {
        event.preventDefault();
        void loadPortalAccess(portalButton);
        return;
      }
      const detail = event.target.closest?.("[data-region-detail]");
      if (detail)
        selected = {
          tenderId: detail.dataset.regionDetail,
          companyId: detail.dataset.company,
          lotKey: detail.dataset.lot || "",
        };
    },
    true,
  );
  const addDetailEntry = async () => {
    const actions = document.querySelector(".region-detail .review-actions");
    if (
      !actions ||
      actions.querySelector("[data-tender-autopilot-detail]") ||
      actions.dataset.autopilotLoading ||
      !selected
    )
      return;
    actions.dataset.autopilotLoading = "true";
    const { tenderId, companyId, lotKey } = selected;
    const response = await fetch(
      `${location.port ? "/api" : "/api/tender"}/autopilot/navigation/context/${encodeURIComponent(tenderId)}?company=${encodeURIComponent(companyId)}&lot=${encodeURIComponent(lotKey || "")}`,
      { credentials: "same-origin" },
    );
    if (!response.ok) {
      delete actions.dataset.autopilotLoading;
      if (response.status === 403) {
        const status = document.querySelector("#action-status");
        if (status)
          status.textContent = "Keine Berechtigung für den Tender-Autopiloten.";
      }
      return;
    }
    const context = await response.json(),
      result = context.result || {},
      review = result.review || {};
    const url = new URL(`${base}/autopilot/detail`, location.origin);
    [
      ["tender", tenderId],
      ["ausschreibung", tenderId],
      ["lot", context.selected?.lotKey || ""],
      ["company", companyId],
      ["service", context.company?.service_line || review.serviceLine || ""],
      [
        "enrichment",
        context.enrichment?.version || review.enrichmentVersion || "",
      ],
      [
        "version",
        context.selected?.resultVersion || review.evaluationVersion || "",
      ],
    ].forEach(([key, value]) => {
      if (value !== "" && value !== null && value !== undefined)
        url.searchParams.set(key, value);
    });
    const link = document.createElement("a");
    link.dataset.tenderAutopilotDetail = "true";
    link.className = "button-link primary-action";
    link.href = url.pathname + url.search;
    link.textContent = "Im Tender-Autopiloten öffnen";
    actions.append(link);
  };
  addMainEntry();
  new MutationObserver(() => {
    addMainEntry();
    void addDetailEntry();
  }).observe(document.body, { childList: true, subtree: true });
})();
