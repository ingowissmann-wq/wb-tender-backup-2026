(() => {
  "use strict";
  const BASE = document.body.dataset.base,
    API = document.body.dataset.api,
    nav = document.querySelector("#autopilot-nav"),
    out = document.querySelector("#autopilot-content");
  const views = [
    ["revenue-dashboard", "Womit verdienen wir als nächstes Geld?"],
    ["overview", "Tender-Übersicht"],
    ["readiness", "Produktumfang & Readiness"],
    ["operational-approvals", "Sprint 4 – Operative Freigaben"],
    ["internal-acceptance", "Interne Abnahme"],
    ["detail", "Tender-Detail"],
    ["sources", "Quellen"],
    ["scheduler", "Schedulerstatus"],
    ["versions", "Versionen"],
    ["matching", "Matching"],
    ["hard-gates", "Hard Gates"],
    ["pre-go-no-go", "Pre-Go/No-Go"],
    ["documents", "Dokumentenanalyse"],
    ["requirements", "Anforderungen"],
    ["evidence", "Nachweise"],
    ["tasks", "Aufgaben"],
    ["calculation", "Kalkulation"],
    ["scenarios", "Szenarien"],
    ["management-output", "Managementausgabe"],
    ["documents-inbox", "Unterlagen nachzureichen"],
    ["signatures", "Zu unterschreiben"],
    ["board-brief", "Vorstandsvorlage"],
    ["offer-documents", "Angebotsunterlagen"],
    ["connectors", "Connectorstatus"],
    ["portals", "Portalstatus"],
    ["approvals", "Freigaben"],
    ["audit", "Audit-Log"],
    ["settings", "Einstellungen"],
    ["portal-access", "Portalzugänge"],
    ["company-profiles", "Gesellschaftsprofile"],
    ["regions", "Regionale Zonen"],
    ["matching-rules", "Matching-Regeln"],
    ["score-rules", "Score-Regeln"],
  ];
  views.splice(20, 0, ["submission-status", "Abgabestatus"]);
  const labels = Object.fromEntries(views),
    trustedPresentationMarkup = Symbol("trustedPresentationMarkup"),
    trustedMarkup = (html) => ({ [trustedPresentationMarkup]: html }),
    esc = (v) =>
      String(v ?? "–").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
  const portalDocumentList = (documents) => {
    const items = (documents || []).map((document) => {
      const raw = String(document.filename || document.sourceDocumentId || "Dokument"),
        match = raw.match(/^[{(]?([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})[)}]?(\.[a-z0-9]{1,8})?$/i),
        name = match ? `Portal-Dokument${match[2] || ""}` : raw,
        reference = match?.[1] || (document.sourceDocumentId && document.sourceDocumentId !== raw ? String(document.sourceDocumentId) : "");
      return `<li><strong class="document-name">${esc(name)}</strong>${reference ? `<small class="document-reference">Referenz: <code title="${esc(reference)}">${esc(match ? `${reference.slice(0, 8)}…${reference.slice(-4)}` : reference)}</code></small>` : ""}</li>`;
    }).join("");
    return `<ul class="affected-document-list">${items || "<li>Keine Dokumentreferenz vorhanden</li>"}</ul>`;
  };
  const state = () => {
    const u = new URL(location.href),
      parts = u.pathname.split("/").filter(Boolean),
      i = parts.lastIndexOf("autopilot"),
      p = u.searchParams,
      g = (...keys) => keys.map((k) => p.get(k)).find(Boolean) || "";
    return {
      view: views.some((v) => v[0] === parts[i + 1])
        ? parts[i + 1]
        : "overview",
      tender: g("tender", "tenderId"),
      ausschreibung: g("ausschreibung", "procurementId"),
      notice: g("notice", "noticeId", "noticeNumber"),
      title: g("title"),
      lot: g("lot", "lotId"),
      company: g("company", "companyId"),
      service: g("service", "serviceLine"),
      enrichment: g("enrichment", "enrichmentVersion"),
      version: g("version", "assessmentVersion"),
      query: g("query"),
      previous: g("previous"),
    };
  };
  const href = (view, s = state()) => {
    const u = new URL(BASE + "/autopilot/" + view, location.origin);
    [
      ["tender", s.tender],
      ["ausschreibung", s.ausschreibung],
      ["notice", s.notice],
      ["title", s.title],
      ["lot", s.lot],
      ["company", s.company],
      ["service", s.service],
      ["enrichment", s.enrichment],
      ["version", s.version],
      ["query", s.query],
      [
        "previous",
        view === "overview" && s.view !== "overview" ? s.view : s.previous,
      ],
    ].forEach(([k, v]) => {
      if (v || (k === "lot" && s.tender && s.company)) u.searchParams.set(k, v);
    });
    return u.pathname + u.search;
  };
  function navigation() {
    const s = state();
    nav.innerHTML = `<div class="notice" role="status"><strong>REAL-OPERATIONS – KEINE EXTERNE ABGABE</strong><br>Irreversible Portalaktionen sind serverseitig gesperrt.</div>`+views
      .map(
        ([id, label]) =>
          `<a class="nav-link${id === s.view ? " active" : ""}" ${id === s.view ? 'aria-current="page" ' : ""}href="${esc(href(id, s))}">${esc(label)}</a>`,
      )
      .join("");
  }
  async function get(path, options = {}) {
    const r = await fetch(API + path, {
        credentials: "same-origin",
        ...options,
      }),
      requestId = r.headers.get("x-request-id") || "nicht verfügbar";
    if (!r.ok) {
      let detail = {};
      try {
        detail = await r.json();
      } catch {}
      const e = new Error(
        detail.message ||
          (r.status === 403
            ? "Keine Berechtigung für diese Ansicht."
            : r.status === 401
              ? "Anmeldung oder MFA-Sitzung erforderlich."
              : `Abruf fehlgeschlagen (${r.status}).`),
      );
      e.requestId = requestId;
      e.status = r.status;
      e.retryAfter = Number(r.headers.get("retry-after")) || null;
      throw e;
    }
    return r.json();
  }
  const csrf = () =>
    decodeURIComponent(
      document.cookie
        .split("; ")
        .find((x) => x.startsWith("wb_csrf="))
        ?.split("=")
        .slice(1)
        .join("=") || "",
    );
  async function mutate(path, method = "POST", body = {}) {
    const r = await fetch(API + path, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": csrf() },
      body: method === "DELETE" ? undefined : JSON.stringify(body),
    });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (!r.ok) throw Error(data.message || (r.status === 401 ? "Anmeldung oder MFA-Sitzung erforderlich." : r.status === 403 ? "Keine Berechtigung für diese Aktion." : r.status === 409 ? "Der Stand hat sich geändert. Bitte laden Sie die Ansicht neu." : r.status === 423 ? "Diese rechtlich bindende Portalaktion ist gesperrt. Es wurde nichts übermittelt." : r.status >= 500 ? "Die Aktion konnte wegen eines technischen Fehlers nicht abgeschlossen werden." : `Die Aktion konnte nicht abgeschlossen werden (${r.status}).`));
    if (data.job_id) {
      const portalId =
        path.match(/^\/portal-access\/([^/]+)\/jobs/)?.[1] || null;
      localStorage.setItem(
        `wb-tender-job:${data.job_id}`,
        JSON.stringify({ jobId: data.job_id, portalId, createdAt: Date.now() }),
      );
      setTimeout(() => trackJob(data.job_id), 0);
    }
    return data;
  }
  const fieldLabels = {
    id: "Technische ID",
    version: "Version",
    version_no: "Version",
    service_line: "Leistungsbereich",
    serviceLine: "Leistungsbereich",
    cpv_codes: "CPV-Codes",
    cpvCodes: "CPV-Codes",
    keywords: "Suchbegriffe",
    synonyms: "Synonyme",
    exclusions: "Ausschlussbegriffe",
    weight: "Gewichtung",
    semantic_enabled: "Semantisches Matching",
    semanticEnabled: "Semantisches Matching",
    active: "Status",
    enabled: "Status",
    source_code: "Quelle",
    offer_deadline: "Angebotsfrist",
    created_at: "Erstellt am",
    updated_at: "Aktualisiert am",
    started_at: "Gestartet am",
    finished_at: "Abgeschlossen am",
    next_run_at: "Nächster Lauf",
    last_run_status: "Letzter Laufstatus",
    current_step: "Aktueller Verarbeitungsschritt",
    action_type: "Vorgang",
    status: "Status",
    company_id: "Gesellschaft",
    lot_key: "Los",
    title: "Bezeichnung",
    legal_name: "Gesellschaft",
    classification: "Bewertung",
    reason: "Begründung",
    fetch_status: "Dokumentenabruf",
    result_version: "Ergebnisversion",
    pipeline_version: "Pipelineversion",
  };
  const enumLabels = {
    ACTIVE: "Aktiv",
    INACTIVE: "Inaktiv",
    REQUESTED: "Freigabe erforderlich",
    APPROVED: "Freigegeben",
    REJECTED: "Abgelehnt",
    PENDING: "Wartet auf Verarbeitung",
    QUEUED: "Wartet auf Verarbeitung",
    CLAIMED: "In Bearbeitung",
    RUNNING: "In Bearbeitung",
    RETRY: "Erneuter Versuch vorgesehen",
    SUCCEEDED: "Erfolgreich abgeschlossen",
    DONE: "Erfolgreich abgeschlossen",
    FAILED: "Fehlgeschlagen",
    DEAD_LETTER: "Nach mehreren Versuchen fehlgeschlagen",
    CALCULATION_QUEUED: "Kalkulation wartet auf Verarbeitung",
    START_CALCULATION: "Kalkulation wird als Nächstes gestartet",
    SESSION_EXPIRED: "Portalsitzung abgelaufen",
    AUTO_REAUTHENTICATING: "Automatische erneute Anmeldung läuft",
    LOGIN_SUCCESSFUL: "Anmeldung erfolgreich",
    DOCUMENT_FETCH_RESUMED: "Dokumentenabruf wird fortgesetzt",
    AUTO_LOGIN_REQUIRED: "Erneute Portalanmeldung erforderlich",
    DOCUMENT_FETCH_QUEUED: "Dokumentenabruf wartet auf Verarbeitung",
    CALCULATED_REAL: "Vollständig kalkuliert",
    CALCULATION_PARTIAL: "Teilkalkulation",
    GO: "Freigabe empfohlen",
    CONDITIONAL_GO: "Freigabe empfohlen – unter Vorbehalt",
    NO_GO: "Freigabe nicht empfohlen",
    HIGH: "Hohe Priorität",
    MEDIUM: "Mittlere Priorität",
    LOW: "Niedrige Priorität",
    PASSED: "Bestanden",
    NOT_APPLICABLE: "Nicht erforderlich",
    RELEVANT: "Relevant",
    EXCLUDED: "Ausgeschlossen",
    LOGIN_STARTED: "Anmeldung gestartet",
    WAITING_FOR_USER: "Anmeldung wartet auf Bestätigung",
    MFA_REQUIRED: "MFA-Bestätigung erforderlich",
  };
  const emptyValue = (kind = "value") =>
      kind === "list"
        ? "Keine"
        : kind === "required"
          ? "Noch nicht ermittelt"
          : "Nicht verfügbar",
    booleanDisplay = (value, active = false) =>
      active ? (value ? "Aktiv" : "Inaktiv") : value ? "Ja" : "Nein",
    germanDateTime = (value) => {
      if (!value) return emptyValue();
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? String(value)
        : `${new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date)}, ${new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)} Uhr`;
    },
    currencyDisplay = (value) =>
      value == null
        ? emptyValue()
        : new Intl.NumberFormat("de-DE", {
            style: "currency",
            currency: "EUR",
          }).format(Number(value)),
    percentageDisplay = (value) =>
      value == null
        ? emptyValue()
        : `${new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))} %`,
    humanizedEnum = (value) =>
      enumLabels[String(value)] ||
      String(value)
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase()),
    statusBadge = (value) =>
      `<span class="status-badge">${esc(humanizedEnum(value))}</span>`,
    tagList = (values) =>
      values?.length
        ? `<span class="tag-list">${values.map((value) => `<span class="tag">${esc(typeof value === "object" ? value.label || value.name || value.code || humanizedEnum(value.status || "Eintrag") : humanizedEnum(value))}</span>`).join("")}</span>`
        : esc(emptyValue("list")),
    sourceReference = (value) =>
      value
        ? `<span class="source-reference">${esc(typeof value === "object" ? value.documentName || value.filename || value.label || value.source || "Quellennachweis vorhanden" : value)}</span>`
        : esc("Nicht vorhanden");
  const uuidValue = (value) =>
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
    technicalKey = (key) =>
      /(^id$|_id$|Id$|uuid|sha|hash|payload|raw|snapshot|correlation|request_id|job_id|audit_id|cipher|token|internal|manifest)/i.test(
        key,
      ),
    isIso = (value) =>
      typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value),
    isEnum = (value) =>
      typeof value === "string" &&
      /^[A-ZÄÖÜ0-9]+(?:_[A-ZÄÖÜ0-9]+)+$/.test(value),
    fieldLabel = (key) => fieldLabels[key] || humanizedEnum(key),
    technicalDetails = (row, label = "Technische Details und Audit") => {
      const entries = Object.entries(row || {}).filter(
        ([key, value]) => technicalKey(key) || uuidValue(value),
      );
      return entries.length
        ? `<details class="technical-details"><summary>${esc(label)}</summary><dl>${entries.map(([key, value]) => `<dt>${esc(fieldLabel(key))}</dt><dd><code>${esc(value && typeof value === "object" ? JSON.stringify(value) : (value ?? emptyValue()))}</code></dd>`).join("")}</dl></details>`
        : "";
    };
  function presentationValue(value, key = "") {
    if (
      value &&
      typeof value === "object" &&
      typeof value[trustedPresentationMarkup] === "string"
    )
      return value[trustedPresentationMarkup];
    if (value == null || value === "")
      return esc(emptyValue(Array.isArray(value) ? "list" : "value"));
    if (typeof value === "boolean")
      return esc(booleanDisplay(value, /active|enabled|status/i.test(key)));
    if (
      isIso(value) ||
      (/(?:_at|date|deadline|frist)$/i.test(key) &&
        !Number.isNaN(new Date(value).getTime()))
    )
      return esc(germanDateTime(value));
    if (typeof value === "number") {
      if (/price|cost|amount|value_eur|betrag|kosten|preis/i.test(key))
        return esc(currencyDisplay(value));
      if (/percent|percentage|quote|margin|marge/i.test(key))
        return esc(percentageDisplay(value));
      return esc(
        new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(
          value,
        ),
      );
    }
    if (Array.isArray(value)) return tagList(value);
    if (typeof value === "object") {
      const visible = Object.entries(value).filter(
        ([child]) => !technicalKey(child),
      );
      return visible.length
        ? `<dl class="presentation-object">${visible.map(([child, item]) => `<dt>${esc(fieldLabel(child))}</dt><dd>${presentationValue(item, child)}</dd>`).join("")}</dl>${technicalDetails(value)}`
        : technicalDetails(value);
    }
    if (isEnum(value)) return statusBadge(value);
    return esc(value);
  }
  const val = (value, key = "") => presentationValue(value, key);
  function table(rows, preferred = []) {
    if (!rows?.length)
      return '<p class="muted">Für diesen Kontext liegen keine Einträge vor.</p>';
    const allKeys = [
        ...new Set([
          ...preferred,
          ...rows.flatMap((row) => Object.keys(row || {})),
        ]),
      ].filter((key) => rows.some((row) => row?.[key] !== undefined)),
      keys = allKeys
        .filter(
          (key) =>
            !technicalKey(key) &&
            !rows.every((row) => row[key] == null || uuidValue(row[key])),
        )
        .slice(0, 12);
    return `<div class="panel presentation-table"><div class="presentation-grid">${rows
      .map(
        (row) =>
          `<article class="presentation-card">${
            keys.length
              ? `<dl>${keys
                  .filter((key) => row[key] !== undefined)
                  .map(
                    (key) =>
                      `<dt>${esc(fieldLabel(key))}</dt><dd>${val(row[key], key)}</dd>`,
                  )
                  .join("")}</dl>`
              : '<p class="muted">Keine fachlichen Anzeigewerte vorhanden.</p>'
          }${technicalDetails(row)}</article>`,
      )
      .join("")}</div></div>`;
  }
  let normalizingPresentation = false;
  function normalizeRenderedPresentation(root = out) {
    if (normalizingPresentation || !root) return;
    normalizingPresentation = true;
    try {
      for (const dl of root.querySelectorAll("dl")) {
        if (dl.closest("details.technical-details")) continue;
        const technical = [];
        for (const dt of [...dl.querySelectorAll(":scope > dt")]) {
          if (
            !/(?:Job-ID|Request-ID|Snapshot|Payload|Correlation|Audit-ID|Manifest)/i.test(
              dt.textContent || "",
            )
          )
            continue;
          const dd = dt.nextElementSibling;
          if (dd?.tagName === "DD")
            technical.push([dt.textContent, dd.textContent]),
              dt.remove(),
              dd.remove();
        }
        if (technical.length)
          dl.insertAdjacentHTML(
            "afterend",
            `<details class="technical-details"><summary>Technische Details und Audit</summary><dl>${technical.map(([label, value]) => `<dt>${esc(label)}</dt><dd><code>${esc(value)}</code></dd>`).join("")}</dl></details>`,
          );
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (
          node.parentElement?.closest(
            "details.technical-details,code,pre,script,style",
          )
        )
          continue;
        let text = node.nodeValue || "";
        text = text
          .replace(
            /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
            "Technische Referenz hinterlegt",
          )
          .replace(
            /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g,
            (value) => germanDateTime(value),
          )
          .replace(/\b(?:true|false)\b/gi, (value) =>
            booleanDisplay(value.toLowerCase() === "true"),
          );
        text = text.replace(
          /\b[A-ZÄÖÜ][A-ZÄÖÜ0-9]+(?:_[A-ZÄÖÜ0-9]+)+\b/g,
          (value) => humanizedEnum(value),
        );
        if (node.nodeValue !== text) node.nodeValue = text;
      }
    } finally {
      normalizingPresentation = false;
    }
  }
  new MutationObserver(() => normalizeRenderedPresentation()).observe(out, {
    subtree: true,
    childList: true,
  });
  const title = (name, sub = "") =>
    `<h2>${esc(name === "Portalzugänge" ? "Portalverwaltung" : name)}</h2>${sub ? `<p class="muted">${esc(sub)}</p>` : ""}`;
  function contextRequired(s) {
    out.innerHTML =
      title(
        labels[s.view],
        "Für diese Ansicht ist ein Tenderkontext erforderlich.",
      ) +
      `<section class="panel"><p>Bitte wählen Sie zuerst einen Tender aus.</p><a class="button-link" href="${esc(href("overview", s))}">Zur Tender-Übersicht</a></section>`;
  }
  function pickLink(row, s) {
    const n = {
      ...s,
      tender: row.tender_id,
      company: row.company_id,
      lot: row.lot_key || "",
      version: "",
    };
    return trustedMarkup(
      `<a href="${esc(href("detail", n))}">${esc(row.title || row.tender_id)}</a>`,
    );
  }
  async function overview(s) {
    const u = new URL(location.href),
      hasTarget = Boolean(s.tender || s.ausschreibung || s.notice || s.title),
      relevance =
        u.searchParams.get("relevance") || (hasTarget ? "all" : "relevant"),
      [d, dlq] = await Promise.all([
        get(
          `/autopilot/navigation/overview?relevance=${encodeURIComponent(relevance)}`,
        ),
        get("/autopilot/dlq-summary"),
      ]),
      norm = (v) =>
        String(v ?? "")
          .normalize("NFKD")
          .replace(/\p{Diacritic}/gu, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim(),
      q = norm(s.query || s.tender || s.ausschreibung || s.notice || s.title),
      matches = (x) => {
        const text = norm(
          [
            x.title,
            x.tender_id,
            x.external_id,
            x.notice_number,
            x.procurement_number,
            x.ted_id,
            x.buyer,
            x.lot_key,
            x.lot_number,
            x.lot_title,
            x.canonical_procedure_id,
            ...(x.source_notices || []).flatMap((notice) => [notice.publicationId, notice.sourceCode]),
            ...(x.lots || []).flatMap((lot) => [lot.lot_key, lot.lot_title]),
            (x.cpv_codes || []).join(" "),
            (x.regions || []).join(" "),
          ].join(" "),
        );
        return (
          (!q || text.includes(q)) &&
          (!s.company || String(x.company_id) === s.company) &&
          (!s.service || norm(x.service_line).includes(norm(s.service))) &&
          (!s.lot ||
            [x.lot_id, x.lot_key, x.lot_number].some(
              (v) => String(v || "") === s.lot,
            ))
        );
      },
      score = (x) =>
        (String(x.tender_id) === s.tender ? 100 : 0) +
        (String(x.lot_id) === s.lot || String(x.lot_key) === s.lot ? 20 : 0) +
        (String(x.company_id) === s.company ? 10 : 0),
      items = d.items.filter(matches).sort((a, b) => score(b) - score(a)),
      active = new Set(["PENDING", "CLAIMED", "RETRY", "QUEUED", "RUNNING"]),
      status = (x) =>
        `<dl><dt>Fachlicher Pipelinezustand</dt><dd>${esc(humanizedEnum(x.pipeline_status || "IN_PROGRESS"))}</dd><dt>Nächster fachlicher Schritt</dt><dd>${esc(humanizedEnum(x.pipeline_step || "SOURCE_RESOLVED"))}</dd><dt>Tatsächliches Dokumentenportal</dt><dd>${esc(x.document_portal || "Noch nicht ermittelt")}</dd><dt>Portalzugangsstatus</dt><dd>${esc(humanizedEnum(x.portal_access_status || "Noch nicht geprüft"))}</dd><dt>Dokumente gefunden / fachlich verifiziert / analysiert</dt><dd>${esc(x.documents_found || 0)} / ${esc(x.documents_downloaded || 0)} / ${esc(x.documents_analyzed || 0)}</dd><dt>Kalkulationsstatus</dt><dd>${esc(humanizedEnum(x.calculation_status || x.stage_status?.calculation || "Noch nicht gestartet"))}</dd><dt>Verarbeitungsstatus</dt><dd>${esc(humanizedEnum(x.job_status || "Kein aktiver Job"))}</dd><dt>Fortschritt</dt><dd>${esc(x.progress_percent || 0)} %</dd><dt>Fachlicher Blockierungsgrund</dt><dd>${esc(humanizedEnum(x.pipeline_blocking_state || x.blocking_reason || "–"))}</dd><dt>Fehlende Kalkulationsdaten</dt><dd>${esc((x.missing_calculation_inputs || []).map((v) => `${v.field} (${v.source}, Los ${v.lot}, Dokumentstatus ${humanizedEnum(v.documentStatus)}; ${v.nextAction})`).join("; ") || "–")}</dd><dt>Letzte Aktualisierung</dt><dd>${esc(calcDate(x.job_updated_at || x.created_at))}</dd></dl>${x.relevance_status === "RELEVANT" && x.service_scope_gate === "PASSED" && x.pipeline_status !== "FACHLICH_COMPLETED" && !active.has(x.job_status) ? `<button type="button" data-run-pipeline="${esc(x.tender_id)}" data-company="${esc(x.company_id)}" data-lot="${esc(x.lot_key || "")}">Nächsten fehlenden Schritt starten</button>` : ""}`,
      lotLinks = (x) => (x.lots || []).map((lot) => `<li><a href="${esc(href("detail",{...s,tender:lot.tender_id,company:lot.company_id,lot:lot.lot_key||""}))}">${esc(lot.lot_key || "Gesamt")}${lot.lot_title ? ` · ${esc(lot.lot_title)}` : ""}</a> · Dokumente ${esc(lot.documents_analyzed || 0)}/${esc(lot.documents_found || 0)} · ${esc(humanizedEnum(lot.calculation_status || "NOT_STARTED"))}</li>`).join(""),
      dq = dlq.summary || {};
    out.innerHTML =
      title(
        labels[s.view],
        "Kanonische, fachlich gefilterte Tender-Verarbeitung",
      ) +
      `<section class="panel"><h3>DLQ-Betriebsstatus</h3><dl><dt>Aktuelle ungelöste DLQ</dt><dd>${esc(dq.current_unresolved || 0)}</dd><dt>Historisch behoben</dt><dd>${esc(dq.historical_resolved || 0)}</dd><dt>Historisch obsolet</dt><dd>${esc(dq.historical_obsolete || 0)}</dd><dt>Externe Portalfehler</dt><dd>${esc(dq.external_portal_failures || 0)}</dd><dt>Manuell zu prüfen</dt><dd>${esc(dq.manual_review_required || 0)}</dd><dt>Historische Auditspur</dt><dd>${esc(dq.historical_audit_total || 0)} Einträge, vollständig erhalten</dd></dl></section><section class="toolbar"><label>Suche<input id="autopilot-query" value="${esc(s.query || s.tender || s.ausschreibung || s.notice || s.title)}"></label><label>Gesellschaft<select id="autopilot-company"><option value="">Alle</option>${d.companies.map((c) => `<option value="${esc(c.company_id)}">${esc(c.legal_name)}</option>`).join("")}</select></label><label>Relevanzstatus<select id="autopilot-relevance"><option value="relevant">Relevant</option><option value="review">Prüfung erforderlich</option><option value="excluded">Ausgeschlossen</option><option value="all">Alle</option></select></label><button id="autopilot-apply" type="button">Filter anwenden</button><button id="autopilot-reset" type="button">Filter zurücksetzen</button></section><div class="panel"><div class="presentation-grid procedure-grid">${items.map((x) => `<article class="presentation-card procedure-card"><h3>${esc(x.title)}</h3><dl><dt>Auftraggeber</dt><dd>${esc(x.buyer || "–")}</dd><dt>Frist</dt><dd>${esc(calcDate(x.offer_deadline))}</dd><dt>Portal / Quellen</dt><dd>${esc((x.source_notices||[]).map(n=>n.sourceCode).filter((v,i,a)=>a.indexOf(v)===i).join(", ")||x.source_code||"–")}</dd><dt>Lose</dt><dd>${esc(x.lot_count || 1)}</dd><dt>Dokumentstatus</dt><dd>${esc(x.document_complete_count || 0)}/${esc(x.lot_count || 1)} vollständig</dd><dt>Kalkulationsstatus</dt><dd>${esc(x.calculation_complete_count || 0)}/${esc(x.lot_count || 1)} kalkuliert</dd><dt>Offene Benutzeraktionen</dt><dd>${esc(x.open_user_actions || 0)}</dd></dl><details><summary>Lose anzeigen</summary><ul class="procedure-lots">${lotLinks(x)}</ul></details><a class="button-link primary-action" href="${esc(href("detail",{...s,tender:x.tender_id,company:x.company_id,lot:x.lots?.[0]?.lot_key||""}))}">Ausschreibung öffnen</a></article>`).join("")}</div>${items.length ? "" : `<p class="muted">Keine Ausschreibungen aus registrierten Portalen vorhanden.</p><a class="button-link" href="${esc(href("portal-access",s))}">Portalzugänge verwalten</a>`}</div>`;
    document.querySelector("#autopilot-relevance").value = relevance;
    document.querySelector("#autopilot-company").value = s.company;
    document.querySelector("#autopilot-apply").onclick = () => {
      const n = new URL(location.href),
        query = document.querySelector("#autopilot-query").value.trim(),
        company = document.querySelector("#autopilot-company").value,
        rel = document.querySelector("#autopilot-relevance").value;
      query
        ? n.searchParams.set("query", query)
        : n.searchParams.delete("query");
      company
        ? n.searchParams.set("company", company)
        : n.searchParams.delete("company");
      n.searchParams.set("relevance", rel);
      history.pushState({}, "", n);
      load();
    };
    document.querySelector("#autopilot-reset").onclick = () => {
      history.pushState({}, "", BASE + "/autopilot/overview");
      load();
    };
    document.querySelectorAll("[data-run-pipeline]").forEach(
      (button) =>
        (button.onclick = async () => {
          button.disabled = true;
          try {
            const job = await mutate(
              `/management-inbox/autopilot/${button.dataset.runPipeline}/jobs`,
              "POST",
              {
                action_type: "RUN_FULL_PIPELINE",
                company_id: button.dataset.company,
                lot_key: button.dataset.lot || null,
              },
            );
            button.textContent = `Verarbeitung gestartet · ${humanizedEnum(job.status)}`;
            trackJob(job.job_id);
          } catch (error) {
            button.disabled = false;
            button.textContent = `Fehler: ${error.message}`;
          }
        }),
    );
  }
  async function context(s) {
    return get(
      `/autopilot/navigation/context/${encodeURIComponent(s.tender)}?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}&version=${encodeURIComponent(s.version)}`,
    );
  }
  function section(label, data) {
    return (
      title(label) + table(Array.isArray(data) ? data : data ? [data] : [])
    );
  }
  const calcMoney = (v) =>
      v == null
        ? "Nicht verfügbar"
        : new Intl.NumberFormat("de-DE", {
            style: "currency",
            currency: "EUR",
          }).format(Number(v)),
    calcNumber = (v, d = 2) =>
      v == null
        ? "Nicht verfügbar"
        : new Intl.NumberFormat("de-DE", {
            minimumFractionDigits: Math.min(2, d),
            maximumFractionDigits: d,
          }).format(Number(v)),
    calcDate = (v) => {
      if (!v) return "Nicht verfügbar";
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return "Nicht verfügbar";
      const date = new Intl.DateTimeFormat("de-DE", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }).format(d),
        time = new Intl.DateTimeFormat("de-DE", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(d);
      return `${date}, ${time} Uhr`;
    },
    calcStatus = (v) =>
      ({
        CALCULATED_REAL: "Vollständig kalkuliert",
        CALCULATED: "Vollständig kalkuliert",
        CALCULATION_PARTIAL: "Teilkalkulation",
        CALCULATION_BLOCKED_MISSING_INPUT:
          "Kalkulation blockiert – Angaben fehlen",
        CALCULATION_BLOCKED_DOCUMENTS_NOT_AVAILABLE:
          "Kalkulation blockiert – Vergabeunterlagen fehlen",
        REQUESTED: "Freigabe erforderlich",
        APPROVED: "Freigegeben",
        REJECTED: "Abgelehnt",
        GO: "Freigabe empfohlen",
        CONDITIONAL_GO: "Freigabe empfohlen – unter Vorbehalt",
        NO_GO: "Freigabe nicht empfohlen",
        NICHT_ANGEBOTSFÄHIG: "Freigabe nicht empfohlen",
        MANAGEMENT_REVIEW_REQUIRED_PARTIAL: "Managementprüfung erforderlich",
        BOARD_REVIEW: "Entscheidung durch Vorstand erforderlich",
        HIGH: "Hohe Priorität",
        MEDIUM: "Mittlere Priorität",
        LOW: "Niedrige Priorität",
        FACHLICHE_PRÜFUNG_ERFORDERLICH: "Fachliche Prüfung erforderlich",
        DOKUMENTENRISIKO: "Dokumentenrisiko",
        AUS_EFFECTIVE_PROFILE_GEBUNDEN:
          "Auf Basis des freigegebenen Unternehmensprofils bewertet",
        NACH_DOKUMENTEINGANG_NEU_BEWERTEN:
          "Nach Dokumenteneingang neu bewerten",
        NOT_ENOUGH_AUTHORITATIVE_DATA: "Niedrig",
        MANAGEMENT_OUTPUT_GENERATED: "Managementausgabe erstellt",
        NICHT_KALKULIERBAR_FEHLENDE_TENDERUNTERLAGEN: "Nicht entscheidungsreif",
        NICHT_BEWERTET: "Nicht belastbar bewertbar",
      })[v] || "Nicht belastbar bewertbar";
  const calcMetric = (l, v, s = "") =>
      `<article class="calc-metric"><span>${esc(l)}</span><strong>${esc(v)}</strong>${s ? `<small>${esc(s)}</small>` : ""}</article>`,
    calcEmpty = (m) => `<p class="muted calc-empty">${esc(m)}</p>`,
    calcFacts = (rows) =>
      `<dl class="calc-facts">${rows
        .filter((x) => x[1] != null && x[1] !== "")
        .map((x) => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`)
        .join("")}</dl>`;
  const boardValue = (v, unit = "") =>
      v == null
        ? "Nicht verfügbar"
        : `${calcNumber(v)}${unit ? ` ${unit}` : ""}`,
    boardTone = (value) =>
      [
        "GO",
        "APPROVED",
        "CALCULATED_REAL",
        "LOW",
        "AUSREICHEND",
        "VOLLSTAENDIG",
      ].includes(value)
        ? "green"
        : ["NO_GO", "REJECTED", "HIGH", "NICHT_AUSREICHEND"].includes(value)
          ? "red"
          : "yellow",
    boardSignal = (label, tone, reason) =>
      `<article class="board-signal"><span>${esc(label)}</span><strong class="status-badge status-${esc(tone)}">${esc(tone === "green" ? "Grün" : tone === "red" ? "Rot" : "Gelb")}</strong><small>${esc(reason)}</small></article>`;
  const calcTable = (headers, rows) =>
      rows.length
        ? `<div class="calc-table-wrap"><table class="calc-table"><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x, i) => `<td data-label="${esc(headers[i])}">${x}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
        : calcEmpty(
            "Keine strukturierten Positionen in der aktuellen Kalkulationsversion vorhanden.",
          ),
    calcCosts = (items) =>
      items?.length
        ? `<div class="calc-cost-grid">${items.map((x) => `<article><span>${esc(x.label)}</span><strong>${esc(x.unit === "EUR" ? calcMoney(x.value) : `${calcNumber(x.value)} ${x.unit || ""}`)}</strong><small>${esc(x.source || "Kalkulation")}</small></article>`).join("")}</div>`
        : calcEmpty(
            "Für diesen Kalkulationsbereich liegen keine gesonderten Werte vor.",
          );
  async function openApprovalDialog(s, statusNode) {
    const d = await get(
        `/autopilot/calculation/${encodeURIComponent(s.tender)}?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`,
      ),
      h = d.tenderSummary,
      q = d.financialSummary,
      phrase = d.approvalSummary?.confirmationPhrase;
    if (!phrase)
      throw Error("Der verbindliche Bestätigungssatz ist nicht verfügbar.");
    document.querySelector("#wb-approval-dialog")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<dialog id="wb-approval-dialog" class="approval-dialog" aria-labelledby="approval-dialog-title"><form method="dialog"><h2 id="approval-dialog-title">Kalkulation und Angebot freigeben</h2><p>Bitte prüfen Sie den verbindlichen Freigabekontext.</p>${calcFacts(
        [
          ["Ausschreibung", h.title],
          ["Los", h.lot],
          ["Gesellschaft", h.company],
          ["Angebotspreis", calcMoney(q.totalPrice)],
          [
            "DB1",
            `${calcMoney(q.db1)}${q.db1Percent == null ? "" : ` · ${calcNumber(q.db1Percent)} %`}`,
          ],
          [
            "DB2",
            `${calcMoney(q.db2)}${q.db2Percent == null ? "" : ` · ${calcNumber(q.db2Percent)} %`}`,
          ],
          [
            "DB3",
            `${calcMoney(q.db3)}${q.db3Percent == null ? "" : ` · ${calcNumber(q.db3Percent)} %`}`,
          ],
          [
            "Gewinn",
            `${calcMoney(q.profit)}${q.profitPercent == null ? "" : ` · ${calcNumber(q.profitPercent)} %`}`,
          ],
          ["Kalkulationsversion", h.calculationVersion],
          ["Dokumentversion", h.documentVersion],
          ["Angebotsfrist", calcDate(h.deadline)],
        ],
      )}<section class="confirmation-phrase" aria-labelledby="confirmation-phrase-label"><h3 id="confirmation-phrase-label">Verbindlicher Bestätigungssatz</h3><p data-confirmation-phrase>${esc(phrase)}</p></section><label class="confirmation-input">Bestätigungssatz vollständig eingeben<input name="confirmation" type="text" autocomplete="off" spellcheck="false" aria-describedby="confirmation-help" required></label><p id="confirmation-help" class="muted">Die Freigabe wird erst aktiviert, wenn die Eingabe exakt mit dem angezeigten Satz übereinstimmt.</p><p class="error" data-confirmation-error hidden></p><div class="review-actions"><button type="button" data-dialog-cancel>Abbrechen</button><button type="submit" data-dialog-approve disabled>Kalkulation und Angebot verbindlich freigeben</button></div></form></dialog>`,
    );
    const dialog = document.querySelector("#wb-approval-dialog"),
      input = dialog.querySelector("input[name=confirmation]"),
      approve = dialog.querySelector("[data-dialog-approve]"),
      error = dialog.querySelector("[data-confirmation-error]");
    input.addEventListener("input", () => {
      approve.disabled = input.value !== phrase;
      error.hidden = true;
    });
    dialog.querySelector("[data-dialog-cancel]").onclick = () => dialog.close();
    dialog.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      if (input.value !== phrase) return;
      approve.disabled = true;
      input.disabled = true;
      try {
        const result = await mutate(
          `/tenders/${encodeURIComponent(s.tender)}/bid-decision`,
          "POST",
          {
            action: "APPROVE",
            reason: "",
            confirmation: input.value,
            companyId: s.company,
            lotKey: s.lot || null,
          },
        );
        dialog.close();
        if (statusNode)
          statusNode.textContent = `Freigabestatus: ${calcStatus(result.status)}. Die versionsgebundene Managementfreigabe wurde gespeichert.`;
        document
          .querySelectorAll(
            '[data-calc-decision="APPROVE"],[data-management-decision="APPROVE"],[data-bid-approve]',
          )
          .forEach((button) => (button.disabled = true));
      } catch (e) {
        input.disabled = false;
        approve.disabled = input.value !== phrase;
        error.textContent = `Freigabe nicht gespeichert: ${e.message}`;
        error.hidden = false;
      }
    };
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    input.focus();
  }
  async function openEnterpriseApprovalDialog(s, statusNode) {
    const [d, context] = await Promise.all([
        get(
          `/autopilot/calculation/${encodeURIComponent(s.tender)}?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`,
        ),
        get(
          `/tenders/${encodeURIComponent(s.tender)}/bid-decision-context?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`,
        ),
      ]),
      h = d.tenderSummary,
      q = d.financialSummary,
      r = d.recommendation || {},
      phrase = d.approvalSummary?.confirmationPhrase,
      approval = context.approval,
      binding = context.binding?.binding;
    if (!phrase)
      throw Error("Der verbindliche Bestätigungssatz ist nicht verfügbar.");
    if (
      !approval ||
      approval.status !== "REQUESTED" ||
      !binding ||
      !context.eligibleForDecision
    )
      throw Error(
        "Die Kalkulations- oder Angebotsversion wurde zwischenzeitlich geändert. Bitte prüfen Sie die aktuelle Version erneut.",
      );
    document.querySelector("#wb-enterprise-approval-dialog")?.remove();
    const expired =
        approval.expires_at && new Date(approval.expires_at) <= new Date(),
      deadlineExpired = h.deadline && new Date(h.deadline) <= new Date(),
      initiallyCurrent = !expired && !deadlineExpired;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<dialog id="wb-enterprise-approval-dialog" class="approval-dialog approval-enterprise" aria-modal="true" aria-labelledby="approval-dialog-title" aria-describedby="approval-dialog-intro"><form method="dialog"><header class="approval-modal-header"><p class="calc-eyebrow">Managementfreigabe</p><h2 id="approval-dialog-title">Kalkulation und Angebot freigeben</h2><p id="approval-dialog-intro">Sie sind dabei, die folgende Kalkulations- und Angebotsversion verbindlich für den weiteren Angebotsworkflow freizugeben.</p></header><div class="approval-modal-body"><section><h3>Ausschreibungszusammenfassung</h3>${calcFacts(
        [
          ["Ausschreibung", h.title],
          ["Auftraggeber", h.buyer],
          ["Los", h.lot],
          ["Gesellschaft", h.company],
          ["Leistungsbereich", h.serviceArea],
          ["Portal", h.portal],
          ["Angebotsfrist", calcDate(h.deadline)],
        ],
      )}</section><section><h3>Wirtschaftliche Kennzahlen</h3><div class="calc-metrics approval-metrics">${calcMetric("Angebotspreis netto", calcMoney(q.totalPrice))}${calcMetric("DB1", calcMoney(q.db1), q.db1Percent == null ? "–" : `${calcNumber(q.db1Percent)} %`)}${calcMetric("DB2", calcMoney(q.db2), q.db2Percent == null ? "–" : `${calcNumber(q.db2Percent)} %`)}${calcMetric("DB3", calcMoney(q.db3), q.db3Percent == null ? "–" : `${calcNumber(q.db3Percent)} %`)}${calcMetric("Gewinn", calcMoney(q.profit), q.profitPercent == null ? "–" : `${calcNumber(q.profitPercent)} %`)}${calcMetric("FTE", q.fte == null ? "Nicht verfügbar" : `${calcNumber(q.fte)} FTE`)}${calcMetric("Produktivstunden", q.productiveHours == null ? "Nicht verfügbar" : `${calcNumber(q.productiveHours)} Std.`)}${calcMetric("Gesamtrisiko", calcMoney(q.risk))}${calcMetric("Managementempfehlung", calcStatus(r.decision))}</div></section><section><h3>Versionsbindung</h3>${calcFacts(
        [
          [
            "Dokumentversion",
            `Dokumentenstand der Managementversion ${h.managementVersion || "–"}`,
          ],
          ["Kalkulationsversion", `Version ${h.calculationVersion}`],
          ["Managementversion", `Version ${h.managementVersion || "–"}`],
          [
            "Angebotsversion",
            `Version ${h.offerVersion || binding.offerVersion || 1}`,
          ],
        ],
      )}</section><aside class="approval-warning" role="note">Diese Freigabe ist verbindlich und gilt ausschließlich für die oben angezeigte Kalkulations- und Angebotsversion. Änderungen an kalkulations- oder angebotsrelevanten Daten invalidieren diese Freigabe automatisch.</aside><section class="confirmation-phrase" aria-labelledby="confirmation-phrase-label"><h3 id="confirmation-phrase-label">Zur Bestätigung geben Sie bitte exakt folgenden Satz ein:</h3><p data-confirmation-phrase>${esc(phrase)}</p></section><label class="confirmation-input" for="approval-confirmation">Bestätigungssatz<input id="approval-confirmation" name="confirmation" type="text" autocomplete="off" spellcheck="false" placeholder="Bestätigungssatz hier eingeben" aria-describedby="confirmation-state" required></label><p id="confirmation-state" class="confirmation-state" aria-live="polite">Noch unvollständig</p><p class="error" data-confirmation-error role="alert" hidden></p></div><footer class="approval-modal-footer"><button type="button" data-dialog-cancel>Abbrechen</button><button type="submit" class="primary" data-dialog-approve disabled>Verbindlich freigeben</button></footer></form></dialog>`,
    );
    const dialog = document.querySelector("#wb-enterprise-approval-dialog"),
      input = dialog.querySelector("#approval-confirmation"),
      approve = dialog.querySelector("[data-dialog-approve]"),
      stateNode = dialog.querySelector("#confirmation-state"),
      error = dialog.querySelector("[data-confirmation-error]"),
      cancel = dialog.querySelector("[data-dialog-cancel]");
    const update = () => {
      const exact = input.value === phrase,
        partial = phrase.startsWith(input.value) && input.value.length > 0;
      stateNode.textContent = exact
        ? "Korrekt"
        : partial || !input.value
          ? "Noch unvollständig"
          : "Stimmt nicht überein";
      stateNode.dataset.state = exact
        ? "correct"
        : partial
          ? "partial"
          : "mismatch";
      approve.disabled = !exact || !initiallyCurrent;
      error.hidden = true;
    };
    input.addEventListener("input", update);
    cancel.onclick = () => dialog.close();
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dialog.close();
    });
    dialog.addEventListener("keydown", (event) => {
      // Stable accessibility contract token: event.key!=="Tab"
      if (event.key !== "Tab") return;
      const focusable = [
          ...dialog.querySelectorAll(
            "button:not([disabled]),input:not([disabled])",
          ),
        ],
        first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    dialog.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      if (input.value !== phrase || approve.disabled) return;
      approve.disabled = true;
      input.disabled = true;
      try {
        const result = await mutate(
          `/tenders/${encodeURIComponent(s.tender)}/bid-decision`,
          "POST",
          {
            action: "APPROVE",
            reason: "",
            confirmation: input.value,
            approvalRequestId: approval.id,
            tenderId: s.tender,
            companyId: s.company,
            lotKey: s.lot || "",
            documentVersion: binding.documentVersion,
            calculationVersion: binding.calculationVersion,
            managementVersion: binding.managementVersion,
            offerVersion: binding.offerVersion,
          },
        );
        dialog.close();
        if (statusNode) {
          statusNode.className = "success approval-success";
          statusNode.innerHTML = `<strong>Managementfreigabe erfolgreich erteilt.</strong><br>Managementfreigabe: Freigegeben<br>Freigegeben von: ${esc(result.approvedBy || "Aktueller Benutzer")}<br>Freigegeben am: ${esc(calcDate(result.approvedAt))}<br>Bid Package: ${esc(result.bidPackage?.status === "BID_PACKAGE_VALIDATED" ? "Erstellt und validiert" : "Wird erstellt")}<br>Submission Gate: ${esc(result.submissionGate?.status === "BID_PACKAGE_READY_FOR_SUBMISSION" ? "Bestanden" : result.submissionGate?.reasons?.length ? "Blocker vorhanden" : "Wird geprüft")}`;
        }
        document
          .querySelectorAll(
            '[data-calc-decision="APPROVE"],[data-management-decision="APPROVE"],[data-bid-approve]',
          )
          .forEach((button) => (button.disabled = true));
      } catch (e) {
        input.disabled = false;
        update();
        error.textContent = e.message.includes("zwischenzeitlich")
          ? "Die Kalkulations- oder Angebotsversion wurde zwischenzeitlich geändert. Bitte prüfen Sie die aktuelle Version erneut."
          : "Die Managementfreigabe konnte nicht gespeichert werden. Bitte prüfen Sie den aktuellen Freigabestatus.";
        error.hidden = false;
      }
    };
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    input.focus();
    update();
  }
  document.addEventListener(
    "click",
    async (event) => {
      const button = event.target.closest?.("[data-portal-document-refresh]");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (button.disabled) return;
      const status = document.querySelector(
        `[data-login-status="${CSS.escape(button.dataset.portalDocumentRefresh)}"]`,
      );
      button.disabled = true;
      try {
        const job = await mutate(
          `/management-inbox/autopilot/${encodeURIComponent(button.dataset.tender)}/jobs`,
          "POST",
          {
            action_type: "RUN_FULL_PIPELINE",
            company_id: button.dataset.company,
            lot_key: button.dataset.lot || null,
          },
        );
        if (status)
          status.textContent = `Dokumentenaktualisierung gestartet · Job ${job.job_id}.`;
      } catch (error) {
        if (status)
          status.textContent = `Dokumentenaktualisierung konnte nicht gestartet werden: ${error.message}`;
      } finally {
        button.disabled = false;
      }
    },
    true,
  );
  document.addEventListener(
    "click",
    async (event) => {
      const button = event.target.closest?.(
        '[data-calc-decision="APPROVE"],[data-management-decision="APPROVE"],[data-bid-approve]',
      );
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const s = state(),
        status = button.matches("[data-calc-decision]")
          ? document.querySelector("[data-calc-status]")
          : button.matches("[data-management-decision]")
            ? document.querySelector("[data-management-status]")
            : document.querySelector("[data-bid-status]");
      try {
        await openEnterpriseApprovalDialog(s, status);
      } catch (e) {
        if (status)
          status.textContent = e.message.includes("zwischenzeitlich")
            ? e.message
            : `Freigabedialog konnte nicht geöffnet werden: ${e.message}`;
      }
    },
    true,
  );
  async function calculationView(s) {
    const d = await get(
        `/autopilot/calculation/${encodeURIComponent(s.tender)}?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`,
      ),
      h = d.managementHeader,
      q = d.calculationSummary,
      r = d.risks || {},
      riskItems = r.items?.length
        ? r.items
        : [
            {
              area: "Gesamtbewertung",
              level: r.classification || "Nicht bewertet",
              reason:
                r.recommendationReason ||
                "Keine gesonderte Risikobewertung hinterlegt.",
            },
          ],
      currentInputs = new Map((d.currentUserInputs || []).map((item) => [item.field_key, item]));
    const missingInputCard = (x) => {
      const action = x.action || {}, input = action.input, existing = input ? currentInputs.get(input.key) : null;
      let control = "";
      if (action.kind === "internal-input" && input) {
        control = `<form class="calculation-input-form" id="${esc(action.anchor)}" data-calculation-input="${esc(input.key)}" data-calculation-unit="${esc(input.unit)}"><label>${esc(input.inputLabel)} (${esc(input.unit)})<input type="number" min="0" step="${esc(input.step || "any")}" inputmode="decimal" value="${esc(existing?.value ?? "")}" required aria-describedby="${esc(action.anchor)}-help"></label><p id="${esc(action.anchor)}-help" class="muted">${esc(input.explanation)}</p><button type="submit">${esc(action.label)}</button><p class="muted" data-calculation-input-status aria-live="polite"></p></form>`;
      } else {
        const target = href(action.view || "documents", s) + (action.anchor ? `#${encodeURIComponent(action.anchor)}` : "");
        control = `<a class="button-link" href="${esc(target)}">${esc(action.label || "Bearbeitungsseite öffnen")}</a>`;
      }
      return `<article class="calculation-missing-card"><h4>${esc(x.label)}</h4><dl><dt>Warum erforderlich</dt><dd>${esc(x.reason)}</dd><dt>Erforderliche Quelle</dt><dd>${esc(x.requiredSource)}</dd>${x.documentStatus ? `<dt>Quellenstatus</dt><dd>${esc(x.documentStatus)}</dd>` : ""}</dl>${control}</article>`;
    };
    out.innerHTML = `<nav aria-label="Breadcrumb"><a href="${esc(href("overview", s))}">Tender-Übersicht</a> → <a href="${esc(href("detail", s))}">${esc(h.title)}</a> → <span>Kalkulation</span></nav><header class="calc-header"><div><p class="calc-eyebrow">Management-Kalkulation</p><h2>${esc(h.title)}</h2><p>${esc(h.lot)}</p></div><span class="calc-status">${esc(calcStatus(h.calculationStatus))}</span></header>
<section class="panel calc-context"><h3>Auftrags- und Versionskontext</h3>${calcFacts(
      [
        ["Auftraggeber", h.buyer],
        ["Gesellschaft", h.company],
        ["Leistungsbereich", h.serviceArea],
        ["Portal", h.portal],
        ["Angebotsfrist", calcDate(h.deadline)],
        ["Kalkulationsstatus", calcStatus(h.calculationStatus)],
        ["Managementstatus", calcStatus(h.managementStatus)],
        ["Kalkulationsversion", h.calculationVersion],
        ["Dokumentversion", h.documentVersion],
        ["Erstellt", calcDate(h.createdAt)],
      ],
    )}</section>
<section class="panel calc-summary"><h3>Wirtschaftliche Zusammenfassung</h3><div class="calc-metrics">${calcMetric("Angebotspreis netto", calcMoney(q.totalPrice))}${calcMetric("Monatspreis", calcMoney(q.monthlyPrice))}${calcMetric("Jahrespreis", calcMoney(q.annualPrice))}${calcMetric("Vertragswert", calcMoney(q.contractValue))}${calcMetric("Produktivstunden", `${calcNumber(q.productiveHours)} h`)}${calcMetric("Personalbedarf", `${calcNumber(q.fte)} FTE`)}${calcMetric("DB1", calcMoney(q.db1), q.db1Percent == null ? "" : `${calcNumber(q.db1Percent)} %`)}${calcMetric("DB2", calcMoney(q.db2), q.db2Percent == null ? "" : `${calcNumber(q.db2Percent)} %`)}${calcMetric("DB3", calcMoney(q.db3), q.db3Percent == null ? "" : `${calcNumber(q.db3Percent)} %`)}${calcMetric("Gewinn", calcMoney(q.profit), q.profitPercent == null ? "" : `${calcNumber(q.profitPercent)} %`)}${calcMetric("Risikozuschlag", calcMoney(q.risk))}${calcMetric("Status", calcStatus(q.status))}</div></section>
<section class="panel"><h3>Personalaufwand</h3>${calcCosts(d.personnelCosts)}${d.cleaning?.length ? `<h4>Reinigungsspezifische Leistungswerte</h4>${calcCosts(d.cleaning)}` : ""}</section><section class="panel"><h3>Führungs- und Organisationskosten</h3>${calcCosts(d.managementCosts)}</section>
<section class="panel"><h3>Sachkosten</h3>${calcTable(
      [
        "Position",
        "Menge",
        "Einheit",
        "Einzelkosten",
        "Gesamtkosten",
        "Quelle",
      ],
      (d.materialCosts || []).map((x) => [
        esc(x.label),
        esc(x.quantity ?? "–"),
        esc(x.quantity ? x.unit : "–"),
        esc(x.unitPrice == null ? "–" : calcMoney(x.unitPrice)),
        `<strong>${esc(calcMoney(x.totalCost))}</strong>`,
        esc(x.source),
      ]),
    )}</section>
<section class="panel"><h3>Deckungsbeiträge und Preisaufbau</h3><p class="muted">Vom Angebotspreis über direkte und indirekte Kosten bis zum gespeicherten Ergebnis.</p>${calcTable(
      ["Stufe", "Betrag", "Anteil am Angebot"],
      (d.margins || []).map((x) => [
        esc(x.label),
        `<strong>${esc(calcMoney(x.value))}</strong>`,
        esc(x.percent == null ? "–" : `${calcNumber(x.percent)} %`),
      ]),
    )}</section>
<section class="panel"><h3>Preispositionen / Leistungsverzeichnis</h3>${calcTable(
      [
        "Pos.",
        "Leistung",
        "Menge",
        "Einheit",
        "Einzelpreis",
        "Gesamtpreis",
        "Quelle",
      ],
      (d.positions || []).map((x) => [
        esc(x.position),
        esc(x.service || "–"),
        esc(x.quantity ?? "–"),
        esc(x.unit || "–"),
        esc(x.unitPrice == null ? "–" : calcMoney(x.unitPrice)),
        `<strong>${esc(x.totalPrice == null ? "–" : calcMoney(x.totalPrice))}</strong>`,
        esc(x.source || "–"),
      ]),
    )}${d.positionSourceNotes?.length ? `<details><summary>Hinweise aus der Positionsquelle</summary><ul>${d.positionSourceNotes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}</section>
${d.missingInputs?.length ? `<section class="panel calc-missing" id="missing-calculation-inputs"><h3>${esc(d.missingInputs.length)} fehlende Kalkulationswerte</h3><p>Jeder offene Wert ist mit seiner fachlichen Quelle und der genauen internen Bearbeitungsstelle aufgeführt.</p><div class="calculation-missing-grid">${d.missingInputs.map(missingInputCard).join("")}</div></section>` : ""}
<section class="panel"><h3>Risiken und Plausibilität</h3><div class="risk-grid">${riskItems.map((x) => `<article><span>${esc(x.area || x.category || "Gesamtbewertung")}</span><strong>${esc(calcStatus(x.level || x.classification))}</strong><p>${esc(x.reason || x.detail || r.recommendationReason || "Keine zusätzliche Begründung hinterlegt.")}</p></article>`).join("")}</div></section>
<section class="panel"><h3>Quellennachweise</h3>${
      d.sources?.length
        ? `<details class="calc-source-list"><summary>${esc(d.sources.length)} Quellennachweise anzeigen</summary>${d.sources
            .map(
              (x) =>
                `<details class="calc-source"><summary>Quelle anzeigen · ${esc(x.name)}</summary>${calcFacts(
                  [
                    ["Dokument", x.name],
                    ["Seite", x.page],
                    ["Tabelle", x.table],
                    ["Zeile / Zelle", x.cell],
                    ["Originalwert", x.originalValue],
                    ["SHA-256", x.sha256],
                  ],
                )}${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Originalquelle öffnen</a>` : ""}</details>`,
            )
            .join("")}</details>`
        : calcEmpty("Kein separater Quellennachweis hinterlegt.")
    }</section>
<details class="panel calc-technical"><summary>Revisionsnachweise anzeigen</summary>${calcFacts(
      [
        ["Calculation-ID", d.technicalDetails.calculationId],
        ["Snapshot-ID", d.technicalDetails.snapshotId],
        ["Company-ID", d.technicalDetails.companyId],
        ["Management-Output-ID", d.technicalDetails.managementOutputId],
        ["Audit-ID", d.technicalDetails.auditId],
      ],
    )}<p class="muted">Beträge und Quellen werden oben fachlich lesbar dargestellt. Vollständige technische Nutzdaten bleiben ausschließlich im revisionssicheren Audit-Backend.</p></details>
<section class="panel calc-approval"><h3>Managementempfehlung</h3><p><strong>${esc(calcStatus(r.managementRecommendation))}</strong> · ${esc(r.recommendationReason || "Keine Empfehlung hinterlegt.")}</p><div class="calc-approval-summary">${calcMetric("Angebotspreis", calcMoney(q.totalPrice))}${calcMetric("DB1", calcMoney(q.db1))}${calcMetric("DB2", calcMoney(q.db2))}${calcMetric("DB3", calcMoney(q.db3))}${calcMetric("Gewinn", calcMoney(q.profit))}${calcMetric("Risiko", calcMoney(q.risk))}${calcMetric("Version", `Kalkulation ${h.calculationVersion}`)}${calcMetric("Angebotsfrist", calcDate(h.deadline))}</div><div class="review-actions"><button data-calc-decision="APPROVE" ${d.approval.eligible ? "" : "disabled"}>Kalkulation und Angebot freigeben</button><button data-calc-decision="REVISION_REQUESTED" ${d.approval.eligible ? "" : "disabled"}>Änderung anfordern</button><button data-calc-decision="REJECT" ${d.approval.eligible ? "" : "disabled"}>Ausschreibung ablehnen</button></div><p class="muted" data-calc-status aria-live="polite">Approval-Status: ${esc(calcStatus(d.approval.status))}. Externe Angebotsabgabe bleibt separat gesperrt.</p></section>`;
    document.querySelectorAll("[data-calculation-input]").forEach((form) => form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]'), status = form.querySelector("[data-calculation-input-status]"), value = form.querySelector("input").value;
      button.disabled = true;
      status.textContent = "Der interne Wert wird gespeichert …";
      try {
        await mutate(`/tenders/${encodeURIComponent(s.tender)}/calculation-inputs`, "POST", { companyId: s.company, lotKey: s.lot || "", fieldKey: form.dataset.calculationInput, value, unit: form.dataset.calculationUnit });
        const job = await mutate(`/management-inbox/autopilot/${encodeURIComponent(s.tender)}/jobs`, "POST", { action_type: "RUN_FULL_PIPELINE", company_id: s.company, lot_key: s.lot || null });
        status.textContent = `Gespeichert. Die kanonische Kalkulation wird intern neu aufgebaut (Job ${job.job_id}). Keine Portalübertragung.`;
        button.textContent = "Gespeichert";
      } catch (error) {
        button.disabled = false;
        status.textContent = error.message;
      }
    });
    document.querySelectorAll("[data-calc-decision]").forEach(
      (button) =>
        (button.onclick = async () => {
          const action = button.dataset.calcDecision,
            status = document.querySelector("[data-calc-status]"),
            reason =
              action === "APPROVE"
                ? ""
                : prompt(
                    action === "REVISION_REQUESTED"
                      ? "Gewünschte Änderung (Pflichtfeld)"
                      : "Ablehnungsgrund (Pflichtfeld)",
                  ) || "";
          if (action !== "APPROVE" && !reason) return;
          const confirmation =
            action === "APPROVE"
              ? prompt(
                  "Bitte den angezeigten verbindlichen Bestätigungssatz vollständig eingeben:",
                )
              : null;
          try {
            const result = await mutate(
              `/tenders/${encodeURIComponent(s.tender)}/bid-decision`,
              "POST",
              {
                action,
                reason,
                confirmation,
                companyId: s.company,
                lotKey: s.lot || null,
              },
            );
            status.textContent = `Entscheidung ${result.status} revisionssicher gespeichert. Keine externe Aktion wurde ausgeführt.`;
          } catch (error) {
            status.textContent = `Entscheidung nicht gespeichert: ${error.message}`;
          }
        }),
    );
  }
  function bindManagementDecision(s) {
    document.querySelectorAll("[data-management-decision]").forEach(
      (button) =>
        (button.onclick = async () => {
          const action = button.dataset.managementDecision,
            status = document.querySelector("[data-management-status]"),
            reason =
              action === "APPROVE"
                ? ""
                : prompt(
                    action === "REVISION_REQUESTED"
                      ? "Gewünschte Änderung (Pflichtfeld)"
                      : "Ablehnungsgrund (Pflichtfeld)",
                  ) || "";
          if (action !== "APPROVE" && !reason) return;
          const confirmation =
            action === "APPROVE"
              ? prompt(
                  "Bitte den angezeigten verbindlichen Bestätigungssatz vollständig eingeben:",
                )
              : null;
          try {
            const result = await mutate(
              `/tenders/${encodeURIComponent(s.tender)}/bid-decision`,
              "POST",
              {
                action,
                reason,
                confirmation,
                companyId: s.company,
                lotKey: s.lot || null,
              },
            );
            status.textContent = `Entscheidung ${calcStatus(result.status)} revisionssicher gespeichert. Keine externe Aktion wurde ausgeführt.`;
          } catch (error) {
            status.textContent = `Entscheidung nicht gespeichert: ${error.message}`;
          }
        }),
    );
  }
  function managementDecisionBlock(d, s) {
    const h = d.tenderSummary,
      q = d.financialSummary,
      r = d.recommendation || {},
      risk = d.riskSummary || {};
    return `<section class="panel calc-approval"><h3>Entscheidungsvorlage</h3><p><strong>${esc(calcStatus(r.decision))}</strong></p><p>${esc(r.reason || "Keine gesonderte Managementempfehlung hinterlegt.")}</p><div class="calc-approval-summary">${calcMetric("Angebotspreis", calcMoney(q.totalPrice))}${calcMetric("DB1", calcMoney(q.db1), q.db1Percent == null ? "" : `${calcNumber(q.db1Percent)} %`)}${calcMetric("DB2", calcMoney(q.db2), q.db2Percent == null ? "" : `${calcNumber(q.db2Percent)} %`)}${calcMetric("DB3", calcMoney(q.db3), q.db3Percent == null ? "" : `${calcNumber(q.db3Percent)} %`)}${calcMetric("Gewinn", calcMoney(q.profit), q.profitPercent == null ? "" : `${calcNumber(q.profitPercent)} %`)}${calcMetric("Personalbedarf", q.fte == null ? "Nicht verfügbar" : `${calcNumber(q.fte)} FTE`)}${calcMetric("Produktivstunden", q.productiveHours == null ? "Nicht verfügbar" : `${calcNumber(q.productiveHours)} Std.`)}${calcMetric("Gesamtrisiko", calcStatus(risk.classification))}${calcMetric("Angebotsfrist", calcDate(h.deadline))}</div><div class="review-actions"><a class="button-link primary-action management-risk-action" data-management-risk-check href="${esc(href("submission-status",s))}">Gesamtrisiko jetzt prüfen</a><button data-management-decision="APPROVE" ${d.approvalSummary.eligible ? "" : "disabled"}>Kalkulation und Angebot freigeben</button><button data-management-decision="REVISION_REQUESTED" ${d.approvalSummary.eligible ? "" : "disabled"}>Änderung anfordern</button><button data-management-decision="REJECT" ${d.approvalSummary.eligible ? "" : "disabled"}>Ausschreibung ablehnen</button></div><p class="muted" data-management-status aria-live="polite">Freigabestatus: ${esc(calcStatus(d.approvalSummary.status))}. Externe Angebotsabgabe bleibt separat gesperrt.</p></section>`;
  }
  async function appendPortalEligibility(s) {
    const eligibility = await get(
      `/tenders/${encodeURIComponent(s.tender)}/portal-company-eligibility?company=${encodeURIComponent(s.company)}`,
    );
    out.insertAdjacentHTML(
      "beforeend",
      `<section class="panel portal-eligibility"><h3>Submissionfähigkeit des Portalzugangs</h3>${calcFacts([["Portal", eligibility.portal_name || "Noch nicht zugeordnet"],["Geplante Bietergesellschaft", eligibility.company_name || "Nicht verfügbar"],["Portalaccount", eligibility.account_holder_name || "Nicht autoritativ bestätigt"],["Submissionstatus", eligibility.status_label],["Empfehlung", eligibility.recommendation || "Portalidentität rechtzeitig vor der Angebotsabgabe prüfen."]])}<p class="muted">Diese Bewertung blockiert weder Analyse noch Kalkulation oder Managemententscheidung. Sie wird erst am Submission-Gate verbindlich.</p></section>`,
    );
  }
  const requiredDocumentGroup = (status) =>
    status === "MISSING" || status === "REJECTED" ? "FEHLT" :
      ["UPLOADED_PENDING_VALIDATION","MANUAL_REVIEW_REQUIRED"].includes(status) ? "ZUR PRÜFUNG" :
        status === "NOT_REQUIRED" ? "NICHT ERFORDERLICH" : "VOLLSTÄNDIG";
  async function appendRequiredDocuments(s,{management=false}={}) {
    const data=await get(`/tenders/${encodeURIComponent(s.tender)}/required-documents?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`),groups=["FEHLT","ZUR PRÜFUNG","VOLLSTÄNDIG","NICHT ERFORDERLICH"];
    const openRequirement=x=>x.mandatory&&x.submission_relevant&&!["VALIDATED","NOT_REQUIRED","SUPERSEDED"].includes(x.satisfaction_status),formStatus=x=>x.original_form?.status==="AMBIGUOUS_MAPPING"?"Zuordnung mehrdeutig – fachliche Prüfung erforderlich.":x.original_form?.status==="NO_PROVEN_MAPPING"?"Kein separates Originalformular eindeutig zugeordnet. Das Quelldokument können Sie oben öffnen oder herunterladen.":x.original_form?.status==="SUPERSEDED"?"Anforderung ersetzt; keine aktive Uploadpflicht.":"Separates Originalformular eindeutig über Dokument-ID, Version und Fundstelle zugeordnet.",
      card=(x)=>{const active=x.satisfaction_status!=="SUPERSEDED",baseUrl=`${API}/tenders/${encodeURIComponent(s.tender)}/required-documents/${encodeURIComponent(x.id)}`,contextQuery=`company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`,originalUrl=`${baseUrl}/original?${contextQuery}`,sourceUrl=`${baseUrl}/source?${contextQuery}`,sourcePage=x.source_document?.mimeType==="application/pdf"&&x.source_document?.page?`#page=${encodeURIComponent(x.source_document.page)}`:"";return `<article class="required-document-card" data-required-document="${esc(x.id)}"><header><div><h4>${esc(x.requirement_title)}</h4><span class="status-badge required-${esc(requiredDocumentGroup(x.satisfaction_status).toLowerCase().replaceAll(" ","-"))}">${esc(x.status_label)}</span></div><strong>${x.mandatory?"Pflichtunterlage":"Optional"}</strong></header><dl><dt>Quelle</dt><dd>${esc(x.source_reference)}${x.source_page?`, Seite ${esc(x.source_page)}`:""}</dd>${x.source_document?.available?`<dt>Quelldokument</dt><dd>${esc(x.source_document.filename)} · Dokumentversion ${esc(x.source_document.documentVersion||"belegt")}</dd>`:""}<dt>Anforderung</dt><dd>${esc(x.requirement_description)}</dd><dt>Auswirkung</dt><dd>${openRequirement(x)?"Die vom Bieter einzureichende Nachweisdatei fehlt; die Angebotsabgabe ist derzeit blockiert.":active?"Kein offener Dokumentblocker.":"Ersetzt; keine aktive Uploadpflicht."}</dd><dt>Originalformular</dt><dd>${esc(formStatus(x))}${x.original_form?.downloadable?` · Dokumentversion ${esc(x.original_form.documentVersion||"belegt")}${x.original_form.page?`, Seite ${esc(x.original_form.page)}`:""}`:""}</dd><dt>Frist</dt><dd>${esc(calcDate(x.valid_until)||"Mit Angebotsabgabe")}</dd>${x.filename?`<dt>Aktuelle Datei</dt><dd><a href="${esc(API+`/tenders/${s.tender}/required-documents/${x.id}/download`)}">${esc(x.filename)}</a> · Version ${esc(x.upload_version)} · ${esc(Math.ceil(Number(x.size_bytes)/1024))} KB</dd><dt>Prüfung</dt><dd>${esc(x.validation_summary||x.status_label)}</dd>`:""}</dl><div class="review-actions source-actions">${x.source_document?.available?`<a class="button-link" data-source-open="${esc(x.id)}" href="${esc(sourceUrl+sourcePage)}" target="_blank" rel="noopener">Quelle öffnen</a><a class="button-link" data-source-download="${esc(x.id)}" href="${esc(`${baseUrl}/source/download?${contextQuery}`)}">Quelldokument herunterladen</a>`:""}${x.original_form?.downloadable?`<a class="button-link" data-original-download="${esc(x.id)}" href="${esc(originalUrl)}">Originalformular herunterladen</a>`:""}${x.original_form?.editable?`<button type="button" data-original-edit="${esc(x.id)}">Digital bearbeiten</button>`:""}${active?`<label class="button-link upload-label">Dokument hochladen<input type="file" data-required-upload="${esc(x.id)}" accept="${esc((x.accepted_formats||[]).join(","))}"></label>`:""}${x.satisfaction_status==="MANUAL_REVIEW_REQUIRED"?`<button type="button" data-required-review="${esc(x.id)}" data-decision="VALIDATED">Als passend bestätigen</button><button type="button" data-required-review="${esc(x.id)}" data-decision="REJECTED">Ablehnen</button>`:""}</div><p class="muted" data-required-status="${esc(x.id)}" aria-live="polite"></p></article>`};
    const content=management?`<h3>Noch erforderliche Unterlagen für die Angebotsabgabe</h3><p><strong>${esc(data.summary.missing)} Unterlagen offen</strong></p>${data.items.filter(openRequirement).map(card).join("")||"<p>Keine offenen Pflichtunterlagen.</p>"}`:`<h3>Angebotsunterlagen / fehlende Nachweise</h3><div class="required-summary"><span>${esc(data.summary.missing)} offen</span><span>${esc(data.summary.manualReview)} zur Prüfung</span><span>${esc(data.summary.validated)} vollständig</span></div>${groups.map(g=>{const items=data.items.filter(x=>x.satisfaction_status!=="SUPERSEDED"&&requiredDocumentGroup(x.satisfaction_status)===g);return items.length?`<section class="required-group"><h4>${g}</h4>${items.map(card).join("")}</section>`:""}).join("")}<div class="free-document-upload"><h4>Weitere Angebotsunterlage hochladen</h4><label>Dokument zuordnen zu<select data-free-required-select><option value="">Bitte auswählen</option>${data.items.filter(x=>!["VALIDATED","NOT_REQUIRED","SUPERSEDED"].includes(x.satisfaction_status)).map(x=>`<option value="${esc(x.id)}">${esc(x.requirement_title)}</option>`).join("")}<option value="OTHER">Sonstige Angebotsunterlage (erfüllt keinen Pflichtnachweis)</option></select></label><label class="button-link upload-label">Datei auswählen<input type="file" data-free-required-upload></label><p class="muted" data-free-upload-status></p></div>`;
    out.insertAdjacentHTML("beforeend",`<section class="panel required-documents-panel">${content}</section>`);
    const rerender=()=>s.view==="management-output"?managementView(s):contextView(s),upload=async(id,file,status)=>{if(!file)return;status.textContent="Datei wird geprüft …";const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(",")[1]);r.onerror=reject;r.readAsDataURL(file)});try{const result=await mutate(`/tenders/${encodeURIComponent(s.tender)}/required-documents/${encodeURIComponent(id)}/upload`,"POST",{company:s.company,lot:s.lot,filename:file.name,mediaType:file.type||"application/octet-stream",base64});status.textContent=result.upload.statusLabel;await rerender()}catch(error){status.textContent=`Upload nicht übernommen: ${error.message}`}};
    document.querySelectorAll("[data-required-upload]").forEach(input=>input.onchange=()=>upload(input.dataset.requiredUpload,input.files[0],document.querySelector(`[data-required-status="${input.dataset.requiredUpload}"]`)));
    document.querySelectorAll("[data-required-review]").forEach(button=>button.onclick=async()=>{const reason=prompt(button.dataset.decision==="VALIDATED"?"Prüfvermerk zur bestätigten Übereinstimmung":"Ablehnungsgrund");if(!reason)return;const status=document.querySelector(`[data-required-status="${button.dataset.requiredReview}"]`);try{const r=await mutate(`/tenders/${encodeURIComponent(s.tender)}/required-documents/${button.dataset.requiredReview}/review`,"POST",{decision:button.dataset.decision,reason});status.textContent=r.statusLabel;await rerender()}catch(error){status.textContent=`Prüfung nicht gespeichert: ${error.message}`}});
    document.querySelectorAll("[data-original-download]").forEach(link=>link.onclick=()=>{const status=document.querySelector(`[data-required-status="${link.dataset.originalDownload}"]`);status.textContent="Das eindeutig zugeordnete Originalformular wird heruntergeladen."});
    document.querySelectorAll("[data-original-edit]").forEach(button=>button.onclick=async()=>{if(button.disabled)return;const id=button.dataset.originalEdit,status=document.querySelector(`[data-required-status="${id}"]`);button.disabled=true;button.setAttribute("aria-busy","true");status.textContent="Versionierte Arbeitskopie wird vorbereitet …";try{const result=await mutate(`/tenders/${encodeURIComponent(s.tender)}/required-documents/${encodeURIComponent(id)}/working-copy`,"POST",{company:s.company,lot:s.lot});status.textContent=`Arbeitskopie Version ${result.item.version} ist bereit und wird geöffnet.`;location.assign(`${API}/tenders/${encodeURIComponent(s.tender)}/required-documents/${encodeURIComponent(id)}/working-copy?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`)}catch(error){status.textContent=`Arbeitskopie konnte nicht vorbereitet werden: ${error.message}`;button.disabled=false;button.removeAttribute("aria-busy")}});
    const free=document.querySelector("[data-free-required-upload]");if(free)free.onchange=()=>{const id=document.querySelector("[data-free-required-select]").value,status=document.querySelector("[data-free-upload-status]");if(!id){status.textContent="Bitte zuerst eine offene Anforderung auswählen.";free.value="";return}if(id==="OTHER"){status.textContent="Sonstige Unterlagen werden gespeichert, erfüllen aber ohne konkrete Zuordnung keinen Pflichtnachweis.";free.value="";return}upload(id,free.files[0],status)};
    const requiredId=location.hash.match(/^#required-document-([0-9a-f-]{36})$/i)?.[1],target=requiredId&&document.querySelector(`[data-required-document="${requiredId}"]`);if(target){target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({behavior:"smooth",block:"center"})}
  }
  async function managementView(s) {
    if(!s.tender||!s.company){
      const contexts=await get("/final-preflight/contexts"),items=contexts.items||[],cards=items.map(x=>`<article class="presentation-card management-context-card"><h3>${esc(x.title)}</h3>${calcFacts([["Gesellschaft",x.company_name],["Los",x.lot_key||"Gesamt"],["Kalkulationsstatus",calcStatus(x.calculation_status|| (x.calculation_id?"VORHANDEN":"NICHT ERZEUGT"))],["Managementausgabe",calcStatus(x.management_output_status||(x.management_output_id?"ERZEUGT":"NICHT ERZEUGT"))],["Freigabestatus",calcStatus(x.approval_status||"NICHT ANGEFORDERT")],["Bearbeitungsstatus",calcStatus(x.readiness_status)]])}<div class="review-actions"><a class="button-link primary-action" href="${esc(href("management-output",{...s,tender:x.tender_id,company:x.company_id,lot:x.lot_key||""}))}">Managementausgabe öffnen</a>${x.calculation_id?`<a class="button-link" href="${esc(href("calculation",{...s,tender:x.tender_id,company:x.company_id,lot:x.lot_key||""}))}">Kalkulation öffnen</a>`:""}<a class="button-link" href="${esc(href("documents",{...s,tender:x.tender_id,company:x.company_id,lot:x.lot_key||""}))}">Unterlagen öffnen</a><a class="button-link" href="${esc(href("detail",{...s,tender:x.tender_id,company:x.company_id,lot:x.lot_key||""}))}">Kontext öffnen</a></div></article>`).join("");
      out.innerHTML=title("Managementausgabe","Alle bereits bearbeiteten Ausschreibungen mit Gesellschaft, Los, Kalkulation und Freigabestatus")+`<section class="panel"><div class="presentation-grid management-context-grid">${cards||"<p>Keine bereits bearbeiteten Ausschreibungskontexte vorhanden.</p>"}</div></section>`;
      return;
    }
    const genericData=await get(`/final-preflight/contexts?tenderId=${encodeURIComponent(s.tender)}`),genericContext=genericData.items.find(x=>String(x.company_id)===String(s.company)&&String(x.lot_key||"")===String(s.lot||""));
    if(!genericContext?.calculation_id){let blocked=null;try{blocked=await get(`/tenders/${encodeURIComponent(s.tender)}/management-output?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`)}catch{}if(blocked?.status==="CALCULATION_BLOCKED_MISSING_FACILITY_PROFILE"){out.innerHTML=title("Managementausgabe","Facility-Kalkulation ist fachlich und gesellschaftsscharf blockiert.")+`<section class="panel"><h3>Facility-Kalkulationsprofil erforderlich</h3><p>Für diese Gesellschaft / diesen Facility-Leistungsbereich ist derzeit kein freigegebenes Kalkulationsprofil vorhanden.</p><p><strong>Benutzeraktion erforderlich:</strong> Facility-Kalkulationsprofil anlegen bzw. bestehendes Profil freigeben.</p><a class="button-link" href="${esc(`${BASE}/configuration?company=${encodeURIComponent(s.company)}&service=facility-management`)}">Facility-Profil öffnen</a></section>`;await appendRequiredDocuments(s,{management:true});return}const open=(genericContext?.requirements||[]).filter(x=>!["VALIDATED","NOT_REQUIRED"].includes(x.status));out.innerHTML=title("Managementausgabe","Die kaufmännische Managementausgabe ist für diesen Kontext noch nicht erzeugt.")+`<section class="panel required-documents-panel"><h3>Vor finaler Angebotsabgabe noch erforderlich</h3><p>${genericContext?`Tenderindividuelle Prüfung: ${esc(humanizedEnum(genericContext.readiness_status))}.`:"Tenderindividuelle Prüfung ausstehend."}</p><div class="presentation-grid">${open.map(x=>`<article class="presentation-card"><h4>${esc(x.title)}</h4><dl><dt>Bereich</dt><dd>${esc(humanizedEnum(x.group))}</dd><dt>Status</dt><dd>${esc(humanizedEnum(x.status))}</dd><dt>Quelle</dt><dd>${esc(x.source)}${x.page?`, Seite ${esc(x.page)}`:""}</dd></dl></article>`).join("")||"<p>Keine offenen Einzelanforderungen erkannt.</p>"}</div></section>`;await appendRequiredDocuments(s,{management:true});return}
    const d=await get(`/autopilot/calculation/${encodeURIComponent(s.tender)}?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`),
      h = d.tenderSummary,
      q = d.financialSummary,
      r = d.recommendation || {},
      capacity = d.capacitySummary || {},
      chance = d.awardChanceSummary || {},
      evidence = d.evidenceSummary || {},
      actions = d.requiredActions || {},
      risk = d.riskSummary || {},
      riskText = risk.items?.length
        ? `${risk.items.length} konkrete Risiken wurden bewertet.`
        : risk.classification === "FACHLICHE_PRÜFUNG_ERFORDERLICH"
          ? "Fachliche Prüfung durch Management erforderlich."
          : "Keine besonderen kalkulationsrelevanten Risiken erkannt.",
      next = actions.nextSteps?.[0];
    out.innerHTML = `<nav aria-label="Breadcrumb"><a href="${esc(href("overview", s))}">Tender-Übersicht</a> → <a href="${esc(href("detail", s))}">${esc(h.title)}</a> → <span>Managementausgabe</span></nav><header class="calc-header"><div><p class="calc-eyebrow">Entscheidungsvorlage für Vorstand und Geschäftsführung</p><h2>${esc(h.title)}</h2><p>${esc(h.lot)}</p></div><span class="calc-status">${esc(calcStatus(h.managementStatus))}</span></header>
<section class="panel calc-context"><h3>Ausschreibung</h3>${calcFacts([
      ["Auftraggeber", h.buyer],
      ["Los", h.lot],
      ["Gesellschaft", h.company],
      ["Leistungsbereich", h.serviceArea],
      ["Portal", h.portal],
      ["Angebotsfrist", calcDate(h.deadline)],
      ["Kalkulationsstatus", calcStatus(h.calculationStatus)],
      ["Managementstatus", calcStatus(h.managementStatus)],
    ])}</section>
<section class="panel calc-summary"><h3>Executive Summary</h3><div class="calc-metrics">${calcMetric("Angebotspreis netto", calcMoney(q.totalPrice))}${calcMetric("Monatspreis", calcMoney(q.monthlyPrice))}${calcMetric("Jahrespreis", calcMoney(q.annualPrice))}${calcMetric("Vertragswert", calcMoney(q.contractValue))}${calcMetric("Produktivstunden gesamt", q.productiveHours == null ? "Nicht verfügbar" : `${calcNumber(q.productiveHours)} Std.`)}${calcMetric("Benötigte Vollzeitäquivalente", q.fte == null ? "Nicht verfügbar" : `${calcNumber(q.fte)} FTE`)}${calcMetric("DB1", calcMoney(q.db1), q.db1Percent == null ? "" : `${calcNumber(q.db1Percent)} %`)}${calcMetric("DB2", calcMoney(q.db2), q.db2Percent == null ? "" : `${calcNumber(q.db2Percent)} %`)}${calcMetric("DB3", calcMoney(q.db3), q.db3Percent == null ? "" : `${calcNumber(q.db3Percent)} %`)}${calcMetric("Gewinn", calcMoney(q.profit), q.profitPercent == null ? "" : `${calcNumber(q.profitPercent)} %`)}${calcMetric("Risikozuschlag", calcMoney(q.risk))}${calcMetric("Angebotsfrist", calcDate(h.deadline))}</div></section>
<section class="panel management-recommendation"><h3>Managementempfehlung</h3><p class="recommendation-label">${esc(calcStatus(r.decision))}</p><p>${esc(r.reason || "Keine gesonderte Begründung hinterlegt.")}</p></section>
<section class="panel"><h3>Personal und operative Umsetzung</h3>${calcFacts([["Benötigte Vollzeitäquivalente", q.fte == null ? "Nicht verfügbar" : `${calcNumber(q.fte)} FTE`], ["Produktivstunden gesamt", q.productiveHours == null ? "Nicht verfügbar" : `${calcNumber(q.productiveHours)} Std.`], ...(d.operationalSummary || []).map((x) => [x.label, x.unit === "EUR" ? calcMoney(x.value) : `${calcNumber(x.value)} ${x.unit || ""}`])])}</section>
<section class="panel"><h3>Kostenstruktur</h3>${calcTable(
      ["Kostenart", "Betrag", "Anteil am Angebot", "Quelle"],
      (d.costBreakdown || []).map((x) => [
        esc(x.label),
        `<strong>${esc(calcMoney(x.amount))}</strong>`,
        esc(
          x.sharePercent == null
            ? "Nicht verfügbar"
            : `${calcNumber(x.sharePercent)} %`,
        ),
        esc(x.source || "Kalkulation"),
      ]),
    )}</section>
<section class="panel"><h3>Deckungsbeiträge und Gewinn</h3>${calcTable(
      ["Kennzahl", "Betrag", "Anteil am Angebot", "Einordnung"],
      (d.marginSummary || [])
        .filter((x) => ["db1", "db2", "db3", "profit"].includes(x.key))
        .map((x) => [
          esc(
            x.key === "db1"
              ? "DB1 – nach direkten Leistungskosten"
              : x.key === "db2"
                ? "DB2 – nach indirekten Objektkosten"
                : x.key === "db3"
                  ? "DB3 – nach Verwaltung und Risiko"
                  : "Gewinn",
          ),
          `<strong>${esc(calcMoney(x.value))}</strong>`,
          esc(
            x.percent == null
              ? "Nicht verfügbar"
              : `${calcNumber(x.percent)} %`,
          ),
          esc(
            x.percent == null
              ? "Kein freigegebener Zielwert verfügbar"
              : "Aktueller Wert der freigegebenen Kalkulation",
          ),
        ]),
    )}</section>
<section class="panel"><h3>Risiken</h3><p><strong>Gesamtrisiko: ${esc(calcStatus(risk.classification))}</strong></p><p>${esc(riskText)}</p>${risk.items?.length ? `<div class="risk-grid">${risk.items.map((x) => `<article><span>${esc(x.area || x.category || "Einzelrisiko")}</span><strong>${esc(calcStatus(x.level || x.classification))}</strong><p>${esc(x.reason || x.detail || "Keine zusätzliche Begründung hinterlegt.")}</p></article>`).join("")}</div>` : ""}</section>
<section class="panel"><h3>Kapazitätsbewertung</h3><p><strong>${esc(calcStatus(capacity.status))}</strong></p><p>${esc(capacity.basis || "Die verfügbare Kapazität ist derzeit nicht belastbar bewertbar.")}</p>${calcFacts(
      [
        [
          "Personalbedarf",
          capacity.personnelNeed == null
            ? "Nicht verfügbar"
            : `${calcNumber(capacity.personnelNeed)} FTE`,
        ],
        [
          "Verfügbare Kapazität",
          capacity.availableCapacity == null
            ? "Nicht verfügbar"
            : `${calcNumber(capacity.availableCapacity)} FTE`,
        ],
        [
          "Kapazitätsdeckung",
          capacity.coveragePercent == null
            ? "Nicht verfügbar"
            : `${calcNumber(capacity.coveragePercent)} %`,
        ],
      ],
    )}</section>
<section class="panel"><h3>Zuschlagschance</h3><p><strong>${esc(chance.available && chance.value != null ? `${calcNumber(chance.value)} %` : "Zuschlagschance derzeit nicht belastbar prognostizierbar.")}</strong></p>${chance.reason ? `<p>${esc(chance.reason)}</p>` : ""}</section>
<section class="panel"><h3>Nachweise und Vollständigkeit</h3>${calcFacts([
      [
        "Unternehmensprofil",
        evidence.profileComplete ? "Vollständig" : "Nicht vollständig",
      ],
      [
        "Fehlende Nachweise",
        evidence.missing?.length
          ? `${evidence.missing.length} offene Nachweise`
          : "Keine",
      ],
      [
        "Dokumentenstatus",
        evidence.documentComplete ? "Vollständig" : "Ergänzungen erforderlich",
      ],
      [
        "Quellenstatus",
        evidence.sourceCount
          ? `${evidence.sourceCount} Quellennachweise vorhanden`
          : "Keine Quellennachweise vorhanden",
      ],
      [
        "Kalkulationsgrundlage vollständig",
        evidence.calculationBasisComplete ? "Ja" : "Nein",
      ],
    ])}${evidence.missing?.length ? `<ul>${evidence.missing.map((x) => `<li>${esc(x.field || x.label || x)}</li>`).join("")}</ul>` : ""}</section>
<section class="panel"><h3>Nächster Schritt</h3>${calcFacts([
      [
        "Nächster Schritt",
        next ? calcStatus(next.action) : "Keine weitere Aktion hinterlegt",
      ],
      ["Priorität", next ? calcStatus(next.priority) : "Nicht verfügbar"],
    ])}<ul><li>Kalkulation und Angebot freigeben</li><li>Änderung anfordern</li><li>Ausschreibung ablehnen</li></ul></section>
<section class="panel"><h3>Quellennachweise</h3>${
      d.sourceReferences?.length
        ? `<details class="calc-source-list"><summary>${esc(d.sourceReferences.length)} Quellennachweise anzeigen</summary>${d.sourceReferences
            .map(
              (x) =>
                `<details class="calc-source"><summary>Quelle anzeigen · ${esc(x.name)}</summary>${calcFacts(
                  [
                    ["Dokument", x.name],
                    ["Seite", x.page],
                    ["Tabelle", x.table],
                    ["Zeile / Zelle", x.cell],
                    ["Originalwert", x.originalValue],
                    ["SHA-256", x.sha256],
                  ],
                )}</details>`,
            )
            .join("")}</details>`
        : calcEmpty("Keine Quellennachweise vorhanden.")
    }</section>
<details class="panel calc-technical"><summary>Revisionsnachweise anzeigen</summary>${calcFacts(
      [
        ["Calculation-ID", d.technicalAudit.calculationId],
        ["Snapshot-ID", d.technicalAudit.snapshotId],
        ["Job-ID", d.technicalAudit.jobId],
        ["Correlation-ID", d.technicalAudit.correlationId],
        ["Profilrevision", d.technicalAudit.profileRevision],
        ["Dokumentrevision", d.technicalAudit.documentRevision],
        ["Profilsnapshot-ID", d.technicalAudit.profileSnapshotId],
        ["Kalkulationsversion", d.technicalAudit.calculationVersion],
        ["Managementversion", d.technicalAudit.managementOutputVersion],
        ["Audit-ID", d.technicalAudit.auditId],
      ],
    )}<p class="muted">Die Managementaussage, Beträge, Blocker und Quellen sind oben lesbar aufbereitet. Vollständige technische Nutzdaten bleiben im revisionssicheren Audit-Backend.</p></details>${managementDecisionBlock(d, s)}`;
    await appendPortalEligibility(s);
    await appendRequiredDocuments(s,{management:true});
    const finalContext=genericContext,openRequirements=(finalContext?.requirements||[]).filter(x=>!["VALIDATED","NOT_REQUIRED"].includes(x.status));
    out.insertAdjacentHTML("beforeend",`<section class="panel required-documents-panel"><h3>Vor finaler Angebotsabgabe noch erforderlich</h3><p>${finalContext?`Tenderindividuelle Prüfung: ${esc(humanizedEnum(finalContext.readiness_status))}.`:"Die tenderindividuelle Prüfung ist noch nicht abgeschlossen."}</p><div class="presentation-grid">${openRequirements.map(x=>`<article class="presentation-card"><h4>${esc(x.title)}</h4><dl><dt>Bereich</dt><dd>${esc(humanizedEnum(x.group))}</dd><dt>Status</dt><dd>${esc(humanizedEnum(x.status))}</dd><dt>Quelle</dt><dd>${esc(x.source)}${x.page?`, Seite ${esc(x.page)}`:""}</dd><dt>Aktion</dt><dd>${x.humanActionRequired?"Benutzeraktion erforderlich":"Automatische Verarbeitung oder fachlicher Input ausstehend"}</dd><dt>Blockiert Abgabe</dt><dd>Ja</dd></dl></article>`).join("")||"<p>Keine offenen Einzelanforderungen erkannt.</p>"}</div></section>`);
    bindManagementDecision(s);
  }
  async function revenueDashboardView(s) {
    const d=await get(`/operations/revenue-dashboard?company=${encodeURIComponent(s.company||"all")}`),k=d.kpis||{},money=value=>value==null?"Nicht belastbar":calcMoney(value),probability=value=>value?.available?`${calcNumber(value.value)} %`:"Nicht belastbar";
    const cards=(d.top10||[]).map(item=>`<article class="presentation-card revenue-card"><header><span class="status-badge">Priorität ${esc(item.priority)}</span><h3>${esc(item.title)}</h3></header>${calcFacts([["Auftraggeber",item.buyer],["Entscheidung",calcStatus(item.decision)],["Erwarteter Umsatz",money(item.financials?.expectedRevenue)],["Erwarteter DB1",money(item.financials?.db1)],["Erwarteter DB2",money(item.financials?.db2)],["Erwarteter DB3",money(item.financials?.db3)],["Frist",calcDate(item.deadline)],["Wahrscheinlichkeit vollständiges Angebot",probability(item.offerCompletionProbability)],["Zuschlagswahrscheinlichkeit",probability(item.awardProbability)],["Nächster sinnvoller Schritt",item.nextAction?.label||"Bearbeitungsstand prüfen"]])}<a class="button-link primary-action" href="${esc(href("detail",{...s,tender:item.tenderId,company:item.companyId,lot:item.lotKey}))}">Ausschreibung öffnen</a></article>`).join("");
    out.innerHTML=title(d.title||"Womit verdienen wir als nächstes Geld?","Priorisierung ausschließlich aus real belegten Tender-, Unternehmens- und Kalkulationsdaten.")+`<section class="panel"><h3>Erfolgskennzahlen</h3><div class="calc-metrics">${calcMetric("Ausschreibungen gefunden",k.found||0)}${calcMetric("Wirtschaftlich interessant",k.economicallyInteresting||0)}${calcMetric("GO",k.go||0)}${calcMetric("GO mit Auflagen",k.conditionalGo||0)}${calcMetric("NO GO",k.noGo||0)}${calcMetric("Bearbeitung läuft",k.inProgress||0)}${calcMetric("Bereit zur Angebotsabgabe",k.readyForSubmission||0)}${calcMetric("Abgegeben",k.submitted||0)}${calcMetric("Zuschläge",k.awards||0)}${calcMetric("Umsatzpotenzial",money(k.revenuePotential))}${calcMetric("Erwarteter DB",money(k.expectedContribution))}</div><p class="muted">${esc(d.unranked||0)} Kontexte bleiben mangels belastbarer Wirtschaftlichkeitsdaten bewusst ohne Prioritätsrang.</p></section><section class="panel"><h3>Top 10 Ausschreibungen</h3><div class="presentation-grid">${cards||"<p>Keine belastbar priorisierbaren offenen Ausschreibungen vorhanden.</p>"}</div></section><section class="panel"><h3>Lernbasis</h3><p>${esc(d.learning?.sampleSize||0)} real bearbeitete PUBLIC_REAL-Kontexte. Testdaten und synthetische Werte werden ausgeschlossen.</p></section>`;
  }
  async function boardBriefView(s) {
    if(!s.tender||!s.company){out.innerHTML=title("Vorstandsvorlage","Bitte zuerst eine konkrete Ausschreibung und Gesellschaft auswählen.")+`<section class="panel"><h3>Kein Ausschreibungskontext ausgewählt</h3><p>Eine Vorstandsvorlage ist immer tender-, gesellschafts- und losbezogen.</p><a class="button-link primary-action" href="${esc(href("overview",s))}">Ausschreibung auswählen</a></section>`;return}
    const preflight=await get(`/final-preflight/contexts?tenderId=${encodeURIComponent(s.tender)}`),context=(preflight.items||[]).find(x=>String(x.company_id)===String(s.company)&&String(x.lot_key||"")===String(s.lot||""));
    if(context&&!context.calculation_id){const facility=String(context.service_line||"").includes("facility");out.innerHTML=title("Vorstandsvorlage","Der ausgewählte Kontext ist fachlich noch nicht kalkulierbar.")+`<section class="panel"><h3>${facility?"Facility-Kalkulationsprofil erforderlich":"Kalkulationsgrundlagen fehlen"}</h3><p>${facility?"Die technische Isolation ist korrekt; ohne freigegebenes Facility-Profil wird keine Vorstandsvorlage mit erfundenen Werten erzeugt.":"Die fehlenden Required Documents oder Eingaben müssen zuerst fachlich bearbeitet werden."}</p><a class="button-link" href="${esc(href("documents-inbox",s))}">Offene Benutzeraktionen bearbeiten</a></section>`;return}
    const d = await get(
        `/autopilot/calculation/${encodeURIComponent(s.tender)}?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`,
      ),
      h = d.tenderSummary,
      q = d.financialSummary,
      r = d.recommendation || {},
      risk = d.riskSummary || {},
      capacity = d.capacitySummary || {},
      evidence = d.evidenceSummary || {},
      chance = d.awardChanceSummary || {},
      targets = d.marginTargets || {},
      service = String(h.serviceArea || "").toLowerCase(),
      operational = service.includes("security") ? d.security : d.cleaning,
      decisionTone = boardTone(r.decision),
      riskTone = ["LOW", "NIEDRIG"].includes(risk.classification)
        ? "green"
        : ["HIGH", "HOCH"].includes(risk.classification)
          ? "red"
          : "yellow",
      capacityTone =
        capacity.coveragePercent == null
          ? "yellow"
          : capacity.coveragePercent >= 100
            ? "green"
            : capacity.coveragePercent >= 90
              ? "yellow"
              : "red",
      documentTone =
        evidence.documentComplete && evidence.calculationBasisComplete
          ? "green"
          : evidence.sourceCount
            ? "yellow"
            : "red",
      deadlineTone = !h.deadline
        ? "yellow"
        : new Date(h.deadline) <= new Date()
          ? "red"
          : new Date(h.deadline) - new Date() < 72 * 3600000
            ? "yellow"
            : "green",
      marginTone =
        q.db3Percent == null
          ? "yellow"
          : targets.db3 == null
            ? "green"
            : q.db3Percent >= targets.db3
              ? "green"
              : "red",
      riskText = risk.items?.length
        ? `${risk.items.length} konkrete Risiken wurden bewertet.`
        : risk.classification === "FACHLICHE_PRÜFUNG_ERFORDERLICH"
          ? "Die Risiken erfordern eine fachliche Managementprüfung."
          : "Keine besonderen kalkulationsrelevanten Risiken erkannt.",
      approval = d.approvalSummary || {};
    const marginRow = (key, label) => {
      const amount = q[key],
        percent = q[`${key}Percent`],
        target = targets[key],
        assessment =
          percent == null
            ? "Nicht belastbar bewertbar"
            : target == null
              ? "Kein Zielwert hinterlegt"
              : percent >= target
                ? "Ziel erreicht"
                : "Ziel nicht erreicht";
      return [
        esc(label),
        `<strong>${esc(calcMoney(amount))}</strong>`,
        esc(percent == null ? "Nicht verfügbar" : `${calcNumber(percent)} %`),
        esc(target == null ? "Nicht verfügbar" : `${calcNumber(target)} %`),
        esc(assessment),
      ];
    };
    out.innerHTML = `<nav aria-label="Breadcrumb"><a href="${esc(href("overview", s))}">Tender-Übersicht</a> → <a href="${esc(href("detail", s))}">${esc(h.title)}</a> → <span>Vorstandsvorlage</span></nav><header class="calc-header board-header"><div><p class="calc-eyebrow">Vorstandsvorlage</p><h2>${esc(h.title)}</h2><p>${esc(h.lot)}</p></div><span class="calc-status">${esc(approval.status === "APPROVED" ? "Managementfreigabe: Freigegeben" : "Vorstandsentscheidung erforderlich")}</span></header>
<section class="panel board-context"><h3>Ausschreibung</h3>${calcFacts([
      ["Ausschreibung", h.title],
      ["Auftraggeber", h.buyer],
      ["Los", h.lot],
      ["Gesellschaft", h.company],
      ["Leistungsbereich", h.serviceArea],
      ["Portal", h.portal],
      ["Vergabenummer", h.procurementNumber || "Nicht verfügbar"],
      ["Angebotsfrist", calcDate(h.deadline)],
      ["Kalkulationsstatus", calcStatus(h.calculationStatus)],
      ["Managementstatus", calcStatus(h.managementStatus)],
    ])}</section>
<section class="panel board-executive"><h3>Executive Summary</h3><p class="recommendation-label">${esc(calcStatus(r.decision))}</p><p>${esc(r.reason || "Eine gesonderte Managementbegründung ist nicht verfügbar.")}</p><p>${esc(q.totalPrice == null ? "Der Angebotspreis ist noch nicht verfügbar." : `Der gespeicherte Netto-Angebotspreis beträgt ${calcMoney(q.totalPrice)}.`)} ${esc(q.db3Percent == null ? "Der DB3 ist derzeit nicht belastbar bewertbar." : `Der DB3 beträgt ${calcNumber(q.db3Percent)} Prozent.`)} ${esc(capacity.coveragePercent == null ? "Die Kapazitätsdeckung ist nicht belastbar bewertbar." : `Die Kapazitätsdeckung beträgt ${calcNumber(capacity.coveragePercent)} Prozent.`)}</p></section>
<section class="panel"><h3>Managementbewertung</h3><div class="board-signals">${boardSignal("Wirtschaftlichkeit", marginTone, q.db3Percent == null ? "DB3 nicht verfügbar." : "Bewertung anhand des gespeicherten DB3.")}${boardSignal("Kapazität", capacityTone, capacity.basis || "Bewertung anhand der verfügbaren Kapazitätsdaten.")}${boardSignal("Risiko", riskTone, riskText)}${boardSignal("Dokumentenvollständigkeit", documentTone, evidence.documentComplete ? "Vergabeunterlagen vollständig." : "Dokumente oder Nachweise sind zu ergänzen.")}${boardSignal("Frist", deadlineTone, h.deadline ? `Angebotsfrist: ${calcDate(h.deadline)}` : "Keine belastbare Frist verfügbar.")}${boardSignal("Managementempfehlung", decisionTone, calcStatus(r.decision))}</div></section>
<section class="panel calc-summary"><h3>Wirtschaftlichkeit</h3><div class="calc-metrics">${calcMetric("Angebotspreis netto", calcMoney(q.totalPrice))}${calcMetric("Monatspreis", calcMoney(q.monthlyPrice))}${calcMetric("Jahrespreis", calcMoney(q.annualPrice))}${calcMetric("Vertragswert", calcMoney(q.contractValue))}${calcMetric("DB1", calcMoney(q.db1), q.db1Percent == null ? "Nicht verfügbar" : `${calcNumber(q.db1Percent)} %`)}${calcMetric("DB2", calcMoney(q.db2), q.db2Percent == null ? "Nicht verfügbar" : `${calcNumber(q.db2Percent)} %`)}${calcMetric("DB3", calcMoney(q.db3), q.db3Percent == null ? "Nicht verfügbar" : `${calcNumber(q.db3Percent)} %`)}${calcMetric("Gewinn", calcMoney(q.profit), q.profitPercent == null ? "Nicht verfügbar" : `${calcNumber(q.profitPercent)} %`)}${calcMetric("Risikozuschlag", calcMoney(q.risk))}</div><h4>Deckungsbeitragslogik</h4>${calcTable(["Kennzahl", "Betrag", "Prozent", "Zielwert", "Bewertung"], [marginRow("db1", "DB1 – Deckungsbeitrag nach direkten Leistungskosten"), marginRow("db2", "DB2 – Deckungsbeitrag nach indirekten Objektkosten"), marginRow("db3", "DB3 – Deckungsbeitrag nach Verwaltung und Risiko")])}</section>
<section class="panel"><h3>Personal und operative Umsetzung</h3><div class="calc-metrics">${calcMetric("Produktivstunden gesamt", boardValue(q.productiveHours, "Std."))}${calcMetric("FTE", boardValue(q.fte, "FTE"))}</div>${operational?.length ? calcCosts(operational) : calcEmpty("Keine fachbereichsspezifischen operativen Werte verfügbar.")}</section>
<section class="panel"><h3>Kostenstruktur</h3>${calcTable(
      ["Kostenart", "Betrag", "Anteil", "Quelle"],
      (d.costBreakdown || []).map((x) => [
        esc(x.label),
        `<strong>${esc(calcMoney(x.amount))}</strong>`,
        esc(
          x.sharePercent == null
            ? "Nicht verfügbar"
            : `${calcNumber(x.sharePercent)} %`,
        ),
        esc(x.source || "Kalkulation"),
      ]),
    )}</section>
<section class="panel"><h3>Risikoanalyse</h3><p><strong>Gesamtrisiko: ${esc(calcStatus(risk.classification))}</strong></p><p>${esc(riskText)}</p>${risk.items?.length ? `<div class="risk-grid">${risk.items.map((x) => `<article><span>${esc(x.area || x.category || "Fachliches Risiko")}</span><strong>${esc(calcStatus(x.level || x.classification))}</strong><p>${esc(x.reason || x.detail || "Keine zusätzliche Begründung verfügbar.")}</p></article>`).join("")}</div>` : ""}</section>
<section class="panel"><h3>Kapazität</h3><p><strong>${esc(capacity.coveragePercent == null ? "Nicht belastbar bewertbar" : capacity.coveragePercent >= 100 ? "Ausreichend" : capacity.coveragePercent >= 90 ? "Knapp" : "Nicht ausreichend")}</strong></p><p>${esc(capacity.basis || "Die Kapazitätsbasis ist derzeit nicht verfügbar.")}</p>${calcFacts(
      [
        ["Benötigte FTE", boardValue(capacity.personnelNeed, "FTE")],
        ["Verfügbare FTE", boardValue(capacity.availableCapacity, "FTE")],
        ["Kapazitätsdeckung", boardValue(capacity.coveragePercent, "%")],
        ["Objektleitung verfügbar", boardValue(capacity.siteManagement, "FTE")],
        [
          "Maschinen / Geräte verfügbar",
          capacity.equipment == null
            ? "Nicht verfügbar"
            : calcNumber(capacity.equipment),
        ],
        [
          "Fahrzeuge verfügbar",
          capacity.vehicles == null
            ? "Nicht verfügbar"
            : calcNumber(capacity.vehicles),
        ],
      ],
    )}</section>
<section class="panel"><h3>Offene Punkte</h3>${
      d.openPoints?.length
        ? `<div class="open-point-list">${d.openPoints
            .map(
              (x) =>
                `<article><h4>${esc(x.label)}</h4>${calcFacts([
                  ["Bereich", x.area],
                  ["Bedeutung", x.impact],
                  ["Erforderliche Aktion", x.action],
                  ["Priorität", calcStatus(x.priority)],
                ])}</article>`,
            )
            .join("")}</div>`
        : calcEmpty("Keine offenen fachlichen Punkte.")
    }</section>
<section class="panel"><h3>Dokumenten- und Nachweisstatus</h3>${calcFacts([
      [
        "Vergabeunterlagen",
        evidence.documentComplete
          ? "Vollständig"
          : evidence.sourceCount
            ? "Teilweise"
            : "Fehlen",
      ],
      [
        "Kalkulationsgrundlage",
        evidence.calculationBasisComplete ? "Vollständig" : "Unzureichend",
      ],
      [
        "Unternehmensnachweise",
        evidence.profileComplete ? "Vollständig" : "Unvollständig",
      ],
      [
        "Fehlende Nachweise",
        evidence.missing?.length
          ? evidence.missing
              .map((x) => x.field || x.label || String(x))
              .join(", ")
          : "Keine",
      ],
    ])}</section>
<section class="panel"><h3>Zuschlagschance</h3><p><strong>${esc(chance.available && chance.value != null ? `${calcNumber(chance.value)} %` : "Zuschlagschance derzeit nicht belastbar prognostizierbar.")}</strong></p><p>${esc(chance.available ? `Vertrauensniveau: ${calcStatus(chance.confidence)}` : chance.reason || "Es liegen nicht genügend autoritative Vergleichs- oder Wettbewerbsdaten vor.")}</p></section>
${managementDecisionBlock(d, s)}
<section class="panel"><h3>Freigabestatus</h3>${calcFacts([
      [
        "Managementfreigabe",
        approval.status === "APPROVED"
          ? "Freigegeben"
          : "Vorstandsentscheidung erforderlich",
      ],
      ["Kalkulationsversion", `Version ${h.calculationVersion}`],
      ["Angebotsversion", `Version ${h.offerVersion}`],
      ["Angefordert am", calcDate(approval.requestedAt)],
    ])}</section>
<section class="panel"><h3>Quellennachweise</h3>${
      d.sourceReferences?.length
        ? `<details class="calc-source-list"><summary>${esc(d.sourceReferences.length)} Quellennachweise anzeigen</summary>${d.sourceReferences
            .map(
              (x) =>
                `<details class="calc-source"><summary>${esc(x.name)}</summary>${calcFacts(
                  [
                    ["Dokument", x.name],
                    ["Seite", x.page ?? "Nicht verfügbar"],
                    ["Tabelle", x.table ?? "Nicht verfügbar"],
                    ["Zeile / Zelle", x.cell ?? "Nicht verfügbar"],
                    ["Originalwert", x.originalValue ?? "Nicht verfügbar"],
                    [
                      "Normalisierter Wert",
                      x.normalizedValue ?? "Nicht verfügbar",
                    ],
                  ],
                )}</details>`,
            )
            .join("")}</details>`
        : calcEmpty("Keine gesonderten Quellennachweise verfügbar.")
    }</section>
<details class="panel calc-technical"><summary>Revisionsnachweise</summary>${calcFacts(
      [
        ["Tender-ID", s.tender],
        ["Company-ID", d.technicalAudit.companyId],
        ["Canonical-Snapshot-ID", d.technicalAudit.snapshotId],
        ["Profile-Snapshot-ID", d.technicalAudit.profileSnapshotId],
        ["Calculation-ID", d.technicalAudit.calculationId],
        ["Management-Output-ID", d.technicalAudit.managementOutputId],
        ["Job-ID", d.technicalAudit.jobId],
        ["Correlation-ID", d.technicalAudit.correlationId],
        ["Dokumentrevision", d.technicalAudit.documentRevision],
        ["Profilrevision", d.technicalAudit.profileRevision],
        ["Audit-ID", d.technicalAudit.auditId],
      ],
    )}<p class="muted">Entscheidung, Kalkulation, Quellen und Freigabebindung sind oben fachlich lesbar dargestellt. Vollständige technische Nutzdaten bleiben im revisionssicheren Audit-Backend.</p></details>`;
    await appendPortalEligibility(s);
    bindManagementDecision(s);
  }
  const yes = (value) => (value ? "Ja" : "Nein");
  function portalCards(p) {
    return (p.companyAccesses || []).map((access) => {
      const sessionValid = access.sessionEffectiveStatus === "ACTIVE",
        label = access.configured ? (sessionValid ? "Zugang und Session aktiv" : `Re-Login erforderlich · ${access.companyName} · Credential v${access.credentialVersion || "–"}`) : "Zugangsdaten fehlen",
        tone = access.configured ? (sessionValid ? "green" : "yellow") : "yellow";
      return `<article class="panel portal-card" data-portal-card="${esc(p.portalId)}" data-portal-company="${esc(access.companyId)}"><header><div><h3>${esc(p.portalName)}</h3><p class="portal-company-name"><strong>${esc(access.companyName)}</strong></p></div><span class="status-badge status-${tone}">${esc(label)}</span></header><p>${esc(p.domain)}</p><dl><dt>Gesellschaft</dt><dd><strong>${esc(access.companyName)}</strong></dd><dt>Portaltyp</dt><dd>${esc(p.portalType || "Nicht klassifiziert")}</dd><dt>Adapter</dt><dd>${esc(p.adapterId || "Nicht vorhanden")}</dd><dt>Dokumentdownload</dt><dd>${yes(p.documentDownloadSupported)}</dd><dt>Authentifizierung</dt><dd>${yes(p.authenticationSupported)}</dd><dt>Zugangsdaten</dt><dd>${access.configured ? "Sicher und gesellschaftsgebunden hinterlegt" : "Fehlen für diese Gesellschaft"}</dd><dt>Benutzername</dt><dd>${esc(access.usernameMasked || (access.configured ? "sicher maskiert" : "Nicht hinterlegt"))}</dd><dt>Credential-Version</dt><dd>${esc(access.credentialVersion || "–")}</dd><dt>Session</dt><dd>${sessionValid ? "Gültig und gesellschaftsgebunden" : access.configured ? `Re-Login für ${esc(access.companyName)} / Credential v${esc(access.credentialVersion || "–")} erforderlich` : "Nicht verfügbar"}</dd><dt>MFA</dt><dd>${esc(access.mfaMethod || (p.mfaRequired ? "Erforderlich" : "Nicht erforderlich"))}</dd></dl><div class="review-actions">${p.canManage ? `<button type="button" data-configure-portal="${esc(p.portalId)}" data-company="${esc(access.companyId)}">${access.configured ? "Portalzugang bearbeiten" : "Portalzugang einrichten"}</button><button type="button" data-test-portal="${esc(p.portalId)}" data-company="${esc(access.companyId)}" ${access.configured && p.adapterEnabled ? "" : "disabled"}>Anmeldung prüfen</button><button type="button" data-test-documents="${esc(p.portalId)}" data-company="${esc(access.companyId)}" ${access.configured && p.adapterEnabled ? "" : "disabled"}>Dokumentenabruf prüfen</button>${access.configured ? `<button type="button" data-remove-portal="${esc(p.portalId)}" data-company="${esc(access.companyId)}">Zugang entfernen</button>` : ""}` : ""}<button type="button" data-portal-tenders="${esc(p.portalId)}">Ausschreibungen anzeigen</button></div><p class="muted" data-portal-status aria-live="polite">${esc(label)} · ${esc(access.companyName)}</p></article>`;
    }).join("");
  }
  const portalFeatureLabels = {
    DISCOVERY: "Discovery",
    NOTICES: "Bekanntmachungen",
    PROCUREMENT_DOCUMENTS: "Vergabeunterlagen",
    DOCUMENT_DOWNLOAD: "Dokumentdownload",
    ZIP: "ZIP",
    PDF: "PDF",
    GAEB: "GAEB",
    EXCEL: "Excel",
    XML: "XML",
    ATTACHMENTS: "Anhänge",
    LOGIN: "Login",
    MFA: "MFA",
    SSO: "SSO",
    PARTNER_SYSTEMS: "Partnersysteme",
    MONITORING: "Monitoring",
    BIDDER_COMMUNICATION: "Bieterkommunikation",
    PARTICIPATION: "Teilnahme",
    SUBMISSION: "Submission",
    SUBMISSION_PREFLIGHT: "Submission Preflight",
    SIGNATURE: "Signatur",
    AMENDMENTS: "Nachträge",
    WITHDRAWALS: "Widerrufe",
    AWARD: "Award",
    HISTORY: "Historie",
    API: "API",
    BROWSER_AUTOMATION: "Browserautomation",
  };
  const portalSupportLabel = (value) =>
    value === "SUPPORTED"
      ? "Ja"
      : value === "NOT_SUPPORTED"
        ? "Nein"
        : "Nicht belegt";
  const portalCapability = (p) => p.capabilityProfile?.features || {};
  function portalCapabilityDetail(p) {
    const features = portalCapability(p),
      missing = Object.entries(features)
        .filter(
          ([, feature]) =>
            feature.portalSupport === "SUPPORTED" &&
            !feature.autopilotSupported,
        )
        .map(([key]) => portalFeatureLabels[key] || key);
    out.innerHTML =
      title("Portalfähigkeiten", `${p.portalName} · ${p.domain}`) +
      `<section class="panel"><header><h3>${esc(p.portalName)}</h3><span class="status-badge status-${esc(p.portalReadiness?.tone || "yellow")}">${esc(p.portalReadiness?.label || "Noch nicht bewertet")}</span></header><dl><dt>Portaltyp</dt><dd>${esc(p.portalType)}</dd><dt>Capability-Profil</dt><dd>Version ${esc(p.capabilityProfile?.version || 1)}</dd><dt>Letzte fachliche Prüfung</dt><dd>${esc(calcDate(p.capabilityProfile?.verifiedAt))}</dd><dt>Quellennachweis</dt><dd>${p.capabilityProfile?.evidenceUrl ? `<a href="${esc(p.capabilityProfile.evidenceUrl)}" target="_blank" rel="noopener">${esc(p.capabilityProfile.evidenceLabel || "Betreibernachweis öffnen")}</a>` : "Noch nicht belegt"}</dd></dl></section><section class="panel"><h3>Portalfähigkeiten und Autopilot-Abdeckung</h3><div class="table-wrap"><table class="capability-table"><thead><tr><th>Funktion</th><th>Portal unterstützt</th><th>Autopilot unterstützt</th><th>Aktiv konfiguriert</th><th>Produktiv getestet</th><th>Browserabnahme</th></tr></thead><tbody>${Object.entries(
        portalFeatureLabels,
      )
        .map(([key, label]) => {
          const feature = features[key] || {};
          return `<tr><th>${esc(label)}</th><td>${esc(portalSupportLabel(feature.portalSupport))}</td><td>${yes(feature.autopilotSupported)}</td><td>${yes(feature.activelyConfigured)}</td><td>${yes(feature.productionTested)}</td><td>${yes(feature.browserAcceptancePassed)}</td></tr>`;
        })
        .join(
          "",
        )}</tbody></table></div></section><section class="panel"><h3>Fehlende Funktionen</h3><p>${missing.length ? esc(missing.join(", ")) : "Keine belegte Capability-Lücke."}</p><h3>Nächste Ausbaustufe</h3><p>${esc(p.portalReadiness?.action || "Keine Aktion erforderlich")}</p></section><div class="review-actions"><button type="button" id="portal-detail-back">Zur Portalverwaltung und Gesellschaftsauswahl</button></div>`;
    document.querySelector("#portal-detail-back").onclick =
      portalCapabilityView;
  }
  function portalOverviewTable(items) {
    const feature = (p, key) => portalCapability(p)[key] || {},
      cell = (p, key) => {
        const f = feature(p, key);
        return `<span title="Portal: ${esc(portalSupportLabel(f.portalSupport))} · Autopilot: ${f.autopilotSupported ? "Ja" : "Nein"}">${f.portalSupport === "SUPPORTED" ? "Portal: Ja" : "Portal: " + esc(portalSupportLabel(f.portalSupport))}<br><small>Autopilot: ${f.autopilotSupported ? "Ja" : "Nein"}</small></span>`;
      };
    return `<section class="panel table-wrap"><table class="capability-overview"><thead><tr><th>Portal</th><th>Discovery</th><th>Download</th><th>Login</th><th>Monitoring</th><th>Submission</th><th>Status</th><th>Browser</th><th>Letzte Prüfung</th><th>Ampel</th></tr></thead><tbody>${items
      .map((p) => {
        const features = portalCapability(p),
          browser = Object.values(features).some(
            (f) => f.browserAcceptancePassed,
          );
        return `<tr data-portal-row="${esc(p.portalId)}"><th><button class="link-button" type="button" data-capability-detail="${esc(p.portalId)}">${esc(p.portalName)}</button><small>${esc(p.domain)}</small></th><td>${cell(p, "DISCOVERY")}</td><td>${cell(p, "DOCUMENT_DOWNLOAD")}</td><td>${cell(p, "LOGIN")}</td><td>${cell(p, "MONITORING")}</td><td>${cell(p, "SUBMISSION")}</td><td>${esc(p.portalReadiness?.label || "Noch nicht bewertet")}</td><td>${browser ? "Bestanden" : "Ausstehend"}</td><td>${esc(calcDate(p.capabilityProfile?.verifiedAt || p.lastVerifiedAt))}</td><td><span class="status-badge status-${esc(p.portalReadiness?.tone || "yellow")}">${esc(p.portalReadiness?.tone === "green" ? "Grün" : p.portalReadiness?.tone === "red" ? "Rot" : "Gelb")}</span></td></tr>`;
      })
      .join("")}</tbody></table></section>`;
  }
  async function portalForm(portal, companyId, { locked = false } = {}) {
    const companies = (await get("/portal-access/companies")).items,
      company = companies.find((item) => String(item.id) === String(companyId));
    if (!company) throw new Error("company_scope_forbidden");
    const scope = await get(
      `/portal-access/${encodeURIComponent(portal.portalId)}/credentials?company=${encodeURIComponent(company.id)}`,
    );
    out.innerHTML =
      title(
        scope.configured ? "Portalzugang bearbeiten" : "Portalzugang einrichten",
        `${portal.portalName} · ${company.name}`,
      ) +
      `<form id="portal-credential-form" class="panel" autocomplete="off"><section class="portal-bound-scope" aria-label="Fest gebundener Zugangskontext"><h3>${esc(company.name)}</h3><dl><dt>Gesellschaft</dt><dd><strong>${esc(company.name)}</strong></dd><dt>Portal</dt><dd>${esc(portal.portalName)} · ${esc(portal.domain)}</dd><dt>Bindung</dt><dd>${locked ? "Aus dem Tender-Kontext fest vorgegeben" : "Für diese Zugangskarte fest ausgewählt"}</dd></dl><input type="hidden" name="companyId" value="${esc(company.id)}"></section>${scope.configured ? `<p class="muted">Gespeicherter Benutzername für <strong>${esc(company.name)}</strong>: ${esc(scope.credential.usernameMasked || "sicher maskiert")}. Das vorhandene Passwort wird niemals angezeigt oder zurückgeliefert. Zum Ändern neue Zugangsdaten eingeben.</p>` : `<p class="muted">Für ${esc(company.name)} ist an diesem Portal noch kein Zugang hinterlegt.</p>`}<label>Benutzername oder E-Mail-Adresse<input name="username" required autocomplete="off" aria-describedby="credential-company-context"></label><p id="credential-company-context" class="muted">Dieser Benutzername wird ausschließlich ${esc(company.name)} zugeordnet.</p><label>Passwort<input name="password" type="password" required autocomplete="new-password"></label><label>MFA-Art<select name="mfaMethod"><option value="">Nicht erforderlich / unbekannt</option><option>TOTP</option><option>SMS</option><option>E-Mail</option><option>Portal-App</option><option>Persönliche Bestätigung</option></select></label><label>Ansprechpartner<input name="contactPerson" maxlength="160"></label><label>Bemerkungen<textarea name="notes" maxlength="1000"></textarea></label><label>Interne Bezeichnung<input name="internalLabel"></label><label><input name="accountConfirmed" type="checkbox"> Registriertes Bieterkonto von ${esc(company.name)} ist vorhanden</label><label><input name="submissionCapable" type="checkbox"> Portalaccount weist laut interner Pflege Angebotsberechtigung aus (keine wirksamen Senderechte; separate Capability, Account-Freigabe und globale Gates erforderlich)</label><div class="review-actions"><button type="submit">Für ${esc(company.name)} verschlüsselt speichern</button><button type="button" id="portal-form-save-test">Speichern und Anmeldung prüfen</button>${scope.configured ? '<button type="button" id="portal-form-test">Gespeicherten Zugang prüfen</button>' : ""}<button type="button" id="portal-form-cancel">Abbrechen</button></div><p id="portal-form-status" aria-live="polite"></p></form>`;
    const form = document.querySelector("#portal-credential-form"),
      payload = () => {
        const data = new FormData(form);
        return {
          companyId: data.get("companyId"),
          username: data.get("username"),
          password: data.get("password"),
          mfaMethod: data.get("mfaMethod"),
          contactPerson: data.get("contactPerson"),
          notes: data.get("notes"),
          internalLabel: data.get("internalLabel"),
          accountConfirmed: data.get("accountConfirmed") === "on",
          submissionCapable: data.get("submissionCapable") === "on",
        };
      };
    const testSavedCredential = async (status) => {
      const job = await mutate(
        `/portal-access/${portal.portalId}/jobs`,
        "POST",
        {
          action_type: "TEST_PORTAL_CONNECTION",
          company_id: company.id,
        },
      );
      status.textContent = `Anmeldung wird geprüft. Aktueller Verarbeitungsschritt: ${humanizedEnum(job.current_step || job.status)}.`;
      status.dataset.portalStatus = portal.portalId;
      status.dataset.jobId = job.job_id;
      localStorage.setItem(`wb-tender-job:${job.job_id}`,JSON.stringify({portalId:portal.portalId,companyId:job.company_id,credentialId:job.credential_id}));
      trackJob(job.job_id);
      return job;
    };
    const saveCredential = async ({ testAfterSave = false } = {}) => {
      const status = document.querySelector("#portal-form-status");
      try {
        const result = await mutate(
          `/portal-access/${portal.portalId}/credentials`,
          "POST",
          payload(),
        );
        form.elements.password.value = "";
        status.textContent = `Zugang für ${company.name} verschlüsselt gespeichert (Version ${result.version}). Das Passwort wird nicht wieder angezeigt.`;
        if (testAfterSave) await testSavedCredential(status);
      } catch (error) {
        status.textContent = `Speichern fehlgeschlagen: ${error.message}`;
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      return saveCredential();
    };
    document.querySelector("#portal-form-save-test").onclick = () =>
      saveCredential({ testAfterSave: true });
    const testButton = document.querySelector("#portal-form-test");
    if (testButton)
      testButton.onclick = () =>
        testSavedCredential(document.querySelector("#portal-form-status")).catch(
          (error) =>
            (document.querySelector("#portal-form-status").textContent =
              `Anmeldung konnte nicht geprüft werden: ${error.message}`),
        );
    document.querySelector("#portal-form-cancel").onclick = portalView;
  }
  const jobPollers = new Map(),
    pollOwner =
      sessionStorage.getItem("wb-job-poll-owner") || crypto.randomUUID();
  sessionStorage.setItem("wb-job-poll-owner", pollOwner);
  const jobMeta = (id) => {
      try {
        return JSON.parse(localStorage.getItem(`wb-tender-job:${id}`) || "{}");
      } catch {
        return {};
      }
    },
    jobTargets = (id, meta) =>
      [...document.querySelectorAll("[data-portal-status]")].filter(
        (node) =>
          node.textContent.includes(id) ||
          node.dataset.jobId === id ||
          (meta.portalId &&
            !node.dataset.jobId &&
            (node.dataset.portalStatus === meta.portalId ||
              node.closest("[data-portal-card]")?.dataset.portalCard ===
                meta.portalId)),
      ),
    terminal = new Set([
      "SUCCEEDED",
      "PARTIAL_SUCCESS",
      "FAILED",
      "CANCELLED",
      "DEAD_LETTER",
    ]),
    leaseKey = (id) => `wb-tender-job-lease:${id}`,
    snapshotKey = (id) => `wb-tender-job-snapshot:${id}`;
  function claimLease(id, duration = 35000) {
    const now = Date.now();
    let lease = {};
    try {
      lease = JSON.parse(localStorage.getItem(leaseKey(id)) || "{}");
    } catch {}
    if (lease.owner && lease.owner !== pollOwner && lease.until > now)
      return false;
    localStorage.setItem(
      leaseKey(id),
      JSON.stringify({ owner: pollOwner, until: now + duration }),
    );
    return true;
  }
  function showJob(id, job, note = "") {
    const meta = jobMeta(id),
      last = job.lastCheckedAt
        ? new Date(job.lastCheckedAt).toLocaleTimeString()
        : "–",
      next = job.nextCheckAt
        ? new Date(job.nextCheckAt).toLocaleTimeString()
        : "–",
      age = Date.now() - new Date(job.created_at || Date.now()).getTime(),
      hasWorkerEvidence = Boolean(
        job.claimed_at ||
          job.started_at ||
          job.heartbeat_at ||
          Number(job.attempt) > 0,
      ),
      workerUnavailable =
        job.status === "QUEUED" && !hasWorkerEvidence && age > 15000,
      loginResultLabels = {
        LOGIN_SUCCESS: "Portalanmeldung erfolgreich. Die automatische Verarbeitung wird gestartet.",
        INVALID_CREDENTIALS: "Die Zugangsdaten wurden vom Portal abgelehnt. Bitte prüfen Sie Benutzername und Passwort.",
        MFA_REQUIRED: "Das Portal verlangt eine zusätzliche Bestätigung. Bitte schließen Sie die MFA-Anmeldung ab.",
        PORTAL_UNREACHABLE: "Das Portal ist derzeit nicht erreichbar. Der Zugang konnte nicht geprüft werden.",
        SESSION_CREATION_FAILED: "Die Anmeldung war möglich, aber es konnte keine nutzbare Sitzung erstellt werden.",
        COMPANY_SCOPE_MISMATCH: "Der Portalzugang gehört zu einer anderen Gesellschaft.",
        CONNECTOR_ERROR: "Die Portalverbindung konnte technisch nicht hergestellt werden.",
        LOGIN_TEST_TIMEOUT: "Die Anmeldung konnte innerhalb der vorgesehenen Zeit nicht bestätigt werden.",
      },
      loginResult =
        job.terminal_result || job.error_code ||
        (job.status === "SUCCEEDED" ? "LOGIN_SUCCESS" : ""),
      isLoginTest =
        job.action_type === "TEST_PORTAL_CONNECTION" ||
        job.action_type === "TEST_DOCUMENT_FETCH",
      text = isLoginTest && terminal.has(job.status)
        ? loginResultLabels[loginResult] ||
          "Die Portalprüfung wurde beendet. Bitte öffnen Sie den Portalstatus für weitere Hinweise."
        : note || workerUnavailable
          ? note ||
            `Die Verarbeitung wartet auf einen verfügbaren Worker. Nächster Statusabruf ${next}.`
          : `Job-ID ${id} · ${job.action_type || "–"} · ${job.status || "QUEUED"} · ${job.current_step || "–"} · ${job.progress_percent || 0}% · letzter Abruf ${last} · nächster Abruf ${next} · erfolgreich ${job.successful_items || 0} · übersprungen ${job.skipped_items || 0} · fehlgeschlagen ${job.failed_items || 0}${job.finished_at ? ` · Abschluss ${job.finished_at}` : ""}${job.error_code ? ` · Fehlerklasse ${job.error_code}` : ""}`;
    jobTargets(id, meta).forEach((node) => {
      if (node.dataset.jobTerminal === id && !terminal.has(job.status)) return;
      node.textContent = text;
      if (terminal.has(job.status)) node.dataset.jobTerminal = id;
    });
  }
  function stopJobPoller(id, { remove = false } = {}) {
    const state = jobPollers.get(id);
    if (!state) return;
    clearTimeout(state.timer);
    state.controller?.abort();
    jobPollers.delete(id);
    try {
      const lease = JSON.parse(localStorage.getItem(leaseKey(id)) || "{}");
      if (lease.owner === pollOwner) localStorage.removeItem(leaseKey(id));
    } catch {}
    if (remove) {
      localStorage.removeItem(`wb-tender-job:${id}`);
      localStorage.removeItem(snapshotKey(id));
    }
  }
  function trackJob(id) {
    if (jobPollers.has(id)) return jobPollers.get(id);
    const state = {
        timer: null,
        controller: null,
        polls: 0,
        backoff: 0,
        stopped: false,
      },
      schedule = (delay) => {
        clearTimeout(state.timer);
        const adjusted =
          document.visibilityState === "hidden"
            ? Math.max(30000, delay)
            : Math.max(2000, delay);
        state.timer = setTimeout(tick, adjusted);
      },
      tick = async () => {
        if (state.stopped || state.controller) return;
        if (!claimLease(id)) {
          schedule(3000);
          return;
        }
        state.controller = new AbortController();
        try {
          const job = await get(
            `/management-inbox/autopilot/jobs/${encodeURIComponent(id)}`,
            { signal: state.controller.signal },
          );
          state.polls++;
          state.backoff = 0;
          const delay = state.polls === 1 ? 5000 : 10000,
            snapshot = {
              ...job,
              lastCheckedAt: Date.now(),
              nextCheckAt:
                Date.now() +
                (document.visibilityState === "hidden" ? 30000 : delay),
            };
          localStorage.setItem(snapshotKey(id), JSON.stringify(snapshot));
          showJob(id, snapshot);
          if (terminal.has(job.status)) {
            stopJobPoller(id, { remove: true });
            return;
          }
          schedule(delay);
        } catch (error) {
          if (error.name === "AbortError") return;
          if (error.status === 401 || error.status === 403) {
            showJob(
              id,
              { status: "QUEUED" },
              `Job-ID ${id} · Statusabruf beendet: Anmeldung oder MFA-Sitzung erforderlich.`,
            );
            stopJobPoller(id);
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
            seconds = Math.ceil(delay / 1000),
            snapshot = {
              status: "QUEUED",
              lastCheckedAt: null,
              nextCheckAt: Date.now() + delay,
            };
          showJob(
            id,
            snapshot,
            error.status === 429
              ? `Job-ID ${id} · Der Job läuft weiter. Der Status wird wegen zu vieler Abfragen in ${seconds} Sekunden erneut geprüft.`
              : `Job-ID ${id} · Statusabruf vorübergehend nicht möglich. Erneuter Versuch in ${seconds} Sekunden.`,
          );
          schedule(delay);
        } finally {
          state.controller = null;
        }
      };
    jobPollers.set(id, state);
    schedule(2000 + Math.floor(Math.random() * 500));
    return state;
  }
  function restoreJobPollers() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("wb-tender-job:") && !key.includes("snapshot"))
        trackJob(key.slice("wb-tender-job:".length));
    }
  }
  addEventListener("storage", (event) => {
    if (event.key?.startsWith("wb-tender-job-snapshot:") && event.newValue) {
      const id = event.key.slice("wb-tender-job-snapshot:".length);
      try {
        showJob(id, JSON.parse(event.newValue));
      } catch {}
    }
    if (event.key?.startsWith("wb-tender-job:") && event.newValue)
      trackJob(event.key.slice("wb-tender-job:".length));
  });
  addEventListener("pagehide", () =>
    [...jobPollers].forEach(([id, state]) => {
      state.stopped = true;
      stopJobPoller(id);
    }),
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") restoreJobPollers();
  });
  setTimeout(restoreJobPollers, 0);
  async function portalView() {
    const requestedParams = new URL(location.href).searchParams;
    if (requestedParams.get("focus") === "adapter" && !requestedParams.get("credential") && ["portal", "company", "tender"].every((key) => requestedParams.get(key))) {
      await scopedPortalAdapterView(requestedParams);
      return;
    }
    if (["portal", "credential", "company", "tender"].every((key) => requestedParams.get(key))) {
      await scopedPortalAccountView(requestedParams);
      return;
    }
    const d = await get("/portals");
    out.innerHTML =
      title(
        "Portalzugänge",
        "Gesellschaftsgebundene Vergabeportal-Zugänge. Kontobezogene Rechte und die globale externe Abgabesperre bleiben strikt getrennt; verbindliche Aktionen bleiben HTTP 423 gesperrt.",
      ) +
      `<div class="grid portal-grid">${d.items.map(portalCards).join("")}</div>`;
    const byId = (id) => d.items.find((x) => x.portalId === id),
      status = (button, text) =>
        (button
          .closest(".portal-card")
          .querySelector("[data-portal-status]").textContent = text),
      startPortalJobTracking = (portalId, job) => {
        const node = document
          .querySelector(`[data-portal-card="${CSS.escape(portalId)}"]`)
          ?.querySelector("[data-portal-status]");
        if (node) node.dataset.jobId = job.job_id;
        localStorage.setItem(
          `wb-tender-job:${job.job_id}`,
          JSON.stringify({ portalId, companyId: job.company_id, credentialId: job.credential_id }),
        );
        trackJob(job.job_id);
      };
    document
      .querySelectorAll("[data-configure-portal]")
      .forEach(
        (b) => (b.onclick = () => portalForm(byId(b.dataset.configurePortal), b.dataset.company)),
      );
    document.querySelectorAll("[data-test-portal]").forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            const x = await mutate(
              `/portal-access/${b.dataset.testPortal}/jobs`,
              "POST",
              {
                action_type: "TEST_PORTAL_CONNECTION",
                company_id: b.dataset.company,
              },
            );
            status(b, "Anmeldung wird geprüft.");
            startPortalJobTracking(b.dataset.testPortal, x);
          } catch (e) {
            status(b, e.message);
          } finally {
            b.disabled = false;
          }
        }),
    );
    document.querySelectorAll("[data-test-documents]").forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            const x = await mutate(
              `/portal-access/${b.dataset.testDocuments}/jobs`,
              "POST",
              {
                action_type: "TEST_DOCUMENT_FETCH",
                company_id: b.dataset.company,
              },
            );
            status(b, "Der Dokumentenzugang wird geprüft.");
            startPortalJobTracking(b.dataset.testDocuments, x);
          } catch (e) {
            status(b, e.message);
          } finally {
            b.disabled = false;
          }
        }),
    );
    document.querySelectorAll("[data-remove-portal]").forEach(
      (b) =>
        (b.onclick = async () => {
          const card = b.closest(".portal-card"),
            companyName = card.querySelector(".portal-company-name")?.textContent?.trim() || "diese Gesellschaft";
          if (!confirm(`Portalzugang für ${companyName} wirklich entfernen?`)) return;
          await mutate(
            `/portal-access/${b.dataset.removePortal}/credentials?company=${encodeURIComponent(b.dataset.company)}`,
            "DELETE",
          );
          portalView();
        }),
    );
    document.querySelectorAll("[data-portal-tenders]").forEach(
      (b) =>
        (b.onclick = async () => {
          const x = await get(
            `/portal-access/${b.dataset.portalTenders}/tenders`,
          );
          out.innerHTML =
            title(
              "Betroffene Ausschreibungen",
              byId(b.dataset.portalTenders).portalName,
            ) +
            table(x.items, [
              "title",
              "source_code",
              "offer_deadline",
              "fetch_status",
            ]) +
            `<button id="portal-back">Zurück zu Portalzugängen</button>`;
          document.querySelector("#portal-back").onclick = portalView;
        }),
    );
    const requested = new URL(location.href).searchParams.get("portal"),
      requestedCompany = state().company;
    if (requested && requestedCompany && byId(requested)?.canManage)
      await portalForm(byId(requested), requestedCompany, {
        locked: Boolean(state().tender),
      });
  }
  const scopedModeLabel = (mode) => ({
    READ_ONLY: "Nur lesen",
    OFFER_PREPARATION_WRITE: "Für Angebotsvorbereitung schreibfähig",
    SEND_RIGHTS_GRANTED: "Senderechte intern erteilt",
    SEND_RIGHTS_EFFECTIVE_AS_PREREQUISITE: "Senderechte als interne Voraussetzung erteilt",
    RELOGIN_REQUIRED: "Re-Login für diese Gesellschaft und dieses Credential erforderlich",
    UNAVAILABLE_ADAPTER_CONFIGURATION_REQUIRED: "Nicht verfügbar – Adapterkonfiguration erforderlich",
  })[mode] || mode;
  async function scopedPermissionConfirmation(scope, activate) {
    const phrase = activate ? scope.activationConfirmationPhrase : scope.revocationConfirmationPhrase,
      dialog = document.createElement("dialog");
    dialog.className = "approval-dialog";
    dialog.innerHTML = `<form method="dialog"><h2>${activate ? "Senderechte dieses Portalzugangs aktivieren" : "Senderechte dieses Portalzugangs deaktivieren"}</h2><dl><dt>Portal</dt><dd>${esc(scope.portal_name)}</dd><dt>Account</dt><dd>${esc(scope.credential_id)}</dd><dt>Gesellschaft</dt><dd>${esc(scope.company_name)}</dd><dt>Tender / Los</dt><dd>${esc(scope.tender_id)} / ${esc(scope.lot_key || "Gesamt")}</dd></dl><p><strong>Dies hebt die globale Abgabesperre nicht auf.</strong> Eine konkrete tenderbezogene finale Freigabe und das serverseitige globale Gate bleiben separat erforderlich; verbindliche Endpunkte bleiben HTTP 423.</p><label>Verbindlicher Bestätigungssatz<input name="confirmation" autocomplete="off"></label><p class="confirmation-phrase">${esc(phrase)}</p><p class="error" hidden></p><div class="review-actions"><button value="cancel">Abbrechen</button><button type="button" data-confirm-scope disabled>${activate ? "Kontobezogene Senderechte aktivieren" : "Kontobezogene Senderechte deaktivieren"}</button></div></form>`;
    document.body.append(dialog);
    const input = dialog.querySelector("input"), confirm = dialog.querySelector("[data-confirm-scope]"), error = dialog.querySelector(".error");
    input.oninput = () => (confirm.disabled = input.value !== phrase);
    confirm.onclick = async () => {
      confirm.disabled = true;
      try {
        await mutate(`/portal-access/${encodeURIComponent(scope.portal_id)}/submission-grants${activate ? "" : "/revoke"}`, "POST", { credentialId: scope.credential_id, companyId: scope.company_id, scope: "SUBMISSION_PREFLIGHT_AND_FINAL_SUBMISSION", confirmation: input.value });
        dialog.close();
        await scopedPortalAccountView(new URL(location.href).searchParams);
      } catch (reason) {
        error.textContent = reason.message;
        error.hidden = false;
        confirm.disabled = false;
      }
    };
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    input.focus();
  }
  async function scopedPortalAccountView(params) {
    const query = new URLSearchParams();
    for (const key of ["credential", "company", "tender", "lot"]) query.set(key, params.get(key) || "");
    const portalId = params.get("portal"),
      scope = await get(`/portal-access/${encodeURIComponent(portalId)}/scoped-account?${query}`),
      focus = params.get("focus") || "permissions",
      lastValidation = scope.last_verified_at || scope.identity_verified_at || null,
      capability = scope.capabilityReady
        ? "Produktiv validiert und browserabgenommen"
        : `Nicht wirksam: ${scope.portal_support || "UNKNOWN"}; Autopilot ${scope.autopilot_supported ? "vorhanden" : "nicht implementiert"}; Adapterstatus ${scope.adapter_validation_status || "unbekannt"}`;
    out.innerHTML = title("Fokussierter Portalzugang", `${scope.portal_name} · ${scope.company_name} · Los ${scope.lot_key || "Gesamt"}`) +
      `<section class="panel portal-bound-scope" aria-label="Vollständig gebundener Portalzugang"><h3>Exakter Account- und Tenderkontext</h3><dl><dt>Portal</dt><dd><strong>${esc(scope.portal_name)}</strong> · ${esc(scope.canonical_domain)}</dd><dt>Portal-ID</dt><dd><code>${esc(scope.portal_id)}</code></dd><dt>Account/Credential</dt><dd><code>${esc(scope.credential_id)}</code> · Version ${esc(scope.credential_version)}</dd><dt>Gesellschaft</dt><dd><strong>${esc(scope.company_name)}</strong> · <code>${esc(scope.company_id)}</code></dd><dt>Tender / Los</dt><dd><code>${esc(scope.tender_id)}</code> / <code>${esc(scope.lot_key || "Gesamt")}</code></dd><dt>Letzte Validierung</dt><dd>${esc(lastValidation ? calcDate(lastValidation) : "Nicht validiert")}</dd></dl></section>` +
      `<section class="panel" id="account-send-rights"><h3>Kontobezogene Zugriffs- und Senderechte</h3><dl><dt>Gespeicherter Accountmodus</dt><dd>${esc(scopedModeLabel(scope.accountMode))}</dd><dt>Aktuell wirksamer Modus</dt><dd><strong>${esc(scopedModeLabel(scope.effectiveMode))}</strong></dd><dt>Portalsitzung</dt><dd>${scope.reLoginRequired ? `Re-Login für ${esc(scope.company_name)} / Credential v${esc(scope.credential_version)} erforderlich` : "Aktiv, verifiziert und gesellschaftsgebunden"}</dd><dt>Portal-Capability</dt><dd>${esc(capability)}</dd><dt>Grant-Audit</dt><dd>${esc(scope.grant_audit_id || "Kein aktiver Grant")}</dd></dl><div class="notice"><strong>Globale externe Abgabe bleibt gesperrt.</strong><br>Kontobezogene Senderechte sind nur eine notwendige interne Voraussetzung. Eine konkrete tenderbezogene finale Freigabe und das serverseitige globale Gate bleiben separat erforderlich. Alle verbindlichen Endpunkte bleiben HTTP ${esc(scope.globalGate.bindingEndpointsHttpStatus)}; <code>transmitted=false</code>.</div><div class="review-actions">${scope.canActivate ? '<button type="button" id="activate-scoped-send-rights">Senderechte dieses Accounts aktivieren</button>' : ""}${scope.canDeactivate ? '<button type="button" id="deactivate-scoped-send-rights">Senderechte dieses Accounts deaktivieren</button>' : ""}</div></section>` +
      `<section class="panel" id="adapter-configuration"><h3>Submission-Adapter dieses Kontexts</h3><dl><dt>Adapter</dt><dd><strong>${esc(scope.adapter_name)}</strong> · ${esc(scope.adapter_id)} · Version ${esc(scope.adapter_version || "unbekannt")}</dd><dt>Produktivreife</dt><dd>${scope.capabilityReady ? "Produktiv validiert" : "Nicht produktiv write-capable validiert"}</dd><dt>Interner Nachweis</dt><dd>${esc(scope.evidence_note || "Kein belastbarer produktiver Submission-Nachweis hinterlegt")}</dd></dl><h4>Nächste sichere interne Schritte</h4><ol>${scope.safeNextSteps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol><p class="muted">Diese Schritte führen keine externe Submission und keine rechtlich bindende Portalaktion aus.</p></section>` +
      `<div class="review-actions"><button type="button" id="scoped-portal-back">Zurück</button><a class="button-link" href="${esc(href("submission-status", { ...state(), tender: scope.tender_id, company: scope.company_id, lot: scope.lot_key }))}">Zum Abgabestatus</a></div>`;
    document.querySelector("#activate-scoped-send-rights")?.addEventListener("click", () => scopedPermissionConfirmation(scope, true));
    document.querySelector("#deactivate-scoped-send-rights")?.addEventListener("click", () => scopedPermissionConfirmation(scope, false));
    document.querySelector("#scoped-portal-back").onclick = () => history.back();
    document.querySelector(`#${focus === "adapter" ? "adapter-configuration" : "account-send-rights"}`)?.scrollIntoView({ block: "start" });
  }
  async function scopedPortalAdapterView(params) {
    const query = new URLSearchParams(); for (const key of ["company", "tender", "lot"]) query.set(key, params.get(key) || "");
    const scope = await get(`/portal-access/${encodeURIComponent(params.get("portal"))}/scoped-adapter?${query}`);
    out.innerHTML = title("Fokussierter Submission-Adapter", `${scope.portal_name} · Los ${scope.lot_key || "Gesamt"}`) + `<section class="panel" id="adapter-configuration"><h3>Submission-Adapter dieses Kontexts</h3><dl><dt>Portal</dt><dd>${esc(scope.portal_name)} · <code>${esc(scope.portal_id)}</code></dd><dt>Tender / Gesellschaft / Los</dt><dd><code>${esc(scope.tender_id)}</code> / <code>${esc(scope.company_id)}</code> / <code>${esc(scope.lot_key || "Gesamt")}</code></dd><dt>Adapter</dt><dd><strong>${esc(scope.adapter_name)}</strong> · ${esc(scope.adapter_id)} · Version ${esc(scope.adapter_version || "unbekannt")}</dd><dt>Produktivreife</dt><dd>${scope.capabilityReady ? "Produktiv validiert" : "Nicht produktiv write-capable validiert"}</dd><dt>Interner Nachweis</dt><dd>${esc(scope.evidence_note || "Kein belastbarer produktiver Submission-Nachweis hinterlegt")}</dd></dl><h4>Nächste sichere interne Schritte</h4><ol>${scope.safeNextSteps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol><div class="notice">Die globale externe Abgabe bleibt gesperrt; alle verbindlichen Endpunkte bleiben HTTP ${esc(scope.globalGate.bindingEndpointsHttpStatus)} und <code>transmitted=false</code>.</div></section><div class="review-actions"><button type="button" id="scoped-adapter-back">Zurück</button><a class="button-link" href="${esc(href("submission-status", { ...state(), tender: scope.tender_id, company: scope.company_id, lot: scope.lot_key }))}">Zum Abgabestatus</a></div>`;
    document.querySelector("#scoped-adapter-back").onclick = () => history.back();
  }
  function portalSubmissionAccessTable(access) {
    return `<section class="panel"><h3>Submission-Berechtigungen</h3><p>Die Freigabe ist gesellschaftsscharf und ändert oder kopiert keine Zugangsdaten.</p><div class="table-wrap"><table class="capability-table"><thead><tr><th>Portal</th><th>Account</th><th>Gesellschaft</th><th>Berechtigung</th><th>Aktion</th></tr></thead><tbody>${access.items.map((item) => `<tr><th>${esc(item.portal_name)}</th><td>${item.accountPresent ? "Vorhanden" : "Nicht vorhanden"}</td><td>${esc(item.company_name || "Keine Gesellschaft zugeordnet")}</td><td><strong>${esc(item.permissionStatus)}</strong></td><td>${item.canGrant ? `<button type="button" data-grant-submission="${esc(item.portal_id)}" data-credential="${esc(item.credential_id)}" data-company="${esc(item.company_id)}">Submission für diesen Portalzugang freigeben</button>` : item.submissionGranted && !item.capabilityReady ? "Grant gespeichert, technisch nicht wirksam – im fokussierten Account deaktivierbar" : item.submissionGranted ? "Bewusst als interne Voraussetzung freigegeben" : item.capabilityReady ? "Submission-Freischaltung durch Benutzer erforderlich" : "Adapter zuerst produktiv validieren"}</td></tr>`).join("")}</tbody></table></div></section>`;
  }
  function portalCompanyMatrix(matrix) {
    const options = (key, label) =>
      `<option value="">${label}</option>${[...new Map(matrix.items.map((x) => [x[key], x[key === "portal_id" ? "portal_name" : "company_name"]])).entries()].map(([value, name]) => `<option value="${esc(value)}">${esc(name)}</option>`).join("")}`;
    return `<section class="panel portal-company-matrix"><header><div><h3>Gesellschaftsbezogene Bieteraccount-Matrix</h3><p>Accountidentität und Bietergesellschaft werden nur aus autoritativen Nachweisen abgeleitet.</p></div></header><div class="matrix-filters"><label>Portal<select data-matrix-filter="portal">${options("portal_id", "Alle Portale")}</select></label><label>Gesellschaft<select data-matrix-filter="company">${options("company_id", "Alle Gesellschaften")}</select></label><label>Status<select data-matrix-filter="status"><option value="">Alle Status</option>${Object.entries(
      matrix.statusLabels,
    )
      .map(
        ([value, name]) =>
          `<option value="${esc(value)}">${esc(name)}</option>`,
      )
      .join(
        "",
      )}</select></label></div><div class="table-wrap"><table class="capability-table"><thead><tr><th>Portal</th><th>Gesellschaft</th><th>Account</th><th>Bietergesellschaft</th><th>Dokumentzugriff</th><th>Submission</th><th>Interne Freigabe</th><th>Status</th><th>Letzte Prüfung</th></tr></thead><tbody data-matrix-body>${matrix.items.map((item) => `<tr data-matrix-portal="${esc(item.portal_id)}" data-matrix-company="${esc(item.company_id)}" data-matrix-status="${esc(item.eligibility_status)}"><th>${esc(item.portal_name)}</th><td>${esc(item.company_name)}</td><td>${esc(item.account_holder_name || "Nicht autoritativ bestätigt")}</td><td>${esc(item.legal_bidder_name || "Nicht autoritativ bestätigt")}</td><td>${item.document_access ? "Ja" : "Nicht bestätigt"}</td><td>${item.submission_possible ? "Ja" : "Nein"}</td><td>${item.internal_submission_permission ? "Erteilt" : "Nicht erteilt"}</td><td><strong>${esc(item.status_label)}</strong></td><td>${esc(calcDate(item.last_verified_submission_account_check || item.last_verified_login))}</td></tr>`).join("")}</tbody></table></div></section>`;
  }
  function openSubmissionGrantDialog(item, phrase) {
    const dialog = document.createElement("dialog");
    dialog.className = "approval-dialog";
    dialog.innerHTML = `<form method="dialog"><h2>Submission für diesen Portalzugang freigeben</h2><dl><dt>Portal</dt><dd>${esc(item.portal_name)}</dd><dt>Gesellschaft</dt><dd>${esc(item.company_name)}</dd><dt>Umfang</dt><dd>Preflight und einmalige finale Angebotsabgabe nach separater Tenderfreigabe</dd></dl><p>Es wird kein Passwort geändert oder kopiert. Die Freigabe wird an Portal, Credential, Gesellschaft und handelnden Benutzer gebunden.</p><label>Verbindlicher Bestätigungssatz<input name="confirmation" autocomplete="off"></label><p class="confirmation-phrase">${esc(phrase)}</p><p class="error" hidden></p><div class="review-actions"><button value="cancel">Abbrechen</button><button type="button" data-confirm-grant disabled>Submission freigeben</button></div></form>`;
    document.body.append(dialog);
    const input = dialog.querySelector("input"),
      confirm = dialog.querySelector("[data-confirm-grant]"),
      error = dialog.querySelector(".error");
    input.oninput = () => (confirm.disabled = input.value !== phrase);
    confirm.onclick = async () => {
      confirm.disabled = true;
      try {
        await mutate(
          `/portal-access/${encodeURIComponent(item.portal_id)}/submission-grants`,
          "POST",
          {
            credentialId: item.credential_id,
            companyId: item.company_id,
            scope: "SUBMISSION_PREFLIGHT_AND_FINAL_SUBMISSION",
            confirmation: input.value,
          },
        );
        dialog.close();
        await portalCapabilityView();
      } catch (reason) {
        error.textContent = reason.message;
        error.hidden = false;
        confirm.disabled = false;
      }
    };
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    input.focus();
  }
  async function portalCapabilityView() {
    const [d, access, matrix] = await Promise.all([
      get("/portals"),
      get("/portal-submission-access"),
      get("/portal-company-eligibility"),
    ]);
    out.innerHTML =
      title(
        "Portal Capability Layer",
        "Objektive Portalfähigkeiten, Accountidentität und gesellschaftsbezogene Submission-Eignung werden getrennt ausgewiesen.",
      ) +
      portalCompanyMatrix(matrix) +
      portalSubmissionAccessTable(access) +
      portalOverviewTable(d.items);
    const byId = (id) => d.items.find((item) => item.portalId === id);
    document
      .querySelectorAll("[data-capability-detail]")
      .forEach(
        (button) =>
          (button.onclick = () =>
            portalCapabilityDetail(byId(button.dataset.capabilityDetail))),
      );
    document.querySelectorAll("[data-grant-submission]").forEach((button) => {
      const item = access.items.find(
        (row) =>
          row.portal_id === button.dataset.grantSubmission &&
          row.credential_id === button.dataset.credential &&
          row.company_id === button.dataset.company,
      );
      button.onclick = () =>
        openSubmissionGrantDialog(item, access.confirmationPhrase);
    });
    const filters = [...document.querySelectorAll("[data-matrix-filter]")],
      apply = () =>
        document.querySelectorAll("[data-matrix-body] tr").forEach((row) => {
          row.hidden = filters.some(
            (filter) =>
              filter.value &&
              row.dataset[
                `matrix${filter.dataset.matrixFilter[0].toUpperCase()}${filter.dataset.matrixFilter.slice(1)}`
              ] !== filter.value,
          );
        });
    filters.forEach((filter) => (filter.onchange = apply));
    const requested = new URL(location.href).searchParams.get("portal");
    if (requested && byId(requested)) portalCapabilityDetail(byId(requested));
  }
  async function productReadinessView() {
    const data = await get("/product-readiness"), yes = value => value ? "Ja" : "Nein";
    const featureLabels = {
      PROCUREMENT_DOCUMENTS:"Vergabeunterlagen",PDF:"PDF",ZIP:"ZIP",GAEB:"GAEB",EXCEL:"Excel",XML:"XML",
      ATTACHMENTS:"Anhänge",BIDDER_COMMUNICATION:"Bieterkommunikation",PARTICIPATION:"Teilnahme",
      SUBMISSION_PREFLIGHT:"Submission-Preflight",AMENDMENTS:"Nachträge",WITHDRAWALS:"Widerrufe / Rücknahmen",
      AWARD:"Award",HISTORY:"Historie",SUBMISSION:"Externe Abgabe",
    };
    const portalRows = data.portals.map(portal => {
      const features = Object.entries(portal.features).sort(([a],[b])=>a.localeCompare(b));
      return `<section class="panel readiness-portal"><h3>${esc(portal.portalName)}</h3><p class="muted">${esc(portal.domain)} · Adapter: ${esc(portal.adapterValidationStatus)} · Portalzugang im berechtigten Gesellschaftsscope: ${yes(portal.credentialConfigured)}</p><div class="panel"><table><thead><tr><th>Funktion</th><th>Portal unterstützt</th><th>Autopilot unterstützt</th><th>Konfiguriert</th><th>Technisch getestet</th><th>Produktiv browsergeprüft</th></tr></thead><tbody>${features.map(([key,f])=>`<tr><th>${esc(featureLabels[key]||key)}</th><td>${esc(f.portalSupported)}</td><td>${yes(f.autopilotSupported)}</td><td>${yes(f.configured)}</td><td>${yes(f.technicallyTested)}</td><td>${yes(f.productiveBrowserVerified)}</td></tr>`).join("")}</tbody></table></div></section>`;
    }).join("");
    out.innerHTML = title("Produktumfang & Readiness","Autoritative Laufzeitansicht mit expliziter Leistungsgrenze und getrennten Capability-Nachweisen.")+
      `<section class="panel"><h3>${esc(data.scope.marketableAs)}</h3><p><strong>Nicht enthalten:</strong> ${esc(data.scope.mustNotBeMarketedAs)}. Submission, Teilnahmeaktivierung, Bieterkommunikation, Widerruf, Rücknahme und das Senden von Nachträgen bleiben serverseitig HTTP 423.</p><dl><dt>Edition</dt><dd>${esc(data.gate.status)}</dd><dt>Externe Abgabe bereit</dt><dd>Nein</dd><dt>Externe Übermittlung aktiviert</dt><dd>Nein</dd><dt>Als übertragen markierte Datensätze</dt><dd>${esc(data.safety.transmittedTrue)}</dd><dt>Stand</dt><dd>${esc(germanDateTime(data.generatedAt))}</dd></dl></section>`+
      `<section class="notice" role="note"><strong>Verkaufsfähige Leistungsgrenze</strong><p>Die Edition unterstützt interne Tenderbearbeitung und sicheren Portal-Preflight. Unbelegte oder nicht browsergeprüfte Portalmerkmale sind nicht als verfügbar zu verstehen.</p></section>`+portalRows;
  }
  async function globalView(s) {
    if (s.view === "internal-acceptance") {
      const d = await get("/internal-acceptance");
      out.innerHTML =
        title(
          labels[s.view],
          "Strikt von realen Tenderlisten, Vorstandskennzahlen und externen Statistiken getrennte technische End-to-End-Nachweise",
        ) +
        section("Isolation", {
          Klassifikation: d.classification,
          Reale_Tenderlisten: d.excludedFromRealTenderLists
            ? "AUSGESCHLOSSEN"
            : "FEHLER",
          Vorstandskennzahlen: d.excludedFromBoardMetrics
            ? "AUSGESCHLOSSEN"
            : "FEHLER",
          Externe_Statistiken: d.excludedFromExternalStatistics
            ? "AUSGESCHLOSSEN"
            : "FEHLER",
          Externe_Aktionen: d.externalWritesEnabled ? "FEHLER" : "DEAKTIVIERT",
        }) +
        d.items
          .map(
            (item) =>
              title(
                item.fixture_key,
                `${item.legal_name} · ${item.service_area}`,
              ) +
              section("Pipeline und kanonischer Snapshot", {
                Jobstatus: item.job_status,
                Pipelineschritt: item.current_step,
                Dokumente: `${item.documents_found}/${item.documents_downloaded}/${item.documents_analyzed}`,
                Kalkulationsstatus: item.calculation_result_status,
                Kanonischer_Snapshot: item.canonical_snapshot_id,
                Historisch: item.historical,
                Read_Model: item.read_model_status,
                Managementstatus: item.management_status,
                Transmitted: item.transmitted,
                Manifest_SHA256: item.manifest_sha256,
              }) +
              section("Kalkulation", item.calculation) +
              section("Managementausgabe", item.management_output),
          )
          .join("");
      return;
    }
    if (s.view === "portals") return portalCapabilityView();
    if (s.view === "readiness") return productReadinessView();
    if (s.view === "portal-access") return portalView();
    if (s.view === "settings") {
      const d = await get("/autopilot/status");
      out.innerHTML =
        title(
          labels[s.view],
          "Ausschließlich lesbare Tender-Autopilot-Einstellungen",
        ) +
        `<section class="panel"><h3>Portalzugänge</h3><p>Verschlüsselte, gesellschaftsscharfe Zugänge für den lesenden Dokumentenabruf verwalten.</p><a class="button-link" href="${esc(href("portal-access", s))}">Portalzugänge öffnen</a></section>` +
        table(d.phases || []);
      return;
    }
    if(s.view==="documents-inbox"){
      const [d,a]=await Promise.all([get("/management/required-documents-inbox"),get("/management/final-preflight-actions")]);
      const options=(items,key)=>[...new Set(items.map(x=>x[key]).filter(Boolean))].sort().map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");
      out.innerHTML=title("Vor Angebotsabgabe erforderlich","Nur tatsächlich menschlich zu bearbeitende Punkte; technische Verarbeitung läuft automatisch")+`<section class="panel"><h3>Benutzeraktionen filtern</h3><div class="matrix-filters action-filters"><label>Gesellschaft<select data-action-filter="company"><option value="">Alle</option>${options(a.items,"company_name")}</select></label><label>Portal<select data-action-filter="portal"><option value="">Alle</option>${options(a.items,"portal_name")}</select></label><label>Leistungsbereich<select data-action-filter="service"><option value="">Alle</option>${options(a.items,"service_line")}</select></label><label>Tender<select data-action-filter="tender"><option value="">Alle</option>${options(a.items,"tender_title")}</select></label><label>Los<select data-action-filter="lot"><option value="">Alle</option>${options(a.items,"lot_key")}</select></label><label>Frist<select data-action-filter="deadline"><option value="">Alle</option><option value="7">Nächste 7 Tage</option><option value="30">Nächste 30 Tage</option></select></label><label>Blockertyp<select data-action-filter="blocker"><option value="">Alle</option>${options(a.items,"action_group")}</select></label><label>Priorität<select data-action-filter="priority"><option value="">Alle</option>${options(a.items,"priority")}</select></label></div></section><section class="panel"><h3>${esc(d.items.length)} offene Unterlagen</h3><div class="presentation-grid">${d.items.map(x=>`<article class="presentation-card"><h4>${esc(x.requirement_title)}</h4><dl><dt>Tender</dt><dd>${esc(x.title)}</dd><dt>Los</dt><dd>${esc(x.lot_key||"Gesamt")}</dd><dt>Gesellschaft</dt><dd>${esc(x.company_name)}</dd><dt>Status</dt><dd><strong>${esc(x.status_label)}</strong></dd><dt>Frist</dt><dd>${esc(calcDate(x.offer_deadline))}</dd></dl><a class="button-link" href="${esc(href("detail",{...s,tender:x.tender_id,company:x.company_id,lot:x.lot_key}))}">Dokument hochladen</a></article>`).join("")||"<p>Keine offenen Pflichtunterlagen.</p>"}</div></section><section class="panel"><h3><span data-action-count>${esc(a.items.length)}</span> weitere Benutzeraktionen</h3><div class="presentation-grid">${a.items.map(x=>`<article class="presentation-card" data-action-card data-company="${esc(x.company_name)}" data-portal="${esc(x.portal_name)}" data-service="${esc(x.service_line)}" data-tender="${esc(x.tender_title)}" data-lot="${esc(x.lot_key)}" data-deadline="${esc(x.due_at||"")}" data-blocker="${esc(x.action_group)}" data-priority="${esc(x.priority)}"><h4>${esc(x.display_title)}</h4><dl><dt>Tender</dt><dd>${esc(x.tender_title)}</dd><dt>Los</dt><dd>${esc(x.lot_key||"Gesamt")}</dd><dt>Gesellschaft</dt><dd>${esc(x.company_name)}</dd><dt>Portal</dt><dd>${esc(x.portal_name)}</dd><dt>Aktion</dt><dd>${esc(x.instruction)}</dd><dt>Quelle</dt><dd>${esc(x.source_reference)}${x.source_page?`, Seite ${esc(x.source_page)}`:""}</dd><dt>Frist</dt><dd>${esc(calcDate(x.due_at))}</dd></dl><a class="button-link" href="${esc(href("management-output",{...s,tender:x.tender_id,company:x.company_id,lot:x.lot_key}))}">Aktion öffnen</a></article>`).join("")||"<p>Keine weiteren menschlichen Aktionen.</p>"}</div></section>`;
      const requiredCards=[...out.querySelectorAll(".presentation-grid")][0]?.querySelectorAll(".presentation-card")||[];requiredCards.forEach((card,index)=>{const item=d.items[index];if(!item)return;card.dataset.actionCard="";card.dataset.company=item.company_name||"";card.dataset.portal=item.portal_name||"";card.dataset.service=item.service_line||"";card.dataset.tender=item.title||"";card.dataset.lot=item.lot_key||"";card.dataset.deadline=item.offer_deadline||"";card.dataset.blocker="MISSING_DOCUMENT";card.dataset.priority=item.priority||"";const link=card.querySelector("a");if(link)link.href+=`#required-document-${item.id}`;card.insertAdjacentHTML("beforeend",`<a class="button-link" href="${esc(link?.href||href("detail",{...s,tender:item.tender_id,company:item.company_id,lot:item.lot_key}))}">Anforderung anzeigen</a>`)});
      const applyFilters=()=>{const selected=Object.fromEntries([...out.querySelectorAll("[data-action-filter]")].map(x=>[x.dataset.actionFilter,x.value])),now=Date.now();let visible=0;for(const card of out.querySelectorAll("[data-action-card]")){const deadline=card.dataset.deadline?new Date(card.dataset.deadline).getTime():null,days=Number(selected.deadline||0),match=["company","portal","service","tender","lot","blocker","priority"].every(k=>!selected[k]||card.dataset[k]===selected[k])&&(!days||deadline&&deadline>=now&&deadline<=now+days*86400000);card.hidden=!match;if(match)visible++}out.querySelector("[data-action-count]").textContent=String(visible)};const reset=document.createElement("button");reset.type="button";reset.textContent="Filter zurücksetzen";reset.onclick=()=>{out.querySelectorAll("[data-action-filter]").forEach(x=>x.value="");applyFilters()};out.querySelector(".action-filters")?.append(reset);out.querySelectorAll("[data-action-filter]").forEach(x=>x.addEventListener("change",applyFilters));return;
    }
    if(s.view==="signatures"){
      const d=await get("/management/signature-workbench");
      const statusLabel={SIGNATURE_DOCUMENT_PREPARED:"Signaturkopie vorbereitet",SIGNATURE_ACTION_REQUIRED:"Unterschrift erforderlich",SIGNED_DOCUMENT_UPLOADED:"Unterschriebene Fassung hochgeladen",SIGNATURE_VALIDATED:"Signatur geprüft",SIGNATURE_REJECTED_WITH_REASON:"Datei abgelehnt",MANUAL_REVIEW_REQUIRED:"Manuelle Sichtprüfung erforderlich"};
      out.innerHTML=title("Zu unterschreiben","Versionsgebundene PDF-Arbeitskopien. Der Autopilot erzeugt keine Unterschrift.")+`<section class="panel"><h3>${esc(d.items.length)} Signaturaktionen</h3><div class="presentation-grid">${d.items.map(x=>`<article class="presentation-card"><h4>${esc(x.requirement_title||x.source_filename)}</h4><dl><dt>Tender</dt><dd>${esc(x.title)}</dd><dt>Los</dt><dd>${esc(x.lot_key)}</dd><dt>Gesellschaft</dt><dd>${esc(x.company_name)}</dd><dt>Signaturart</dt><dd>${esc(x.signature_type.replaceAll("_"," ").toLocaleLowerCase("de-DE"))}</dd><dt>Unterzeichnerrolle</dt><dd>${esc(x.required_role||"Gemäß Vergabeunterlage zu prüfen")}</dd><dt>Position</dt><dd>${esc(x.signature_location||"Im Dokument ausgewiesen")}</dd><dt>Frist</dt><dd>${esc(calcDate(x.offer_deadline))}</dd><dt>Status</dt><dd>${esc(statusLabel[x.status]||"Prüfung erforderlich")}</dd><dt>Version / SHA-256</dt><dd>${esc(x.version)} / ${esc(x.working_sha256)}</dd></dl><a class="button-link" target="_blank" rel="noopener" href="/api/tender/signature-workbench/${esc(x.id)}/file">PDF öffnen / herunterladen</a><label class="button-link">Unterschriebenes PDF hochladen<input hidden type="file" accept="application/pdf" data-signature-upload="${esc(x.id)}"></label></article>`).join("")||"<p>Aktuell ist keine versionsgebundene Signaturkopie vorbereitet.</p>"}</div></section>`;
      for(const input of out.querySelectorAll("[data-signature-upload]"))input.addEventListener("change",async()=>{const file=input.files?.[0];if(!file)return;const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");reader.onerror=reject;reader.readAsDataURL(file)});await post(`/signature-workbench/${input.dataset.signatureUpload}/upload`,{filename:file.name,base64});await render()});
      return;
    }
    if(s.view==="operational-approvals"){
      const [profiles,actions,signatures,scanner]=await Promise.all([get("/profiles"),get("/management/final-preflight-actions"),get("/management/signature-workbench"),get("/management/malware-scanner/health")]);
      const profileItems=profiles.items||[],mfa=(actions.items||[]).filter(x=>x.action_group==="MFA"),approvals=(actions.items||[]).filter(x=>x.action_group==="APPROVAL"),signature=signatures.items?.[0];
      const card=(heading,body,action="")=>`<article class="presentation-card"><h4>${esc(heading)}</h4>${body}${action}</article>`;
      out.innerHTML=title("Sprint 4 – Operative Freigaben","Sicherer, authentifizierter RC4-Arbeitsbereich. Keine Aktion auf dieser Seite übermittelt ein Angebot.")+`<section class="panel"><h3>Systemschutz</h3><p>Malware-Scanner: <strong>${scanner.acceptingUploads?"bereit – Uploads werden fail-closed geprüft":"nicht bereit – Uploads bleiben gesperrt"}</strong></p></section><section class="panel"><h3>Erforderliche Schritte in Reihenfolge</h3><div class="presentation-grid">${card("1. Gesellschaftsprofile prüfen",`<p>${profileItems.length} Profile; jede Freigabe ist an Version und Fingerprint gebunden.</p>`,`<a class="button-link" href="${esc(href("company-profiles",s))}">Profile mit Quellen öffnen</a>`)}${card("2. DTVP-MFA bestätigen",`<p>${mfa.length?`${mfa.length} kontextgebundene MFA-Aktion(en).`:"Derzeit keine reprojizierte MFA-Aktion im Cockpit."}</p><p>Nicht erlaubt: Teilnahme oder Submission.</p>`)}${card("3. Vergabe24-Dokumentanforderung",`<p>${approvals.length?`${approvals.length} genehmigungspflichtige Aktion(en).`:"Keine ausführbare externe Anforderung ohne konkrete Freigabe."}</p><p>Nicht erlaubt: externe Anforderung ohne Freigabe.</p>`)}${card("4–5. LOT-0005 unterschreiben",signature?`<dl><dt>Tender</dt><dd>${esc(signature.title)}</dd><dt>Los</dt><dd>${esc(signature.lot_key)}</dd><dt>Gesellschaft</dt><dd>${esc(signature.company_name)}</dd><dt>Version / SHA-256</dt><dd>${esc(signature.version)} / ${esc(signature.working_sha256)}</dd></dl>`:"<p>Keine vorbereitete Signaturkopie.</p>",`<a class="button-link" href="${esc(href("signatures",s))}">Signatur-Workbench öffnen</a>`)}${card("6. Realen WB-Nachweis zuordnen",`<p>Nur gesellschafts-, gültigkeits- und requirementscharf passende Evidenz verwenden.</p>`,`<a class="button-link" href="${esc(href("documents-inbox",s))}">61 aktuelle Anforderungen prüfen</a>`)}${card("7–9. Automatische Rechecks und Pre-Submit",`<p>Nach einer gültigen Aktion folgen Requirement-, Management-, Package- und Preflight-Recheck automatisch. Finaler Commit bleibt gesperrt.</p>`)}</div></section>`;return;
    }
    if(s.view==="company-profiles"){
      const d=await get("/profiles"),status={READY_FOR_APPROVAL:"Zur fachlichen Freigabe vorbereitet",ACTIVE:"Aktiv",DRAFT:"Entwurf – Pflichtangaben fehlen",SUPERSEDED:"Durch neuere Version ersetzt",REVOKED:"Widerrufen"};
      out.innerHTML=title("Gesellschaftsprofile","Keine automatische Freigabe. Jede Aktivierung ist an Version, Quellen und SHA-256 gebunden.")+`<section class="panel"><h3>${esc(d.items.length)} Profilversionen</h3><div class="presentation-grid">${d.items.map(x=>{const missing=Array.isArray(x.missing_required)?x.missing_required:[],canApprove=x.lifecycle_status==="READY_FOR_APPROVAL"&&missing.length===0&&!/NOCH ZU PFLEGEN|GESPERRT/i.test(JSON.stringify(x.commercial_profile||{}));return `<article class="presentation-card"><h4>${esc(x.legal_name||x.name)}</h4><dl><dt>Service Line</dt><dd>${esc(x.capabilities?.serviceLine||"Nicht eindeutig belegt")}</dd><dt>Version</dt><dd>${esc(x.version)}</dd><dt>Status</dt><dd>${esc(status[x.lifecycle_status]||"Prüfung erforderlich")}</dd><dt>Vollständigkeit</dt><dd>${esc(x.completeness_percent)} %</dd><dt>Fingerprint</dt><dd>${esc(x.profile_sha256)}</dd><dt>Quellenstatus</dt><dd>${Object.keys(x.field_provenance||{}).length?"Feldprovenienz vorhanden":"Keine feldweise Provenienz gespeichert"}</dd><dt>Fehlende Pflichtfelder</dt><dd>${missing.length?esc(missing.join(", ")):"Keine im Profil markiert"}</dd><dt>Auswirkung</dt><dd>${canApprove?"Aktivierung startet automatische Rechecks für betroffene Tender.":"Kalkulation und Preflight bleiben gesperrt."}</dd></dl>${canApprove?`<button type="button" data-profile-activate="${esc(x.id)}" data-profile-hash="${esc(x.profile_sha256)}">Diese Version bewusst freigeben</button>`:`<p><strong>Nicht freigabefähig:</strong> Pflichtfelder oder autoritative Quellen fehlen.</p>`}</article>`}).join("")}</div></section>`;
      for(const button of out.querySelectorAll("[data-profile-activate]"))button.addEventListener("click",async()=>{if(!confirm("Diese konkrete Profilversion und ihre angezeigten Quellen verbindlich freigeben?"))return;await post(`/profiles/${button.dataset.profileActivate}/activate`,{profileSha256:button.dataset.profileHash,confirmation:"Ich bestätige diese konkrete Gesellschaftsprofilversion und ihre Quellen."});await render()});return;
    }
    const map = {
        sources: "/sources",
        scheduler: "/scheduler/status",
        connectors: "/sources",
        approvals: "/approvals",
        audit: "/audit",
        "company-profiles": "/profiles",
        regions: "/regions",
        "matching-rules": "/matching",
        "score-rules": "/score-rules",
      },
      d = await get(map[s.view]);
    out.innerHTML =
      title(
        labels[s.view],
        "Lesemodus; externe Schreibaktionen bleiben gesperrt",
      ) +
      table(
        s.view === "scheduler" ? d.sources : d.items || [],
        s.view === "scheduler"
          ? [
              "source_code",
              "enabled",
              "kill_switch",
              "last_run_status",
              "started_at",
              "next_run_at",
              "duration_seconds",
              "read_count",
              "successful_records",
              "failed_records",
              "queue_depth",
              "oldest_job",
              "retry_count",
              "worker_heartbeat",
            ]
          : [],
      );
  }
  const documentStatusLabel = (document) =>
      document.processing
        ? "Verarbeitung läuft"
        : document.failed
          ? "Abruf oder Analyse fehlgeschlagen"
          : !document.loaded
            ? "Noch nicht geladen"
            : !document.analyzed
              ? "Geladen, Analyse noch offen"
              : "Vollständig geladen und analysiert",
    documentScopeLabel = (document, lotKey) =>
      document.scope === "TENDER_GLOBAL"
        ? `Tenderweit · für ${lotKey || "den Gesamtkontext"} relevant`
        : `Gültig für ${document.scope}${document.multiLot ? " · belegtes Mehrlos-Dokument" : ""}`,
    documentAudit = (document) => {
      const entries = [
        ["Dokument-ID", document.id],
        ["Dokumenttyp", document.document_type],
        ["Abrufstatus", document.fetch_status],
        ["Auflösungsstatus", document.resolution_status],
        ["Beschaffungsprüfung", document.procurement_verification_status],
        ["Dokumentklasse", document.document_class],
        ["HTTP", document.http_status],
        ["MIME", document.mime_type],
        ["Parser", document.parser],
        ["Parser-Version", document.parser_version],
        ["SHA-256", document.payload_sha256],
        ["Abgerufen", document.retrieved_at],
        ["Quelladresse", document.source_url],
        ["Provenienz", document.provenance ? JSON.stringify(document.provenance) : null],
      ].filter(([, value]) => value !== null && value !== undefined && value !== "");
      return `<details class="technical-details document-audit"><summary>Technische Details und Audit</summary><dl>${entries.map(([label, value]) => `<dt>${esc(label)}</dt><dd><code>${esc(value)}</code></dd>`).join("")}</dl></details>`;
    },
    documentCard = (document, s) => {
      const link = document.downloadUrl
        ? `<a class="button-link" href="${esc(document.downloadUrl)}" target="_blank" rel="noopener">Öffnen / herunterladen</a>`
        : /^https:\/\//i.test(document.source_url || "")
          ? `<a class="button-link" href="${esc(document.source_url)}" target="_blank" rel="noopener noreferrer">Originalquelle öffnen</a>`
          : "";
      return `<article class="document-work-card${document.failed || !document.loaded || !document.analyzed ? " document-open" : ""}"><div><h4>${esc(document.filename || "Dokument ohne Dateinamen")}</h4><p><strong>${esc(documentStatusLabel(document))}</strong></p><p class="muted">${esc(documentScopeLabel(document, s.lot))}</p></div>${link ? `<div class="document-card-actions">${link}</div>` : ""}${documentAudit(document)}</article>`;
    };
  async function documentWorkbenchView(s, page = 1) {
    if (!s.tender) return contextRequired(s);
    const d = await get(`/tenders/${encodeURIComponent(s.tender)}/document-workbench?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}&page=${encodeURIComponent(page)}&pageSize=12`),
      complete = d.items.filter((document) => document.loaded && document.analyzed && !document.failed),
      open = d.items.filter((document) => document.failed || !document.loaded || !document.analyzed),
      overallLabels = {
        COMPLETE: "Alle sichtbaren Vergabeunterlagen sind vollständig verarbeitet",
        ACTION_REQUIRED: "Bei Vergabeunterlagen ist eine Aktion erforderlich",
        PROCESSING: "Vergabeunterlagen werden automatisch verarbeitet",
        NO_DOCUMENTS: "Noch keine relevanten Vergabeunterlagen verfügbar",
      },
      actionMarkup = d.actions.map((action) => {
        if (action.type === "PORTAL_ACCESS") {
          const portalUrl = `${href("portal-access", s)}${action.portalId ? `&portal=${encodeURIComponent(action.portalId)}` : ""}`;
          return `<article class="document-action"><h4>Portalzugang wiederherstellen</h4><dl><dt>Ursache</dt><dd>Der lesende Dokumentenzugriff benötigt eine gültige Anmeldung oder MFA-Bestätigung.</dd><dt>Auswirkung</dt><dd>Betroffene Vergabeunterlagen können erst danach automatisch geladen und analysiert werden.</dd></dl><a class="button-link primary-action" href="${esc(portalUrl)}">Portalzugang für dieses Portal öffnen</a></article>`;
        }
        if (action.type === "RETRY_FETCH")
          return `<article class="document-action"><h4>Dokumentenabruf erneut starten</h4><dl><dt>Ursache</dt><dd>Mindestens eine relevante Unterlage wurde nicht erfolgreich geladen.</dd><dt>Auswirkung</dt><dd>Analyse und Kalkulation bleiben für diesen Gesellschafts-/Loskontext unvollständig.</dd></dl><button type="button" data-document-pipeline="RETRY_FETCH">Abruf erneut starten</button></article>`;
        if (action.type === "START_ANALYSIS")
          return `<article class="document-action"><h4>Dokumentenanalyse starten</h4><dl><dt>Ursache</dt><dd>Mindestens eine geladene Unterlage ist noch nicht ausgewertet.</dd><dt>Auswirkung</dt><dd>Erkannte Anforderungen und Kalkulationsgrundlagen sind noch nicht vollständig.</dd></dl><button type="button" data-document-pipeline="START_ANALYSIS">Analyse starten</button></article>`;
        if (action.type === "REQUIRED_DOCUMENTS")
          return `<article class="document-action"><h4>${esc(action.count)} fehlende Unterlage${action.count === 1 ? "" : "n"} oder Formular${action.count === 1 ? "" : "e"} bearbeiten</h4><dl><dt>Ursache</dt><dd>Für diesen Tender-, Gesellschafts- und Loskontext sind Pflichtunterlagen noch offen.</dd><dt>Auswirkung</dt><dd>Das interne Angebotspaket bleibt bis zur fachlichen Bearbeitung unvollständig.</dd></dl><a class="button-link primary-action" href="${esc(href("detail", s))}#required-document-${esc(action.firstId)}">Fehlende Unterlagen bearbeiten</a></article>`;
        if (action.type === "CALCULATION")
          return `<article class="document-action"><h4>Kalkulation vervollständigen</h4><dl><dt>Ursache</dt><dd>${esc(action.reason || "Für die Kalkulation fehlen noch fachliche Eingaben.")}</dd><dt>Auswirkung</dt><dd>Die Kalkulation und die darauf aufbauende Managementausgabe sind noch nicht abschließbar.</dd></dl><a class="button-link primary-action" href="${esc(href("calculation", s))}">Kalkulation öffnen</a></article>`;
        return "";
      }).join(""),
      pagination = d.pagination.pages > 1
        ? `<nav class="document-pagination" aria-label="Dokumentseiten"><button type="button" data-document-page="${d.pagination.page - 1}" ${d.pagination.page <= 1 ? "disabled" : ""}>Zurück</button><span>Seite ${esc(d.pagination.page)} von ${esc(d.pagination.pages)} · insgesamt ${esc(d.pagination.total)}</span><button type="button" data-document-page="${d.pagination.page + 1}" ${d.pagination.page >= d.pagination.pages ? "disabled" : ""}>Weitere anzeigen</button></nav>`
        : "";
    out.innerHTML =
      `<nav aria-label="Breadcrumb"><a href="${esc(href("overview", s))}">Tender-Übersicht</a> → <a href="${esc(href("detail", s))}">Tender-Detail</a> → <span>Dokumentenanalyse</span></nav>` +
      title("Vergabeunterlagen", `${s.lot || "Gesamt"} · dokumentenscharfe Arbeitsansicht`) +
      `<section class="panel document-summary" aria-labelledby="document-overall-status"><div class="document-summary-grid"><article><strong>${esc(d.summary.total)}</strong><span>Gesamt</span></article><article><strong>${esc(d.summary.loaded)}</strong><span>Erfolgreich geladen</span></article><article><strong>${esc(d.summary.analyzed)}</strong><span>Analysiert</span></article><article><strong>${esc(d.summary.openOrFailed)}</strong><span>Offen / fehlerhaft</span></article></div><p id="document-overall-status" class="document-overall-status"><strong>${esc(overallLabels[d.summary.status] || "Dokumentenstatus wird geprüft")}${d.actions.length && d.summary.status === "COMPLETE" ? " · Im Folgeworkflow sind Aufgaben offen" : ""}</strong></p></section>` +
      `<section class="panel document-actions"><h3>Jetzt zu erledigen</h3>${d.actions.length ? `<div class="document-action-grid">${actionMarkup}</div>` : `<div class="document-no-action"><p><strong>Keine Aktion erforderlich</strong></p><p>Alle für ${esc(s.lot || "diesen Tender")} relevanten Vergabeunterlagen sind geladen und analysiert.</p>${d.nextWorkflow ? `<p>${esc(d.nextWorkflow.reason)}</p><a class="button-link primary-action" href="${esc(href(d.nextWorkflow.view, s))}">${esc(d.nextWorkflow.label)}</a>` : ""}</div>`}<p data-portal-status="document-workbench" aria-live="polite"></p></section>` +
      (open.length ? `<section class="panel"><h3>Offene oder fehlerhafte Dokumente</h3><div class="document-work-list">${open.map((document) => documentCard(document, s)).join("")}</div></section>` : "") +
      `<section class="panel document-complete"><details><summary>${esc(d.summary.total - d.summary.openOrFailed)} erfolgreich verarbeitete Dokumente${d.pagination.pages > 1 ? ` · Seite ${esc(d.pagination.page)} von ${esc(d.pagination.pages)}` : ""} anzeigen</summary><div class="document-work-list">${complete.map((document) => documentCard(document, s)).join("") || "<p>Auf dieser Seite liegen keine vollständig verarbeiteten Dokumente.</p>"}</div></details>${pagination}</section>`;
    out.querySelectorAll("[data-document-page]").forEach((button) => button.onclick = () => documentWorkbenchView(s, Number(button.dataset.documentPage)));
    out.querySelectorAll("[data-document-pipeline]").forEach((button) => button.onclick = async () => {
      const status = out.querySelector("[data-portal-status='document-workbench']");
      button.disabled = true;
      status.textContent = "Der interne Dokumentenworkflow wird gestartet …";
      try {
        const job = await mutate(`/management-inbox/autopilot/${encodeURIComponent(s.tender)}/jobs`, "POST", { action_type: "RUN_FULL_PIPELINE", company_id: s.company, lot_key: s.lot || null });
        status.dataset.jobId = job.job_id;
        status.textContent = `Interner Job ${job.job_id} wurde gestartet. Keine Portalübermittlung.`;
        localStorage.setItem(`wb-tender-job:${job.job_id}`, JSON.stringify({ tenderId: s.tender, companyId: s.company, lotKey: s.lot, portalId: d.portalId }));
        trackJob(job.job_id);
      } catch (error) {
        button.disabled = false;
        status.textContent = `Aktion nicht gestartet: ${error.message}`;
      }
    });
  }
  async function contextView(s) {
    if (!s.tender) return contextRequired(s);
    if (s.view === "management-output") {
      const [data,finalData] = await Promise.all([get(
        `/tenders/${encodeURIComponent(s.tender)}/management-output?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`,
      ),get(`/final-preflight/contexts?tenderId=${encodeURIComponent(s.tender)}`)]),finalContext=finalData.items.find(x=>String(x.company_id)===String(s.company)&&String(x.lot_key||"")===String(s.lot||"")),openRequirements=(finalContext?.requirements||[]).filter(x=>!["VALIDATED","NOT_REQUIRED"].includes(x.status));
      out.innerHTML =
        title(
          labels[s.view],
          "Automatisch erzeugte aktuelle Managemententscheidung mit Kalkulation, Risiken, Kapazität, Nachweisen und Provenance",
        ) +
        section("Executive Summary", data.executiveSummary) +
        section("Managementempfehlung", data.recommendation) +
        section("Kalkulation", data.calculation) +
        section("Personal und operative Umsetzung", data.personnel) +
        section("Risiken", data.risks) +
        section("Kapazität", data.capacity) +
        section("Zuschlagschance", data.awardChance) +
        section("Nachweise", data.evidence) +
        section("Nächste Schritte", data.nextSteps) +
        section("Provenance und Audit", data.provenance)+`<section class="panel required-documents-panel"><h3>Vor finaler Angebotsabgabe noch erforderlich</h3><p>${finalContext?`Tenderindividuelle Prüfung: ${esc(humanizedEnum(finalContext.readiness_status))}.`:"Die tenderindividuelle Prüfung ist noch nicht abgeschlossen."}</p><div class="presentation-grid">${openRequirements.map(x=>`<article class="presentation-card"><h4>${esc(x.title)}</h4><dl><dt>Bereich</dt><dd>${esc(humanizedEnum(x.group))}</dd><dt>Status</dt><dd>${esc(humanizedEnum(x.status))}</dd><dt>Quelle</dt><dd>${esc(x.source)}${x.page?`, Seite ${esc(x.page)}`:""}</dd><dt>Aktion</dt><dd>${x.humanActionRequired?"Benutzeraktion erforderlich":"Autopilot bearbeitet den technischen Schritt"}</dd><dt>Blockiert Abgabe</dt><dd>Ja</dd></dl></article>`).join("")||"<p>Keine offenen Einzelanforderungen erkannt.</p>"}</div></section>`;
      return;
    }
    const d = await context(s),
      r = d.result || {},
      review = r.review || {},
      stage = r.stage_status || {};
    if (s.view === "detail" && d.noticeLifecycle) {
      const life = d.noticeLifecycle,
        original = life.original,
        originalLink = original
          ? `<a class="button-link primary-action" href="${esc(href("detail", { ...s, tender: original.tenderId, lot: "" }))}">Zugehörige ursprüngliche Ausschreibung öffnen</a>`
          : "";
      out.innerHTML =
        `<nav aria-label="Breadcrumb"><a href="${esc(href("overview", s))}">Tender-Übersicht</a> → <span>${esc(d.tender.title)}</span></nav>` +
        title(
          "Verfahren abgeschlossen",
          `${d.tender.title} · ${d.company.legal_name} · ${d.selected.lotKey || "Gesamt"}`,
        ) +
        section("Verfahrensstatus", {
          Status: life.statusLabel,
          Typ: life.noticeTypeLabel,
          Ergebnis: life.resultLabel,
          Angebot: life.offerLabel,
          Kalkulation: life.calculationLabel,
          Portalzugriff: life.portalAccessLabel,
          Dokumentenstatus: life.documentStatusLabel,
          Managementfreigabe: "Nicht erforderlich",
          Teilnahme: "Nicht erforderlich",
          Submission: "Nicht erforderlich",
          Monitoring: life.monitoringLabel,
          Zuschlagsdatum: life.awardDate || "Nicht verfügbar",
        }) +
        `<section class="panel"><h3>Ursprüngliches Vergabeverfahren</h3>${original ? `<p>Autoritativ über dieselbe Procedure-ID verknüpft: ${esc(original.noticeId || original.title)}.</p>${originalLink}` : "<p>Im Autopiloten ist keine über dieselbe Procedure-ID autoritativ verknüpfbare ursprüngliche Ausschreibung vorhanden.</p>"}</section>`;
      return;
    }
    const map = {
      detail: [
        {
          Kalkulationsstatus:
            stage.calculation ||
            review.calculation?.status ||
            "TECHNICAL_STATUS_ERROR",
          Szenariokalkulation: d.scenarioAvailable
            ? trustedMarkup(
                `<strong>Szenariokalkulation verfügbar</strong><br><a class="button-link" href="${esc(href("scenarios", s))}">Szenarien öffnen</a>`,
              )
            : "Keine Szenariokalkulation",
        },
        d.tender,
        d.documentPortal || { Dokumentenportal: "Noch nicht geprüft" },
        {
          Ausgewählte_Gesellschaft: d.company.legal_name,
          Ausgewähltes_Los: d.selected.lotKey || "Gesamt",
          Bewertungsversion: d.selected.resultVersion,
          Anreicherungsversion: d.enrichment?.version,
        },
      ],
      versions: [
        ...d.versions,
        ...(d.enrichment ? [{ Typ: "Anreicherung", ...d.enrichment }] : []),
        ...(d.result
          ? [
              {
                Typ: "Bewertung",
                result_version: d.result.result_version,
                pipeline_version: d.result.pipeline_version,
                created_at: d.result.created_at,
              },
            ]
          : []),
      ],
      matching:
        review.matching ||
        review.serviceAndCpvMatching ||
        stage.MATCHING ||
        stage.matching ||
        [],
      "hard-gates":
        review.hardGates ||
        review.gates ||
        stage.HARD_GATES ||
        stage.hardGates ||
        [],
      "pre-go-no-go":
        review.recommendation || review.finalRecommendation || review,
      documents: d.documents,
      requirements: d.requirements,
      evidence:
        review.evidence ||
        review.eligibility ||
        d.requirements.filter((x) =>
          String(x.category).match(/nachweis|eignung|zertifikat|versicherung/i),
        ),
      tasks: d.tasks.length ? d.tasks : r.prepared_tasks || [],
      calculation: d.calculations.length
        ? d.calculations
        : review.calculation || {
            Status: "KALKULATION_NOCH_NICHT_MÖGLICH",
            Fehlende_Grundlagen: review.missingCalculationInputs || [],
          },
      scenarios: d.calculations,
      "board-brief": r.board_brief || review.boardBrief || {},
      "offer-documents": d.offerDocuments,
      approvals: d.approvals,
      audit: d.audit,
    };
    const offerDocumentsSection = d.bidPackage
      ? `<section class="panel offer-package"><h3>Kanonisches Bid Package</h3>${calcFacts(
          [
            ["Paketstatus", calcStatus(d.bidPackage.status)],
            ["Paketversion", d.bidPackage.version],
            ["Manifest-Hash", d.bidPackage.manifest_sha256],
            ["Dokumentenrevision", d.bidPackage.document_revision_sha256],
            ["Kalkulationsversion", d.bidPackage.calculation_version],
          ],
        )}<h3>Angebotsdokumente</h3>${calcTable(
          ["Dokumentart", "Status", "Format", "Hash", "Version", "Hinweis"],
          d.offerDocumentChecklist.map((x) => [
            esc(x.label),
            esc(
              x.status === "NOT_GENERATED"
                ? "Noch nicht erzeugt"
                : calcStatus(x.status),
            ),
            esc(x.format || "Nicht verfügbar"),
            esc(x.hash || "Nicht verfügbar"),
            esc(x.version ?? "Nicht verfügbar"),
            esc(x.reason || "Im Bid Package vorhanden"),
          ]),
        )}</section>`
      : section("Angebotsunterlagen", d.offerDocuments);
    out.innerHTML =
      `<nav aria-label="Breadcrumb"><a href="${esc(href("overview", s))}">Tender-Übersicht</a> → <a href="${esc(href("detail", s))}">${esc(d.tender.title)}</a> → <span>${esc(labels[s.view])}</span></nav>` +
      title(
        labels[s.view],
        `${d.tender.title} · ${d.company.legal_name} · ${d.selected.lotKey || "Gesamt"}`,
      ) +
      section("Ausgewählter Kontext", d.selected) +
      (s.view === "detail"
        ? section("Dokumentenportal und Pipeline", d.documentPortal)
        : "") +
      (s.view === "offer-documents"
        ? offerDocumentsSection
        : section(labels[s.view], map[s.view]));
    if (s.view === "detail") {
      const [portals, eligibility] = await Promise.all([
        get(`/portal-access/for-tender/${encodeURIComponent(s.tender)}?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`),
        get(
          `/tenders/${encodeURIComponent(s.tender)}/portal-company-eligibility?company=${encodeURIComponent(s.company)}`,
        ),
      ]);
      out.insertAdjacentHTML(
        "beforeend",
        `<section class="panel portal-eligibility"><h3>Portalzugang für die geplante Bietergesellschaft</h3><dl><dt>Portal</dt><dd>${esc(eligibility.portal_name || "Noch nicht zugeordnet")}</dd><dt>Geplante Bietergesellschaft</dt><dd>${esc(eligibility.company_name || d.company.legal_name)}</dd><dt>Portalaccount</dt><dd>${esc(eligibility.account_holder_name || "Nicht autoritativ bestätigt")}</dd><dt>Submissionstatus</dt><dd><strong>${esc(eligibility.status_label)}</strong></dd><dt>Empfehlung</dt><dd>${esc(eligibility.recommendation || "Portalidentität rechtzeitig vor der Angebotsabgabe prüfen.")}</dd></dl><p class="muted">Analyse, Dokumentdownload, Kalkulation und Management bleiben unabhängig von diesem Submissionstatus möglich.</p></section>`,
      );
      if (portals.items.length) {
        out.insertAdjacentHTML(
          "beforeend",
          `<section class="panel"><h3>Detailunterlagen und Portalzugang</h3>${portals.items
            .map((p) => {
              const approval =
                p.access_status === "EXTERNAL_DOCUMENT_REQUEST_REQUIRED" &&
                p.request_effect === "BIDDER_LIST_REGISTRATION_POSSIBLE" &&
                !p.global_document_request_approval;
              const manageUrl = `${href("portal-access", s)}&portal=${encodeURIComponent(p.portal_id)}&tender=${encodeURIComponent(s.tender)}`,
                action = p.login_action,
                actionType = action?.type || "NONE",
                actionLabel = action?.label || "",
                binding = action?.binding,
                primaryAction = actionType === "MANAGE_CREDENTIALS" && binding ? `<a class="button-link primary-action" data-login-manage="${esc(binding.portal_id)}" href="${esc(manageUrl)}">${esc(actionLabel)}</a>` : actionType === "OPEN_PORTAL_READ_ONLY" && binding && p.portal_open_url ? `<a class="button-link primary-action" data-portal-open="${esc(binding.portal_id)}" href="${esc(p.portal_open_url)}" target="_blank" rel="noopener noreferrer">${esc(actionLabel)}</a>` : actionType === "AUTHENTICATION_TARGET_UNAVAILABLE" && binding ? `<button type="button" disabled aria-disabled="true" data-login-unavailable="${esc(binding.portal_id)}">Portal-Login nicht konfiguriert</button>` : ["START_LOGIN", "CONFIRM_MFA"].includes(actionType) && binding ? `<button type="button" class="primary-action" data-login-portal="${esc(binding.portal_id)}" data-tender="${esc(binding.tender_id)}" data-company="${esc(binding.company_id)}" data-lot="${esc(binding.lot_key)}">${esc(actionLabel)}</button>` : "",
                refresh = p.document_refresh_action,
                refreshBinding = refresh?.binding,
                refreshAction = refresh?.type === "REFRESH_DOCUMENTS" && refreshBinding ? `<button type="button" data-portal-document-refresh="${esc(refreshBinding.portal_id)}" data-tender="${esc(refreshBinding.tender_id)}" data-company="${esc(refreshBinding.company_id)}" data-lot="${esc(refreshBinding.lot_key)}">${esc(refresh.label || "Dokumente aktualisieren")}</button>` : "",
                sessionUsable = ["NONE", "OPEN_PORTAL_READ_ONLY"].includes(actionType);
              return `<article data-portal-card="${esc(p.portal_id)}"><dl><dt>Bekanntmachungsquelle</dt><dd>${esc(p.notice_source || d.tender.source_code)}</dd><dt>Zielportal</dt><dd><strong>${esc(p.portal_name)}</strong> · ${esc(p.domain)}</dd><dt>Status</dt><dd>${esc(p.automatic_processing && !primaryAction ? "Automatische Verarbeitung läuft" : p.access_status)}</dd><dt>Globale Freigabe</dt><dd>${esc(p.global_policy_label || "Nicht aktiv")}</dd><dt>Kostenprüfung</dt><dd>${esc(p.cost_check_status || "AUSSTEHEND")}</dd><dt>Kostenklasse</dt><dd><strong>${esc(p.cost_class || "Nicht klassifiziert")}</strong></dd><dt>Nachgewiesener Betrag</dt><dd>${esc(p.proven_amount ?? "–")} ${esc(p.cost_currency || "")}</dd><dt>Nachweisquelle</dt><dd>${esc((p.evidence_source || []).join(", ") || "–")}</dd><dt>Dokumentenanforderung</dt><dd>${esc(p.document_request_status || "–")}</dd><dt>Bieter-/Interessentenliste</dt><dd>${esc([p.bidder_list_status, p.interest_list_status].filter(Boolean).join(" / ") || "–")}</dd><dt>Portalnachrichten</dt><dd>${esc(p.message_status || "–")}</dd><dt>Ursache</dt><dd>${esc(p.login_required_reason)}</dd><dt>Letzter Abruf</dt><dd>${esc(calcDate(p.last_attempt))}</dd><dt>Nächster automatischer Versuch</dt><dd>${esc(p.next_retry ? calcDate(p.next_retry) : p.automatic_processing ? "läuft bereits" : "nicht erforderlich")}</dd><dt>Aktueller Verarbeitungsschritt</dt><dd>${esc(p.current_processing_step || "Kein aktiver Job")}</dd><dt>Letzter Fehler</dt><dd>${esc(p.last_error || "–")}</dd></dl><h4>Betroffene Dokumente</h4>${portalDocumentList(p.affected_document_items)}<p>Fehlende Kalkulationswerte: ${esc((p.missing_calculation_inputs || []).map((x) => x.field || x).join(", ") || "keine")}</p><div class="review-actions">${approval ? `<button type="button" disabled aria-disabled="true">Freigabe für Dokumentenanforderung erforderlich</button>` : primaryAction || (p.automatic_processing ? `<button type="button" disabled>Automatische Verarbeitung läuft</button>` : "")}${refreshAction}<a class="button-link" href="${esc(manageUrl)}">Portalzugang verwalten</a>${p.notice_url ? `<a href="${esc(p.notice_url)}" target="_blank" rel="noopener noreferrer">Öffentliche Bekanntmachung öffnen</a>` : ""}</div><p class="muted" data-login-status="${esc(p.portal_id)}" aria-live="polite">${approval ? "Keine externe Aktion ohne ausdrückliche tenderbezogene Freigabe." : actionType === "START_LOGIN" ? "Die gespeicherte Portalsitzung konnte nicht sicher wiederhergestellt werden. Erneut anmelden; erst danach wird automatisch fortgesetzt." : actionType === "CONFIRM_MFA" ? "MFA-Bestätigung erforderlich; erst danach wird automatisch fortgesetzt." : actionType === "AUTHENTICATION_TARGET_UNAVAILABLE" ? "Für dieses Portal ist kein autoritatives Login- oder Bieterbereichsziel konfiguriert." : actionType === "OPEN_PORTAL_READ_ONLY" && p.documents_complete ? "Alle erforderlichen Vergabeunterlagen sind vollständig geladen und analysiert; keine Anmeldung ist erforderlich." : p.automatic_processing ? "Die unabhängig bestätigte Portalsitzung ist gültig; die Verarbeitung wird fortgesetzt." : sessionUsable ? "Das Portal kann schreibgeschützt geöffnet werden." : "Für dieses Portal ist noch kein Zugang eingerichtet."}</p></article>`;
            })
            .join("")}</section>`,
        );
      }
      await appendRequiredDocuments(s);
      const decision = await get(
          `/tenders/${encodeURIComponent(s.tender)}/bid-decision-context?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot)}`,
        ),
        blockers = (decision.submissionGate?.reasons || []).map(
          (x) => x.detail,
        );
      out.insertAdjacentHTML(
        "beforeend",
        `<section class="panel" data-bid-decision><h3>${decision.eligibleForDecision ? "ANGEBOTSENTSCHEIDUNG ERFORDERLICH" : "Angebotsentscheidung noch nicht zulässig"}</h3><p>${esc(decision.eligibleForDecision ? "Die reale Kalkulation, Managementausgabe und Dokumentrevision sind vollständig gebunden." : blockers.join(" ") || "Die fachlichen Voraussetzungen fehlen.")}</p><div class="review-actions"><a class="button-link" href="${esc(href("calculation", s))}">Kalkulation öffnen</a><a class="button-link" href="${esc(href("management-output", s))}">Managementausgabe öffnen</a><a class="button-link" href="${esc(href("documents", s))}">Vergabeunterlagen öffnen</a>${decision.eligibleForDecision ? `<button type="button" data-bid-approve>Kalkulation und Angebot freigeben</button><button type="button" data-bid-revise>Änderung anfordern</button><button type="button" data-bid-reject>Kalkulation und Ausschreibung ablehnen</button>` : ""}</div><p class="muted" data-bid-status aria-live="polite">Externe Teilnahme und Angebotsabgabe bleiben bis zum separaten Submission-Gate gesperrt.</p></section>`,
      );
      const decide = async (action) => {
        const status = document.querySelector("[data-bid-status]"),
          reason =
            action === "APPROVE"
              ? ""
              : prompt(
                  action === "REVISION_REQUESTED"
                    ? "Gewünschte Änderung (Pflichtfeld)"
                    : "Ablehnungsgrund (Pflichtfeld)",
                ) || "";
        if (action !== "APPROVE" && !reason) return;
        const confirmation =
          action === "APPROVE"
            ? prompt(
                "Bitte den angezeigten verbindlichen Bestätigungssatz vollständig eingeben:",
              )
            : null;
        try {
          const result = await mutate(
            `/tenders/${encodeURIComponent(s.tender)}/bid-decision`,
            "POST",
            {
              action,
              reason,
              confirmation,
              companyId: s.company,
              lotKey: s.lot || null,
            },
          );
          status.textContent = `Entscheidung ${result.status} revisionssicher gespeichert. Keine externe Aktion wurde ausgeführt.`;
        } catch (error) {
          status.textContent = `Entscheidung nicht gespeichert: ${error.message}`;
        }
      };
      document
        .querySelector("[data-bid-approve]")
        ?.addEventListener("click", () => decide("APPROVE"));
      document
        .querySelector("[data-bid-revise]")
        ?.addEventListener("click", () => decide("REVISION_REQUESTED"));
      document
        .querySelector("[data-bid-reject]")
        ?.addEventListener("click", () => decide("REJECT"));
    }
  }
  const submissionBlockerAction = (action, s) => {
    const contextQuery = `company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot || "")}`;
    if (action.type === "source-open" || action.type === "source-download") {
      if (!action.requiredDocumentId || !action.documentId) return "";
      const base = `${API}/tenders/${encodeURIComponent(s.tender)}/required-documents/${encodeURIComponent(action.requiredDocumentId)}/source`,
        download = action.type === "source-download" ? "/download" : "",
        page = action.type === "source-open" && action.mimeType === "application/pdf" && action.page ? `#page=${encodeURIComponent(action.page)}` : "";
      return `<a class="button-link" data-blocker-action="${esc(action.type)}" data-document-id="${esc(action.documentId)}" href="${esc(`${base}${download}?${contextQuery}${page}`)}"${action.type === "source-open" ? ' target="_blank" rel="noopener"' : ""}>${esc(action.label)}</a>`;
    }
    if (action.type === "required-document") {
      const target = href("management-output", s) + (action.requiredDocumentId ? `#required-document-${encodeURIComponent(action.requiredDocumentId)}` : "#required-documents");
      return `<a class="button-link" data-blocker-action="required-document" href="${esc(target)}">${esc(action.label)}</a>`;
    }
    if (action.type === "view" && views.some(([view]) => view === action.view)) {
      let target = href(action.view, s) + (action.view === "submission-status" ? "#run-submission-preflight" : "");
      if (action.view === "portal-access" && action.portalScope) {
        const scoped = new URL(href("portal-access", s), location.origin);
        [["portal", action.portalScope.portalId], ["credential", action.portalScope.credentialId], ["company", action.portalScope.companyId], ["tender", action.portalScope.tenderId], ["lot", action.portalScope.lotKey]].forEach(([key, value]) => scoped.searchParams.set(key, value || ""));
        scoped.searchParams.set("focus", action.focus || "permissions");
        target = scoped.pathname + scoped.search + `#${action.focus === "adapter" ? "adapter-configuration" : "account-send-rights"}`;
      }
      return `<a class="button-link" data-blocker-action="view" data-blocker-view="${esc(action.view)}" href="${esc(target)}">${esc(action.label)}</a>`;
    }
    return "";
  };
  const submissionBlockerItem = (blocker, s) => {
    const message = blocker?.message || "Prüfung nicht bestanden",
      actions = (Array.isArray(blocker?.actions) ? blocker.actions : []).map((action) => submissionBlockerAction(action, s)).filter(Boolean).join("");
    return `<li class="submission-blocker"><p>${esc(message)}</p>${actions ? `<div class="review-actions" aria-label="Aktionen für diesen Blocker">${actions}</div>` : '<p class="muted">Keine sichere interne Bearbeitungsaktion ist für diesen Blocker verfügbar.</p>'}</li>`;
  };
  async function submissionStatusView(s) {
    if (!s.tender || !s.company) return contextRequired(s);
    const response = await get(
      `/tenders/${encodeURIComponent(s.tender)}/submission-context?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot || "")}`,
    ), preparation = response.preparation || { ready: false, prerequisites: [] };
    let context = response.exists === false ? null : response;
    if (!context) {
      const missing = (preparation.prerequisites || []).filter((item) => !item.satisfied),
        prerequisite = (item) => {
          const target = href(item.action?.view || "detail", s) + (item.action?.anchor ? `#${encodeURIComponent(item.action.anchor)}` : "");
          return `<li class="submission-blocker"><p><strong>${esc(item.label)}</strong></p><p>${esc(item.reason)}</p><div class="review-actions"><a class="button-link" href="${esc(target)}">${esc(item.action?.label || "Intern bearbeiten")}</a></div></li>`;
        };
      out.innerHTML =
        title(
          "Abgabestatus",
          "Die interne Vorbereitung der Angebotsabgabe wurde noch nicht angelegt.",
        ) +
        `<section class="panel internal-preparation"><h3>Was wird intern vorbereitet?</h3><p>${esc(preparation.explanation || "Es wird ein interner Vorbereitungsdatensatz aus der aktuellen Managementfreigabe und dem validierten Angebotspaket erstellt.")}</p><p class="notice"><strong>Keine Portalübertragung:</strong> ${esc(preparation.confirmation || "Es erfolgt keine Übertragung an ein Vergabeportal.")}</p>${missing.length ? `<h3>Vorher noch erforderlich</h3><ul class="submission-blocker-list">${missing.map(prerequisite).join("")}</ul>` : `<p><strong>Alle internen Voraussetzungen sind erfüllt.</strong></p>`}<div class="review-actions"><button type="button" id="create-submission-context" ${preparation.ready ? "" : "disabled aria-disabled=\"true\""}>${esc(preparation.label || "Angebotsabgabe intern vorbereiten")}</button></div><p id="submission-action-status" aria-live="polite">${preparation.ready ? "Bereit. Mit dem nächsten Schritt wird nur der interne Vorbereitungsdatensatz angelegt; es erfolgt keine Portalübertragung." : "Die interne Vorbereitung bleibt deaktiviert, bis alle oben genannten Voraussetzungen erfüllt sind."}</p></section>`;
      const create = document.querySelector("#create-submission-context");
      if (preparation.ready) create.onclick = async () => {
          const status = document.querySelector("#submission-action-status");
          try {
            await mutate(
              `/tenders/${encodeURIComponent(s.tender)}/submission-context`,
              "POST",
              { companyId: s.company, lotKey: s.lot || "" },
            );
            status.textContent = "Interne Vorbereitung angelegt. Es wurde nichts an ein Portal übertragen.";
            await submissionStatusView(s);
          } catch (error) {
            status.textContent = error.message;
          }
        };
      return;
    }
    const [feedback,releases] = await Promise.all([
      get(`/tenders/${encodeURIComponent(s.tender)}/submission-feedback?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot || "")}`),
      get(`/tenders/${encodeURIComponent(s.tender)}/binding-action-releases?company=${encodeURIComponent(s.company)}&lot=${encodeURIComponent(s.lot || "")}`),
    ]), feedbackLabels={RECEIPT:"Empfangsbeleg",STATUS:"Portalstatus",MESSAGE:"Portalnachricht",AMENDMENT:"Nachtrag",DEADLINE_CHANGE:"Friständerung",AWARD:"Zuschlag",REJECTION:"Absage",CANCELLATION:"Aufhebung"},
      feedbackTimeline=(feedback.items||[]).map(item=>{const display=item.display||{},details=[display.title,display.summary,display.statusLabel&&`Status: ${display.statusLabel}`,display.reference&&`Referenz: ${display.reference}`,display.dueAt&&`Termin: ${calcDate(display.dueAt)}`].filter(Boolean);return `<li><strong>${esc(display.label||feedbackLabels[item.event_type]||"Portalereignis")}</strong><span>${esc(calcDate(item.observed_at))}</span>${details.length?`<p>${details.map(esc).join(" · ")}</p>`:""}<small>${esc(item.source_mode==="ACCEPTANCE_SANDBOX"?"Nur isolierte Acceptance-Simulation":"Read-only eingelesen")}</small></li>`}).join("");
    const blockers =
        context.latestPreflight?.blockers || context.blockers || [],
      sessionValid = context.portal_session_effective_status === "ACTIVE",
      steps = [
        [
          "Managementfreigabe",
          context.management_approval_valid === true
            ? "Freigegeben"
            : context.management_approval_status === "APPROVED"
              ? "Erneute Freigabe erforderlich"
              : "Ausstehend",
        ],
        [
          "Bid Package",
          context.bid_package_status === "BID_PACKAGE_READY_FOR_SUBMISSION"
            ? "Vollständig"
            : "Nicht vollständig",
        ],
        [
          "Portalaccount",
          context.portal_account_present
            ? "Vorhanden"
            : "Registrierung erforderlich",
        ],
        ["Session", sessionValid ? "Gültig" : "Nicht gültig"],
        ["MFA", context.mfa_required ? "Erforderlich" : "Nicht erforderlich"],
        [
          "Teilnahme",
          context.submission_status === "SUBMISSION_AREA_READY"
            ? "Bestätigt"
            : "Noch nicht geprüft",
        ],
        [
          "Upload",
          context.mappings?.some((item) => item.upload_status === "UPLOADED")
            ? "Vorhanden"
            : "Nicht gestartet",
        ],
        [
          "Portalvalidierung",
          context.portal_validation_status === "PASSED"
            ? "Bestanden"
            : "Nicht durchgeführt",
        ],
        [
          "Preflight",
          context.preflight_status === "PREFLIGHT_PASSED"
            ? "Bestanden"
            : context.preflight_status === "PREFLIGHT_BLOCKED"
              ? "Blockiert"
              : "Nicht durchgeführt",
        ],
        [
          "Finale Freigabe",
          context.final_approval_status === "APPROVED"
            ? "Freigegeben"
            : "Ausstehend",
        ],
        ["Submission", context.transmitted ? "Übermittelt" : "Nicht erfolgt"],
        [
          "Receipt",
          context.receipt_verified_at ? "Verifiziert" : "Nicht vorhanden",
        ],
      ];
    const releaseLabels={REQUESTED:"Zweite Managementfreigabe ausstehend",APPROVED:"Intern final freigegeben",REVOKED:"Widerrufen",EXPIRED:"Abgelaufen",INVALIDATED:"Durch Kontextänderung ungültig"},
      releaseItems=(releases.items||[]).map(item=>`<article class="submission-release-card" data-release-id="${esc(item.id)}"><h4>${esc(releaseLabels[item.status]||item.status)}</h4><dl><dt>Gesellschaft / Los</dt><dd>${esc(item.scope.companyId)} / ${esc(item.scope.lotKey||"Gesamt")}</dd><dt>Portalzugang</dt><dd>${esc(item.scope.credentialId)}</dd><dt>Paketstand</dt><dd><code>${esc(item.scope.bidPackageHash)}</code></dd><dt>Ablauf</dt><dd>${esc(calcDate(item.expiresAt))}</dd></dl><p>${item.status==="REQUESTED"?"Eine andere managementberechtigte Person muss exakt diesen Paketstand bestätigen.":item.status==="APPROVED"?"Diese Freigabe gilt nur für die interne Finalisierung. Eine Portalübertragung bleibt gesperrt.":"Diese Freigabe ist nicht mehr wirksam."}</p><div class="review-actions">${item.status==="REQUESTED"?`<button type="button" data-approve-binding-release="${esc(item.id)}" data-binding-hash="${esc(item.bindingSha256)}">Als zweite Person intern freigeben</button>`:""}${["REQUESTED","APPROVED"].includes(item.status)?`<button type="button" data-revoke-binding-release="${esc(item.id)}">Freigabe widerrufen</button>`:""}</div></article>`).join("");
    out.innerHTML =
      title(
        "Abgabestatus",
        `${context.portal_name} · Los ${context.lot_key || "Gesamt"}`,
      ) +
      `<section class="panel submission-status-grid">${steps.map(([label, status]) => `<article><strong>${esc(label)}</strong><span>${esc(status)}</span></article>`).join("")}</section><section class="panel submission-blockers-panel"><p class="notice"><strong>Nur interne Vorbereitung:</strong> Dieser Datensatz löst keine Portalübertragung aus. Externe Abgabe bleibt gesperrt; transmitted=false.</p><h3>Konkrete Blocker</h3>${blockers.length ? `<ul class="submission-blocker-list">${blockers.map((blocker) => submissionBlockerItem(blocker, s)).join("")}</ul>` : "<p>Keine Blocker festgestellt.</p>"}<h3>Nächste Aktion</h3><p>${context.submission_autopilot_supported ? "Produktiven Portal-Preflight ausführen." : "Submission-Adapter und schreibberechtigtes Bieterkonto produktiv validieren."}</p><div class="review-actions"><button type="button" id="run-submission-preflight">Preflight erneut prüfen</button><button type="button" id="freeze-package-manifest">Paketstand unveränderlich sichern</button><button type="button" id="request-binding-release" ${(feedback.manifests||[]).length&&context.credential_id?"":"disabled aria-disabled=\"true\""}>Interne finale Freigabe anfordern</button><label class="reconciliation-kind">Lesender Rückkanal<select id="reconciliation-job-kind"><option value="READ_ONLY_STATUS_POLL">Status</option><option value="RECEIPT_RECONCILIATION">Empfangsbeleg</option><option value="MESSAGE_POLL">Nachrichten</option><option value="AMENDMENT_POLL">Nachträge</option><option value="DEADLINE_POLL">Fristen</option><option value="OUTCOME_POLL">Zuschlag / Absage / Aufhebung</option></select></label><button type="button" id="poll-portal-status">Read-only Prüfung vormerken</button><button type="button" disabled>Jetzt verbindlich an Vergabeportal übermitteln</button></div><p id="submission-action-status" aria-live="polite">Eine externe Übermittlung ist nicht freigegeben.</p></section><section class="panel binding-release-panel"><h3>Exakt gebundene Vier-Augen-Freigaben</h3><p>Jede Freigabe gilt nur für Gesellschaft, Portalzugang, Tender, Los und den angezeigten Paket-Hash und läuft automatisch ab. Sie hebt die HTTP-423-Sperre nicht auf.</p>${releaseItems||"<p>Noch keine interne finale Freigabe angefordert.</p>"}</section><section class="panel portal-feedback"><h3>Portal-Rückkanal und Historie</h3>${feedbackTimeline?`<ol class="portal-feedback-list">${feedbackTimeline}</ol>`:"<p>Noch keine verifizierten eingehenden Portalereignisse vorhanden.</p>"}<p class="muted">Nachrichten, Nachträge, Friständerungen, Empfangsbelege und Entscheidungen werden hier nur read-only oder als ausdrücklich markierte Acceptance-Simulation geführt.</p></section><details class="technical-details"><summary>Technische Details und Audit</summary><dl><dt>Interne Vorbereitungs-ID</dt><dd><code>${esc(context.id)}</code></dd><dt>Audit</dt><dd><code>${esc(context.audit_id)}</code></dd><dt>Binding</dt><dd><code>${esc(context.binding_sha256)}</code></dd>${(feedback.manifests||[]).length?`<dt>Unveränderliches Paketmanifest</dt><dd><code>${esc(feedback.manifests[0].manifest_sha256)}</code></dd>`:""}</dl></details>`;
    document.querySelector("#run-submission-preflight").onclick = async () => {
      const status = document.querySelector("#submission-action-status");
      try {
        const result = await mutate(
          `/tenders/${encodeURIComponent(s.tender)}/submission-preflight`,
          "POST",
          { companyId: s.company, lotKey: s.lot || "" },
        );
        status.textContent =
          result.status === "PREFLIGHT_PASSED"
            ? "Preflight bestanden."
            : "Preflight geprüft: konkrete Blocker sind weiterhin vorhanden.";
        await submissionStatusView(s);
      } catch (error) {
        status.textContent = error.message;
      }
    };
    document.querySelector("#freeze-package-manifest").onclick=async()=>{
      const status=document.querySelector("#submission-action-status");
      try{const result=await mutate(`/tenders/${encodeURIComponent(s.tender)}/submission-package-manifest`,"POST",{companyId:s.company,lotKey:s.lot||""});status.textContent=`Paketstand ${result.idempotent?"war bereits":"wurde"} unveränderlich und hashgebunden gesichert. Es wurde nichts übertragen.`;await submissionStatusView(s)}catch(error){status.textContent=error.message}
    };
    document.querySelector("#request-binding-release").onclick=async()=>{
      const status=document.querySelector("#submission-action-status");
      try{await mutate(`/tenders/${encodeURIComponent(s.tender)}/binding-action-releases`,"POST",{companyId:s.company,lotKey:s.lot||"",expiresAt:new Date(Date.now()+30*60*1000).toISOString()});status.textContent="Interne finale Freigabe für exakt diesen Paketstand angefordert. Eine andere managementberechtigte Person muss bestätigen; es wurde nichts übertragen.";await submissionStatusView(s)}catch(error){status.textContent=error.message}
    };
    document.querySelectorAll("[data-approve-binding-release]").forEach(button=>button.onclick=async()=>{const status=document.querySelector("#submission-action-status");try{await mutate(`/tenders/${encodeURIComponent(s.tender)}/binding-action-releases/${encodeURIComponent(button.dataset.approveBindingRelease)}/approve`,"POST",{bindingSha256:button.dataset.bindingHash});status.textContent="Vier-Augen-Freigabe für diesen Paketstand gespeichert. Die externe Übertragung bleibt gesperrt.";await submissionStatusView(s)}catch(error){status.textContent=error.message}});
    document.querySelectorAll("[data-revoke-binding-release]").forEach(button=>button.onclick=async()=>{const status=document.querySelector("#submission-action-status");try{await mutate(`/tenders/${encodeURIComponent(s.tender)}/binding-action-releases/${encodeURIComponent(button.dataset.revokeBindingRelease)}/revoke`,"POST",{});status.textContent="Freigabe widerrufen. Es wurde nichts übertragen.";await submissionStatusView(s)}catch(error){status.textContent=error.message}});
    document.querySelector("#poll-portal-status").onclick=async()=>{
      const status=document.querySelector("#submission-action-status"),kind=document.querySelector("#reconciliation-job-kind").value,label=document.querySelector("#reconciliation-job-kind").selectedOptions[0].textContent;
      try{const result=await mutate(`/tenders/${encodeURIComponent(s.tender)}/submission-reconciliation-jobs`,"POST",{submissionContextId:context.id,jobKind:kind});status.textContent=result.idempotent?`Die read-only Prüfung „${label}“ ist bereits vorgemerkt.`:`Read-only Prüfung „${label}“ vorgemerkt; keine Portalaktion wurde ausgeführt.`;await submissionStatusView(s)}catch(error){status.textContent=error.message}
    };
  }
  async function load() {
    const s = state();
    navigation();
    out.innerHTML = '<p role="status">Ansicht wird geladen …</p>';
    try {
      if (s.view === "revenue-dashboard") await revenueDashboardView(s);
      else if (s.view === "overview") await overview(s);
      else if (s.view === "documents") await documentWorkbenchView(s);
      else if (s.view === "calculation") await calculationView(s);
      else if (s.view === "management-output") await managementView(s);
      else if (s.view === "board-brief") await boardBriefView(s);
      else if (s.view === "submission-status") await submissionStatusView(s);
      else if (
        [
          "internal-acceptance",
          "readiness",
          "sources",
          "scheduler",
          "connectors",
          "portals",
          "settings",
          "portal-access",
          "company-profiles",
          "regions",
          "matching-rules",
          "score-rules",
          "documents-inbox",
          "signatures",
          "operational-approvals",
        ].includes(s.view)
      )
        await globalView(s);
      else await contextView(s);
    } catch (e) {
      if (e.status === 404 && /registrierten Portalen/.test(e.message)) {
        out.innerHTML = `${title(labels[s.view])}<section class="panel"><p>Keine Ausschreibungen aus registrierten Portalen vorhanden.</p><a class="button-link" href="${esc(href("portal-access", {...state(),tender:"",lot:""}))}">Portalzugänge verwalten</a></section>`;
        return;
      }
      out.innerHTML = `${title(labels[s.view])}<section class="error" role="alert"><p>Die Ansicht konnte nicht geladen werden. Bitte erneut versuchen oder einen bereits bearbeiteten Kontext aus der Übersicht öffnen.</p><button id="retry" type="button">Erneut laden</button> <a href="${esc(href(s.view==="management-output"?"management-output":"overview", {...state(),tender:"",company:"",lot:""}))}">Zur Übersicht</a></section>`;
      document.querySelector("#retry").onclick = load;
    }
  }
  addEventListener("popstate", load);
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (
      !a ||
      a.origin !== location.origin ||
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    if (!a.pathname.includes("/autopilot/")) return;
    e.preventDefault();
    history.pushState({}, "", a.href);
    load();
  });
  load();
})();
(() => {
  "use strict";
  const api = document.body.dataset.api || "/api/tender",
    csrf = () =>
      decodeURIComponent(
        document.cookie
          .split("; ")
          .find((x) => x.startsWith("wb_csrf="))
          ?.split("=")
          .slice(1)
          .join("=") || "",
      ),
    post = async (path, body = {}) => {
      const response = await fetch(api + path, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrf(),
          },
          body: JSON.stringify(body),
        }),
        data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw Error(data.message || (response.status === 401 ? "Anmeldung oder MFA-Sitzung erforderlich." : response.status === 403 ? "Keine Berechtigung für diese Aktion." : response.status === 409 ? "Der Stand hat sich geändert. Bitte laden Sie die Ansicht neu." : response.status === 423 ? "Diese rechtlich bindende Portalaktion ist gesperrt. Es wurde nichts übermittelt." : response.status >= 500 ? "Die Aktion konnte wegen eines technischen Fehlers nicht abgeschlossen werden." : `Die Aktion konnte nicht abgeschlossen werden (${response.status}).`));
      return data;
    };
  document.addEventListener(
    "click",
    async (event) => {
      const button = event.target.closest?.("[data-login-portal]");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (button.disabled) return;
      const tenderId = button.dataset.tender,
        companyId = button.dataset.company,
        lotKey = button.dataset.lot || null,
        status = document.querySelector(
          `[data-login-status="${CSS.escape(button.dataset.loginPortal)}"]`,
        ),
        popup = window.open(
          "about:blank",
          `wb-portal-login-${button.dataset.loginPortal}`,
        );
      if (!popup) {
        if (status)
          status.textContent =
            "Das externe Portal konnte nicht geöffnet werden. Bitte Pop-up-Freigabe prüfen.";
        return;
      }
      button.disabled = true;
      try {
        const continuation = await post(
          `/portal-access/${encodeURIComponent(button.dataset.loginPortal)}/login-continuations`,
          { tender_id: tenderId, company_id: companyId, lot_key: lotKey },
        );
        button.dataset.continuationId = continuation.continuationId;
        button.dataset.portalAdapterId = continuation.portalAdapterId;
        button.dataset.credentialId = continuation.credentialId;
        button.dataset.portalHost = continuation.portalHost;
        popup.opener = null;
        popup.location.replace(continuation.externalUrl);
        if (status)
          status.textContent =
            "Externes Portal wurde geöffnet. Bitte Login und gegebenenfalls MFA abschließen.";
        const poll = async () => {
          const state = await post(
            `/portal-access/login-continuations/${encodeURIComponent(continuation.continuationId)}/status`,
          );
          const processingMessages={AUTOMATIC_PROCESSING_PLANNED:"Automatische Verarbeitung wird gestartet.",AUTOMATIC_PROCESSING_ACTIVE:"Automatische Verarbeitung läuft.",DOCUMENT_DOWNLOAD_ACTIVE:"Vergabeunterlagen werden geladen.",DOCUMENT_WORKFLOW_COMPLETED:"Vergabeunterlagen wurden verarbeitet.",FUNCTIONAL_BLOCKER_REACHED:"Vergabeunterlagen wurden verarbeitet. Der nächste fachliche Schritt benötigt Angaben.",TECHNICAL_BLOCKER:"Die Portalsitzung ist gültig, die automatische Verarbeitung ist technisch blockiert."};
          if (processingMessages[state.status]) {
            if (status) status.textContent=processingMessages[state.status];
            if (["AUTOMATIC_PROCESSING_PLANNED","AUTOMATIC_PROCESSING_ACTIVE","DOCUMENT_DOWNLOAD_ACTIVE"].includes(state.status)) setTimeout(()=>poll().catch((error)=>{if(status)status.textContent=`Statusprüfung fehlgeschlagen: ${error.message}`;button.disabled=false}),2000); else button.disabled=false;
            return;
          }
          if (
            [
              "LOGIN_FAILED",
              "SESSION_EXPIRED",
              "WRONG_ACCOUNT_CONTEXT",
              "WRONG_ORGANIZATION_CONTEXT",
              "LOGIN_FORM_CHANGED",
            ].includes(state.status)
          ) {
            if (status)
              status.textContent = `Portal-Anmeldung nicht abgeschlossen: ${humanizedEnum(state.status)}.`;
            button.disabled = false;
            return;
          }
          setTimeout(
            () =>
              poll().catch((error) => {
                if (status)
                  status.textContent = `Statusprüfung fehlgeschlagen: ${error.message}`;
                button.disabled = false;
              }),
            2000,
          );
        };
        setTimeout(
          () =>
            poll().catch((error) => {
              if (status)
                status.textContent = `Statusprüfung fehlgeschlagen: ${error.message}`;
              button.disabled = false;
            }),
          2000,
        );
      } catch (error) {
        popup.close();
        if (status)
          status.textContent = `Externe Anmeldung konnte nicht gestartet werden: ${error.message}`;
        button.disabled = false;
      }
    },
    true,
  );
})();
