import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const server = await readFile(new URL("../platform/server.mjs", import.meta.url), "utf8");
const routes = await readFile(new URL("../platform/autopilot-routes.mjs", import.meta.url), "utf8");

test("canonical tender path redirects slash and browser authentication redirects to login", () => {
  assert.match(server, /app\.get\("\/admin\/ausschreibungen"[\s\S]*?redirect\("\/admin\/ausschreibungen\/", 308\)/);
  assert.match(server, /browserRequest[\s\S]*?\/admin\/login\?returnTo=/);
  assert.match(server, /app\.get\("\/admin\/ausschreibungen\/", uiAuth, tenderPage\)/);
});

test("connector responses expose state and machine-readable causes", () => {
  assert.match(routes, /connectorStatus: capabilityReady \? "READY_NON_BINDING" : "BLOCKED_WITH_CAUSE"/);
  assert.match(routes, /connectorReasons/);
  assert.doesNotMatch(routes, /Nicht verfügbar – Submission-Adapter nicht produktiv validiert/);
});
