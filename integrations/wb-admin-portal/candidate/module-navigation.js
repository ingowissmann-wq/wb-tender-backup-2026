(() => {
  const labels = {
    "Firmen": "crm", "Kontakte": "crm", "Leads": "crm", "Chancen": "crm", "Pipelines": "crm", "Aktivitäten": "crm",
    "Aufgaben": "flow", "Wiedervorlagen": "flow", "Notizen": "flow",
    "Dokumente": "docs", "Dateien": "docs", "Kalkulator": "insights",
  };
  fetch("/api/admin/v1/iam/me", { credentials: "same-origin", cache: "no-store" })
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then((identity) => {
      if (!identity.saas) return;
      const modules = new Set(identity.modules || []);
      const enforce = () => {
        document.querySelectorAll("aside button, aside a").forEach((node) => {
          const moduleKey = labels[(node.textContent || "").trim()];
          if (moduleKey) node.hidden = !modules.has(moduleKey);
        });
        document.querySelectorAll("aside nav").forEach((nav) => {
          const title = (nav.querySelector("strong")?.textContent || "").trim();
          if (title === "CMS" || title === "Recruiting" || title === "Sicherheit") nav.hidden = true;
        });
      };
      enforce();
      new MutationObserver(enforce).observe(document.documentElement, { childList: true, subtree: true });
    }).catch(() => {});
})();
