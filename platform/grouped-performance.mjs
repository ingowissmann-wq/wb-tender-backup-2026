import {snapshotHash} from "./canonical-truth.mjs";

export const GROUPED_PERFORMANCE_MODEL_VERSION = "wb-tender-grouped-performance/1.0.0";

const supplied = value => value !== null && value !== undefined && String(value).trim() !== "";
const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const immutable = value => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(immutable);
  return Object.freeze(value);
};

export function createGroupedPerformanceDecision({scope, defaultPerformance = null, groups = [], applications = [], approval} = {}) {
  const errors = [];
  for (const key of ["tenantId", "companyId", "tenderId", "lotId", "lotKey"])
    if (!supplied(scope?.[key])) errors.push({code: "GROUPED_PERFORMANCE_SCOPE_MISSING", field: key});
  if (![approval?.inputId, approval?.approvedBy, approval?.approvedAt].every(supplied))
    errors.push({code: "GROUPED_PERFORMANCE_APPROVAL_INCOMPLETE"});
  if (!Array.isArray(groups) || !groups.length) errors.push({code: "GROUPED_PERFORMANCE_GROUPS_EMPTY"});

  const knownGroups = new Set();
  for (const group of groups || []) {
    const key = String(group?.groupKey || "");
    if (!key) errors.push({code: "GROUPED_PERFORMANCE_GROUP_KEY_MISSING"});
    if (knownGroups.has(key)) errors.push({code: "GROUPED_PERFORMANCE_GROUP_DUPLICATE", groupKey: key});
    knownGroups.add(key);
    if (!finitePositive(group?.approvedPerformance))
      errors.push({code: "GROUPED_PERFORMANCE_APPROVED_VALUE_INVALID", groupKey: key});
    if (!supplied(group?.unit)) errors.push({code: "GROUPED_PERFORMANCE_UNIT_MISSING", groupKey: key});
    if (group?.minimumPerformance !== null && group?.minimumPerformance !== undefined &&
        (!finitePositive(group.minimumPerformance) || Number(group.approvedPerformance) < Number(group.minimumPerformance)))
      errors.push({code: "GROUPED_PERFORMANCE_BELOW_MINIMUM", groupKey: key});
    if (group?.maximumPerformance !== null && group?.maximumPerformance !== undefined &&
        (!finitePositive(group.maximumPerformance) || Number(group.approvedPerformance) > Number(group.maximumPerformance)))
      errors.push({code: "GROUPED_PERFORMANCE_ABOVE_MAXIMUM", groupKey: key});
    if (String(group?.classification || "") !== "CASE_APPROVED")
      errors.push({code: "GROUPED_PERFORMANCE_CLASSIFICATION_INVALID", groupKey: key});
  }

  const appliedSubgroups = new Set();
  for (const application of applications || []) {
    const subgroupKey = String(application?.subgroupKey || "");
    const groupKey = String(application?.groupKey || "");
    if (!subgroupKey) errors.push({code: "GROUPED_PERFORMANCE_SUBGROUP_KEY_MISSING"});
    if (appliedSubgroups.has(subgroupKey))
      errors.push({code: "GROUPED_PERFORMANCE_SUBGROUP_DUPLICATE", subgroupKey});
    appliedSubgroups.add(subgroupKey);
    if (!knownGroups.has(groupKey))
      errors.push({code: "GROUPED_PERFORMANCE_GROUP_REFERENCE_UNKNOWN", subgroupKey, groupKey});
  }
  if (!Array.isArray(applications) || !applications.length)
    errors.push({code: "GROUPED_PERFORMANCE_APPLICATIONS_EMPTY"});
  if (defaultPerformance !== null && defaultPerformance !== undefined && !finitePositive(defaultPerformance?.value))
    errors.push({code: "GROUPED_PERFORMANCE_DEFAULT_INVALID"});

  if (errors.length) {
    const error = new Error("GROUPED_PERFORMANCE_DECISION_INVALID");
    error.code = "GROUPED_PERFORMANCE_DECISION_INVALID";
    error.details = errors;
    throw error;
  }
  const body = {
    modelVersion: GROUPED_PERFORMANCE_MODEL_VERSION,
    scope: {...scope},
    defaultPerformance,
    groups: groups.map(group => ({
      groupKey: String(group.groupKey),
      minimumPerformance: group.minimumPerformance ?? null,
      approvedPerformance: Number(group.approvedPerformance),
      maximumPerformance: group.maximumPerformance ?? null,
      unit: group.unit,
      priority: group.priority ?? 100,
      classification: "CASE_APPROVED",
    })),
    applications: applications.map(application => ({
      subgroupKey: String(application.subgroupKey),
      groupKey: String(application.groupKey),
    })),
    approval: {...approval},
    transferable: false,
  };
  return immutable({...body, decisionSha256: snapshotHash(body)});
}
