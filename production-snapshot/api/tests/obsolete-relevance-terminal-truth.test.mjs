import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const up=fs.readFileSync(new URL("../migrations/140_obsolete_relevance_terminal_truth.sql",import.meta.url),"utf8");
const down=fs.readFileSync(new URL("../migrations/140_obsolete_relevance_terminal_truth.down.sql",import.meta.url),"utf8");

test("legacy NOT_ELIGIBLE becomes the worker's current superseded relevance success",()=>{
  assert.match(up,/queue\.status='DEAD_LETTER'/);
  assert.match(up,/coalesce\(queue\.safe_error_code,queue\.error_code\)='NOT_ELIGIBLE'/);
  assert.match(up,/status='SUCCEEDED',current_step='SUPERSEDED_BY_CURRENT_RELEVANCE'/);
  assert.match(up,/'externalWrite',false/);
  assert.doesNotMatch(up,/\b(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?tender\.autopilot_queue/i);
});

test("rollback restores only rows bearing the exact migration marker",()=>{
  assert.match(down,/terminalClassificationVersion'='obsolete-relevance-terminal-v1'/);
  assert.match(down,/originalQueueStatus/);
  assert.match(down,/DELETE FROM app\.schema_migrations WHERE version='0140-obsolete-relevance-terminal-truth'/);
  assert.doesNotMatch(down.replace(/DELETE FROM app\.schema_migrations[^;]+;/,""),/\b(?:DELETE|TRUNCATE)\b/i);
});
