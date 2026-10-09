export const SCHEMA_VERSION = "normalized-observation-0.2.0";
export const METRIC_DEFINITION_VERSION = "metrics-0.2.0";

export const MISSING_REASONS = [
  "source_unavailable",
  "not_instrumented",
  "missing_start",
  "missing_end",
  "missing_first_chunk",
  "timestamp_collision",
  "unbound",
  "ambiguous",
  "partial_capture",
  "semantic_unknown",
  "zero_denominator",
  "unsupported_version",
  "not_applicable",
];

export const EVIDENCE_GRADES = ["direct", "derived", "estimated", "unknown"];

export const METRIC_STATES = ["captured", "partial", "not-captured", "not-applicable"];

export function makeEvidenceRef(sourceId, sourceKind, locator, rawType, ruleVersion) {
  return {
    source_id: sourceId,
    source_kind: sourceKind,
    locator: locator || null,
    raw_type: rawType || null,
    rule_version: ruleVersion || null,
  };
}

export function makeFieldEvidence(fields) {
  const defaults = {
    identity: "unknown",
    timestamp: "unknown",
    model: "unknown",
    usage: "unknown",
    status: "unknown",
  };
  return { ...defaults, ...fields };
}

export function makeMetricResult(metric, value, opts = {}) {
  return {
    metric,
    definition_version: METRIC_DEFINITION_VERSION,
    value: value ?? null,
    unit: opts.unit || null,
    scope: opts.scope || null,
    scope_id: opts.scope_id || null,
    scope_membership: opts.scope_membership || "self",
    state: opts.state || (value != null ? "captured" : "not-captured"),
    evidence_grade: opts.evidence_grade || "unknown",
    missing_reason: opts.missing_reason || null,
    source_refs: opts.source_refs || [],
    coverage: opts.coverage || { eligible: 0, observed: 0, finished: 0 },
    numerator: opts.numerator ?? null,
    denominator: opts.denominator ?? null,
    semantic_profile: opts.semantic_profile || null,
    comparable: opts.comparable ?? false,
  };
}

export function makeDataCompleteness(missingFields) {
  return {
    has_tokens: !missingFields.includes("tokens"),
    has_ttft: !missingFields.includes("ttft"),
    has_retry: !missingFields.includes("retry"),
    has_model_routing: !missingFields.includes("model_routing"),
    has_event_stream: !missingFields.includes("event_stream"),
    missing_fields: missingFields,
  };
}
