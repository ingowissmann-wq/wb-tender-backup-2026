import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const up=fs.readFileSync(new URL("../migrations/133_portal_registry_live_redirect_evidence.sql",import.meta.url),"utf8");
const down=fs.readFileSync(new URL("../migrations/133_portal_registry_live_redirect_evidence.down.sql",import.meta.url),"utf8");

test("registry repair permits only exact observed hosts and preserves an immutable evidence trail",()=>{
  assert.match(up,/9901328ffc1b57b532fcbf200a7eea0801791054b90809c02f8e777b7d866e5c/);
  assert.match(up,/portal_registry_redirect_host_verified/);
  assert.match(up,/SELECT DISTINCT host/);
  assert.doesNotMatch(up,/\*\./);
  assert.match(up,/'externalWrite',false/);
});

test("broken bidder URL is replaced only from the exact known old value and down is bounded",()=>{
  assert.match(up,/bidder_area_url='https:\/\/www\.evergabe\.de\/ausschreibungen'/);
  assert.match(up,/bidder_area_url='https:\/\/www\.evergabe\.de\/bieter'/);
  assert.match(down,/array_remove\(registry\.allowed_subdomains,evidence\.target_host\)/);
  assert.match(down,/0133-portal-registry-live-redirect-evidence/);
});
