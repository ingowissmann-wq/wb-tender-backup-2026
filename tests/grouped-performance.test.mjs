import assert from "node:assert/strict";
import test from "node:test";

import {createGroupedPerformanceDecision} from "../platform/grouped-performance.mjs";

const scope = {tenantId: "tenant-1", companyId: "cleaning-1", tenderId: "blka", lotId: "lot-1", lotKey: "LOT-0001"};
const approval = {inputId: "approval-1", approvedBy: "board-1", approvedAt: "2026-08-29"};
const groups = [
  {groupKey: "A", minimumPerformance: 180, approvedPerformance: 195, maximumPerformance: 210, unit: "M2_PER_HOUR", classification: "CASE_APPROVED"},
  {groupKey: "C", minimumPerformance: null, approvedPerformance: 75, maximumPerformance: null, unit: "M2_PER_HOUR", classification: "CASE_APPROVED"},
];

test("grouped performance binds approved ranges and subgroups to one exact case scope", () => {
  const decision = createGroupedPerformanceDecision({
    scope, groups, approval,
    applications: [{subgroupKey: "A/1", groupKey: "A"}, {subgroupKey: "A/2", groupKey: "A"}, {subgroupKey: "C/1", groupKey: "C"}],
  });
  assert.equal(decision.scope.tenderId, "blka");
  assert.equal(decision.groups[0].approvedPerformance, 195);
  assert.equal(decision.transferable, false);
  assert.match(decision.decisionSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(decision.applications));
});

test("a range never selects a value and an unapproved or out-of-range value fails closed", () => {
  assert.throws(() => createGroupedPerformanceDecision({
    scope, approval, applications: [{subgroupKey: "A/1", groupKey: "A"}],
    groups: [{groupKey: "A", minimumPerformance: 180, maximumPerformance: 210, approvedPerformance: null, unit: "M2_PER_HOUR", classification: "CASE_APPROVED"}],
  }), error => error.details.some(item => item.code === "GROUPED_PERFORMANCE_APPROVED_VALUE_INVALID"));
  assert.throws(() => createGroupedPerformanceDecision({
    scope, approval, applications: [{subgroupKey: "A/1", groupKey: "A"}],
    groups: [{groupKey: "A", minimumPerformance: 180, maximumPerformance: 190, approvedPerformance: 195, unit: "M2_PER_HOUR", classification: "CASE_APPROVED"}],
  }), error => error.details.some(item => item.code === "GROUPED_PERFORMANCE_ABOVE_MAXIMUM"));
});

test("unknown and duplicate subgroup mappings fail closed", () => {
  assert.throws(() => createGroupedPerformanceDecision({
    scope, groups, approval,
    applications: [{subgroupKey: "A/1", groupKey: "A"}, {subgroupKey: "A/1", groupKey: "B"}],
  }), error => {
    const codes = error.details.map(item => item.code);
    return codes.includes("GROUPED_PERFORMANCE_SUBGROUP_DUPLICATE") && codes.includes("GROUPED_PERFORMANCE_GROUP_REFERENCE_UNKNOWN");
  });
});
