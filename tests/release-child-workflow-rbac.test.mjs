import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../platform/server.mjs", import.meta.url), "utf8");
const browserGate = readFileSync(new URL("../scripts/release-browser-e2e.mjs", import.meta.url), "utf8");

test("every tender child workflow write resolves tender visibility before mutation", () => {
  for (const child of ["tasks", "notes", "reminders", "evaluations"]) {
    const route = server.slice(server.indexOf(`"/api/tenders/:id/${child}"`));
    const handler = route.slice(0, route.indexOf("\n);") + 3);
    assert.match(handler, /visibleTender\(req, reply, req\.params\.id\)/, `${child} lacks tenant/RBAC tender visibility`);
    assert.ok(handler.indexOf("visibleTender(") < handler.indexOf("INSERT INTO"), `${child} checks visibility after mutation`);
  }
});

test("task and reminder reads carry authoritative tender scope into mayView", () => {
  for (const routeName of ["tasks", "reminders"]) {
    const route = server.slice(server.indexOf(`"/api/${routeName}"`));
    const handler = route.slice(0, route.indexOf("\n);") + 3);
    for (const column of ["t.company_id", "t.assigned_user_id", "t.sector_id"]) {
      assert.match(handler, new RegExp(column.replace(".", "\\.")), `${routeName} omits ${column}`);
    }
    assert.match(handler, /\.filter\(\(item\) => mayView\(req\.identity, item\)\)/);
  }
});

test("browser rehearsal requires RLS-hidden foreign tender targets to remain non-enumerating", () => {
  assert.match(browserGate, /foreignTenderId}`\)\)\)\.status\(\), 404, "foreign company tender was not hidden"/);
  assert.match(browserGate, /foreignTenderId}\/tasks`[\s\S]*?\.status\(\), 404, "foreign tender task target was not hidden"/);
  assert.match(browserGate, /foreignTenderId}\/reminders`[\s\S]*?\.status\(\), 404, "foreign tender reminder target was not hidden"/);
});
