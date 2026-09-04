const defaultHealthURL = "https://api.kyntrivex.com/api/health";

const httpsURL = (value, label) => {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label}_https_required`);
  if (url.username || url.password) throw new Error(`${label}_embedded_credentials_forbidden`);
  return url;
};

export function wikOSConfiguration(env = process.env) {
  if (env.WIKOS_LOCAL_STUB === "true") {
    if (env.NODE_ENV === "production") throw new Error("wikos_local_stub_forbidden_in_production");
    return Object.freeze({ mode: "LOCAL_STUB", healthURL: "http://wikos-stub:8080/v1/health", externalWrite: false });
  }
  if (env.WIKOS_CLIENT_SECRET) throw new Error("wikos_inline_secret_forbidden");
  const configured = String(env.WIKOS_HEALTH_URL || "").trim();
  const base = String(env.WIKOS_BASE_URL || "").trim();
  const healthURL = configured
    ? httpsURL(configured, "wikos_health_url")
    : base
      ? new URL("api/health", `${httpsURL(base, "wikos_base_url").href.replace(/\/$/, "")}/`)
      : new URL(defaultHealthURL);
  return Object.freeze({
    mode: "PRODUCTION_READ_ONLY",
    healthURL: healthURL.href,
    clientIdConfigured: Boolean(String(env.WIKOS_CLIENT_ID || "").trim()),
    secretFileConfigured: Boolean(String(env.WIKOS_CLIENT_SECRET_FILE || "").trim()),
    externalWrite: false,
  });
}

const schemaOf = (value) => Object.fromEntries(
  Object.entries(value).map(([key, item]) => [key, Array.isArray(item) ? "array" : item === null ? "null" : typeof item]),
);

export async function verifyWikosReadContract(config, fetchImpl = fetch) {
  const response = await fetchImpl(config.healthURL, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`wikos_health_failed:${response.status}`);
  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("wikos_health_json_object_required");
  if (config.mode === "LOCAL_STUB") {
    if (body.system !== "WIKOS" || body.partner !== "KYNTRIVEX" || body.readOnly !== true) throw new Error("wikos_stub_contract_invalid");
    return Object.freeze({ verified: true, mode: config.mode, httpStatus: response.status, status: "ok", checks: {}, schema: schemaOf(body), readOnly: true, externalWrite: false });
  }
  const checks = body.checks;
  if (body.status !== "ok" || !checks || typeof checks !== "object" || checks.database !== "up" || checks.redis !== "up")
    throw new Error("wikos_production_health_contract_invalid");
  return Object.freeze({
    verified: true,
    mode: config.mode,
    httpStatus: response.status,
    status: body.status,
    checks: Object.freeze({ database: checks.database, redis: checks.redis }),
    schema: Object.freeze({ ...schemaOf(body), checks: schemaOf(checks) }),
    readOnly: true,
    externalWrite: false,
  });
}

export const defaultWikosHealthURL = defaultHealthURL;
