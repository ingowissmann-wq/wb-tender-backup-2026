const required = ["WIKOS_BASE_URL", "WIKOS_CLIENT_ID", "WIKOS_CLIENT_SECRET_FILE"];

export function wikOSConfiguration(env = process.env) {
  if (env.WIKOS_LOCAL_STUB === "true") {
    if (env.NODE_ENV === "production") throw new Error("wikos_local_stub_forbidden_in_production");
    return Object.freeze({ mode: "LOCAL_STUB", baseURL: "http://wikos-stub:8080", externalWrite: false });
  }
  const missing = required.filter((name) => !String(env[name] || "").trim());
  if (env.WIKOS_CLIENT_SECRET) missing.push("WIKOS_CLIENT_SECRET_FILE:inline_secret_forbidden");
  if (missing.length) throw new Error(`wikos_configuration_missing:${missing.join(",")}`);
  const url = new URL(env.WIKOS_BASE_URL);
  if (url.protocol !== "https:") throw new Error("wikos_https_required");
  return Object.freeze({ mode: "PRODUCTION", baseURL: url.href.replace(/\/$/, ""), clientId: env.WIKOS_CLIENT_ID, secretFile: env.WIKOS_CLIENT_SECRET_FILE, externalWrite: false });
}

export async function verifyWikosReadContract(config, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.baseURL}/v1/health`, { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw new Error(`wikos_health_failed:${response.status}`);
  const body = await response.json();
  if (body.system !== "WIKOS" || body.partner !== "KYNTRIVEX" || body.readOnly !== true) throw new Error("wikos_contract_invalid");
  return Object.freeze({ verified: true, system: body.system, partner: body.partner, readOnly: true, externalWrite: false });
}
