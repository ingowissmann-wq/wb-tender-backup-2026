import assert from "node:assert/strict";
import crypto from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";

const root=new URL("../",import.meta.url);
const manifest=JSON.parse(await readFile(new URL("config/canonical-release-20260829.json",root),"utf8"));

test("canonical release uses full ledger identities and exact migration hashes",async()=>{
  assert.equal(manifest.requiredLedgerHead,"0154-phase2-company-scoped-resolver-jobs");
  assert.equal(manifest.externalSubmissionEnabled,false);
  assert.equal(manifest.productionActivation,false);
  assert.equal(manifest.mode,"ISOLATED_CLONE_THEN_SHADOW");
  assert.equal(manifest.migrations.length,1);
  assert.equal(manifest.rollback.length,1);
  const versions=[...manifest.migrations,...manifest.rollback].map(item=>item.version);
  assert.equal(new Set(versions).size,versions.length);
  for(const item of [...manifest.migrations,...manifest.rollback]){
    assert.match(item.version,/^\d{4}-[a-z0-9-]+$/);
    const payload=await readFile(new URL(item.path,root));
    assert.equal(crypto.createHash("sha256").update(payload).digest("hex"),item.sha256,item.path);
    assert.match(payload.toString("utf8"),new RegExp(item.version.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  }
});
