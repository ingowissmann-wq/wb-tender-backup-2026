import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import rawBody from "fastify-raw-body";
import { UnconfiguredBillingAdapter } from "../platform/saas-adapters.mjs";
import { registerBillingWebhookRoute } from "../platform/saas-platform.mjs";

for (const name of ["EXTERNAL_SUBMISSION_ENABLED", "WB_TENDER_ALLOW_EXTERNAL_SUBMISSION"]) {
  if (process.env[name] !== "false") throw new Error(`${name}_must_be_false`);
}

if (process.env.WB_TENDER_SAAS_ENABLED === "true") {
  throw new Error("full_saas_access_must_remain_disabled");
}

const app = Fastify({
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.stripe-signature",
      "req.body",
    ],
  },
  trustProxy: true,
  bodyLimit: 1024 * 1024,
});

await app.register(rawBody, {
  field: "rawBody",
  global: false,
  encoding: false,
  runFirst: true,
});
await app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

app.addHook("onSend", async (_, reply, payload) => {
  reply.header("cache-control", "no-store");
  reply.header("x-robots-tag", "noindex, nofollow, noarchive");
  return payload;
});

app.get("/healthz", async () => ({
  status: "ok",
  component: "saas-webhook-candidate",
  paymentProviderConfigured: false,
  fullSaasAccess: false,
  externalSubmissionEnabled: false,
}));

// No Stripe credentials are installed on NEW Green yet. Register only the
// previously implemented webhook route with its explicit fail-closed adapter.
// A correctly shaped or signed payload cannot reach a database from this runtime.
registerBillingWebhookRoute(app, {
  enabled: true,
  billingAdapter: new UnconfiguredBillingAdapter(),
  pool: {
    async connect() {
      throw new Error("webhook_database_not_configured");
    },
  },
});

await app.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT || 4240),
});
