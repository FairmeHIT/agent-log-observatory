const SECRET_KEY_PATTERN = /(?:authorization|api[-_]?key|access[_-]?token|refresh[_-]?token|cookie|password|secret|credential)/i;
const SECRET_VALUE_PATTERN = /(?:Bearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:sk|rk|pk)_[A-Za-z0-9_-]{12,})/gi;

export function redactValue(value, key = "") {
  if (SECRET_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") return value.replace(SECRET_VALUE_PATTERN, "[redacted]");
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, redactValue(item, name)])
  );
}

export function redact(value) {
  return redactValue(value);
}

export function isSafeKey(key) {
  return !SECRET_KEY_PATTERN.test(key);
}

const OUTPUT_WHITELIST = new Set([
  "agent_object", "installation_id", "adapter_version", "agent_version",
  "session_id", "root_session_id", "parent_session_id",
  "turn_id", "step_id", "llm_call_id", "attempt_id", "call_id", "message_id",
  "evaluation_run_id", "task_id", "trial_id", "binding_status",
  "trace_id", "span_id", "parent_span_id",
  "event_category", "event_subtype", "event_type_raw",
  "occurred_at", "received_at", "source_seq",
  "timestamp_basis", "precision_ms",
  "status", "requested_model", "routed_model", "provider",
  "tool_name", "tool_kind", "skill_name", "tool_kind_basis",
  "usage_record_ids", "cost_record_ids",
  "evidence_refs", "field_evidence", "metadata",
  "schema_version", "event_id",
  "metric", "definition_version", "value", "unit", "scope", "scope_id",
  "scope_membership", "state", "evidence_grade", "missing_reason",
  "source_refs", "coverage", "numerator", "denominator",
  "semantic_profile", "comparable",
  "observed_value", "algorithm", "n",
  "title", "project_dir", "started_at", "ended_at", "duration_ms",
  "step_count", "llm_call_count", "llm_attempt_count", "llm_retry_count",
  "tool_call_count", "tool_retry_count", "human_confirm_count",
  "compaction_count", "compaction_threshold", "event_counts", "failure_attribution",
  "data_completeness", "source_status",
  "tokens", "cost", "max_context", "context_window", "model", "agent_name",
  "label", "file", "is_default", "source", "generated_at", "summary", "identity",
  "status", "timestamp", "version", "agents", "available", "sources",
  "missing_reasons", "modes", "installation_id", "adapter_version",
  "agent_version", "items", "asOf", "coverage", "total", "nextCursor",
  "next_cursor", "has_tokens", "has_ttft", "has_retry", "has_model_routing",
  "has_event_stream", "has_step", "has_tool_calls", "has_human_confirm",
  "missing_fields", "ttft_caveat", "child_session_ids", "turn_ids",
  "tokens_in", "tokens_out", "tokens_cache_read",
  "tool_name", "action", "permission_by", "permission_by",
  "reason", "approval_id", "review_phase", "tool_id", "result",
  "prune_total", "prune_pruned", "prune_candidates",
  "http_phase", "method", "path", "latency_raw",
  "tag", "level", "scope", "message", "raw_message", "source_file",
  "provider", "request_id", "session_id",
  "error", "not_captured", "sample_count", "p50", "p95",
  "gateway", "tool", "model", "dependency", "agent",
  "input", "output", "reasoning", "cache_read", "cache_write",
  "reported_total", "credits", "monetary_cost", "cost_unit",
  "input_includes_cache", "output_includes_reasoning",
  "cache_write_accounting", "token_semantics_version",
  "usage_record_id", "scope_id", "count", "has_null",
  "occurred_at", "received_at", "source_seq",
  "event_id", "schema_version", "event_category",
  "event_subtype", "event_type_raw", "agent_object",
  "root_session_id", "parent_session_id", "turn_id", "step_id",
  "llm_call_id", "attempt_id", "call_id", "message_id",
  "evaluation_run_id", "task_id", "trial_id", "binding_status",
  "trace_id", "span_id", "parent_span_id",
  "timestamp_basis", "precision_ms",
  "requested_model", "routed_model",
  "tool_kind", "skill_name", "tool_kind_basis",
  "usage_record_ids", "cost_record_ids",
  "evidence_refs", "field_evidence", "metadata",
  "metric", "definition_version", "value", "unit", "scope",
  "scope_membership", "state", "evidence_grade", "missing_reason",
  "source_refs", "numerator", "denominator",
  "semantic_profile", "comparable",
  "agent_object", "first_seen", "tool_index",
  "eligible", "observed", "finished",
  "observed_value", "algorithm", "n",
]);

export function whitelistFilter(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(whitelistFilter);
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([key]) => OUTPUT_WHITELIST.has(key) || key.startsWith("_"))
      .map(([key, val]) => [key, whitelistFilter(val)])
  );
}
