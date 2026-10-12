import { METRIC_DEFINITION_VERSION, makeMetricResult } from "./evidence.mjs";

export function percentile(values, p) {
  const sorted = values.filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return makeMetricResult("percentile", null, {
    state: "not-captured", missing_reason: "zero_denominator", coverage: { eligible: 0, observed: 0, finished: 0 },
  });
  const rank = Math.ceil((p / 100) * n);
  const value = sorted[Math.min(rank - 1, n - 1)];
  const flags = n < 5 ? "insufficient_sample" : (n < 20 && p >= 95 ? "low_sample" : null);
  return makeMetricResult("percentile", value, {
    unit: sorted === values ? null : null,
    state: "captured",
    evidence_grade: "derived",
    missing_reason: flags,
    coverage: { eligible: n, observed: n, finished: n },
    numerator: rank,
    denominator: n,
    comparable: n >= 5,
  });
}

export function computeTTftMs(attempt) {
  if (!attempt.requested_at || !attempt.first_output_at) {
    return makeMetricResult("llm_attempt_ttft_ms", null, {
      unit: "ms", scope: "llm_attempt", scope_id: attempt.attempt_id,
      state: "not-captured", missing_reason: !attempt.requested_at ? "missing_start" : "missing_first_chunk",
      evidence_grade: "unknown",
    });
  }
  const value = attempt.first_output_at - attempt.requested_at;
  return makeMetricResult("llm_attempt_ttft_ms", value, {
    unit: "ms", scope: "llm_attempt", scope_id: attempt.attempt_id,
    state: "captured", evidence_grade: attempt.first_output_source === "native" ? "direct" : "derived",
    semantic_profile: "first-model-output",
    comparable: true,
  });
}

export function computeTurnE2eMs(turn) {
  if (!turn.submitted_at) {
    return makeMetricResult("turn_e2e_ms", null, {
      unit: "ms", scope: "turn", scope_id: turn.turn_id,
      state: "not-captured", missing_reason: "missing_start",
    });
  }
  if (!turn.execution_ended_at) {
    return makeMetricResult("turn_e2e_ms", null, {
      unit: "ms", scope: "turn", scope_id: turn.turn_id,
      state: "not-captured", missing_reason: "missing_end",
    });
  }
  const value = turn.execution_ended_at - turn.submitted_at;
  return makeMetricResult("turn_e2e_ms", value, {
    unit: "ms", scope: "turn", scope_id: turn.turn_id,
    state: "captured", evidence_grade: "direct",
    comparable: true,
  });
}

export function computeSessionTurnE2eAvg(turns) {
  const durations = [];
  const reasons = [];
  for (const t of turns) {
    if (typeof t === "number") {
      if (Number.isFinite(t) && t >= 0) durations.push(t);
      else reasons.push("ambiguous");
      continue;
    }
    if (t.submitted_at == null) { reasons.push("missing_start"); continue; }
    if (t.execution_ended_at == null) { reasons.push("missing_end"); continue; }
    const d = t.execution_ended_at - t.submitted_at;
    if (d < 0) { reasons.push("ambiguous"); continue; }
    durations.push(d);
  }
  if (durations.length === 0) {
    return makeMetricResult("turn_e2e_ms", null, {
      unit: "ms", scope: "session",
      state: "not-captured",
      missing_reason: reasons.length > 0 ? reasons[0] : "missing_start",
      evidence_grade: "unknown",
      semantic_profile: "mean_turn_execution_e2e",
      coverage: { eligible: turns.length, observed: 0, finished: 0 },
    });
  }
  const avg = Math.round(durations.reduce((s, v) => s + v, 0) / durations.length);
  return makeMetricResult("turn_e2e_ms", avg, {
    unit: "ms", scope: "session",
    state: "captured", evidence_grade: "derived",
    semantic_profile: "mean_turn_execution_e2e",
    comparable: true,
    coverage: { eligible: turns.length, observed: durations.length, finished: durations.length },
  });
}

export function computeSessionLifespanMs(firstTs, lastTs) {
  if (firstTs == null) {
    return makeMetricResult("session_lifespan_ms", null, {
      unit: "ms", scope: "session",
      state: "not-captured", missing_reason: "missing_start",
      evidence_grade: "unknown", semantic_profile: "wall_clock_lifespan",
    });
  }
  if (lastTs == null) {
    return makeMetricResult("session_lifespan_ms", null, {
      unit: "ms", scope: "session",
      state: "not-captured", missing_reason: "missing_end",
      evidence_grade: "unknown", semantic_profile: "wall_clock_lifespan",
    });
  }
  const value = lastTs - firstTs;
  return makeMetricResult("session_lifespan_ms", value, {
    unit: "ms", scope: "session",
    state: value >= 0 ? "captured" : "not-captured",
    missing_reason: value >= 0 ? null : "ambiguous",
    evidence_grade: value >= 0 ? "direct" : "unknown",
    semantic_profile: "wall_clock_lifespan",
    comparable: true,
  });
}

/**
 * 派生指标：session_first_response_ms
 * 从 session 开始到首条 llm.response 事件的间隔。
 * 与 llm_attempt_ttft_ms 不同——后者度量单次 LLM 调用的首 token 延迟；
 * 本指标度量 session 级别的"用户发完话到首次看到模型输出"的墙钟延迟，
 * 包含请求排队、上下文编码等额外时间。用 evidence_grade="estimated" 区分。
 *
 * 各适配器用最高效的方式获取 started_at_epoch 和 first_response_epoch，
 * 不需要调用 extractEvents。
 */
export function computeSessionFirstResponseMs(startedAtEpoch, firstResponseEpoch, sessionId) {
  if (!startedAtEpoch) {
    return makeMetricResult("session_first_response_ms", null, {
      unit: "ms", scope: "session", scope_id: sessionId,
      state: "not-captured", missing_reason: "missing_start",
      evidence_grade: "unknown",
      semantic_profile: "session_start_to_first_llm_response",
    });
  }
  if (!firstResponseEpoch) {
    return makeMetricResult("session_first_response_ms", null, {
      unit: "ms", scope: "session", scope_id: sessionId,
      state: "not-captured", missing_reason: "missing_first_chunk",
      evidence_grade: "unknown",
      semantic_profile: "session_start_to_first_llm_response",
    });
  }
  const value = firstResponseEpoch - startedAtEpoch;
  if (!Number.isFinite(value) || value < 0) {
    return makeMetricResult("session_first_response_ms", null, {
      unit: "ms", scope: "session", scope_id: sessionId,
      state: "not-captured", missing_reason: "ambiguous",
      evidence_grade: "unknown",
      semantic_profile: "session_start_to_first_llm_response",
    });
  }
  return makeMetricResult("session_first_response_ms", Math.round(value), {
    unit: "ms", scope: "session", scope_id: sessionId,
    state: "captured",
    evidence_grade: "estimated",
    semantic_profile: "session_start_to_first_llm_response",
    comparable: true,
  });
}

/**
 * 批量生成错误计数指标。
 * llmError / toolError 来自 extractCalls 的 call-level 统计；
 * failuresResult 来自 extractFailures 的完整返回（含 summary + source_available）。
 * 如果 failuresResult 为 null（适配器未实现），dependency/agent/failures_* 返回 not-captured。
 * 同时返回 failures_gateway/tool/model/dependency/agent（pattern-level 归因），
 * 避免 sync 再单独调用 extractFailures 生成这些指标。
 */
export function makeErrorCountMetrics(llmError, toolError, failuresResult, sessionId) {
  const s = (failuresResult && failuresResult.summary) || {};
  const failuresNc = !failuresResult || failuresResult.source_available === false;
  const base = {
    scope: "session", scope_id: sessionId,
  };
  return [
    makeMetricResult("llm_error_count", llmError ?? null, {
      ...base, evidence_grade: "direct",
      state: llmError != null ? "captured" : "not-captured",
      missing_reason: llmError != null ? null : "not_instrumented",
    }),
    makeMetricResult("tool_error_count", toolError ?? null, {
      ...base, evidence_grade: "direct",
      state: toolError != null ? "captured" : "not-captured",
      missing_reason: toolError != null ? null : "not_instrumented",
    }),
    makeMetricResult("dependency_error_count",
      failuresNc ? null : (s.dependency || 0), {
      ...base, evidence_grade: "direct",
      state: failuresNc ? "not-captured" : "captured",
      missing_reason: failuresNc ? "source_unavailable" : null,
    }),
    makeMetricResult("agent_error_count",
      failuresNc ? null : (s.agent || 0), {
      ...base, evidence_grade: "direct",
      state: failuresNc ? "not-captured" : "captured",
      missing_reason: failuresNc ? "source_unavailable" : null,
    }),
    // pattern-level failures_* metrics (for compare table and detail API)
    makeMetricResult("failures_gateway",
      failuresNc ? null : (s.gateway || 0), {
      ...base, evidence_grade: "direct",
      state: failuresNc ? "not-captured" : "captured",
      missing_reason: failuresNc ? "source_unavailable" : null,
    }),
    makeMetricResult("failures_tool",
      failuresNc ? null : (s.tool || 0), {
      ...base, evidence_grade: "direct",
      state: failuresNc ? "not-captured" : "captured",
      missing_reason: failuresNc ? "source_unavailable" : null,
    }),
    makeMetricResult("failures_model",
      failuresNc ? null : (s.model || 0), {
      ...base, evidence_grade: "direct",
      state: failuresNc ? "not-captured" : "captured",
      missing_reason: failuresNc ? "source_unavailable" : null,
    }),
    makeMetricResult("failures_dependency",
      failuresNc ? null : (s.dependency || 0), {
      ...base, evidence_grade: "direct",
      state: failuresNc ? "not-captured" : "captured",
      missing_reason: failuresNc ? "source_unavailable" : null,
    }),
    makeMetricResult("failures_agent",
      failuresNc ? null : (s.agent || 0), {
      ...base, evidence_grade: "direct",
      state: failuresNc ? "not-captured" : "captured",
      missing_reason: failuresNc ? "source_unavailable" : null,
    }),
  ];
}

export function aggregateTokens(usageRecords) {
  const result = {
    input: 0, output: 0, reasoning: 0,
    cache_read: 0, cache_write: 0,
    reported_total: 0, credits: 0, monetary_cost: 0,
    count: usageRecords.length,
    has_null: false,
  };
  for (const r of usageRecords) {
    for (const key of ["input", "output", "reasoning", "cache_read", "cache_write", "reported_total"]) {
      if (r[key] == null) { result.has_null = true; continue; }
      result[key] += r[key];
    }
    if (r.credits != null) result.credits += r.credits;
    if (r.monetary_cost != null) result.monetary_cost += r.monetary_cost;
  }
  return result;
}

export function computeCacheHitRate(usageRecords) {
  const withInput = usageRecords.filter((r) => {
    const input = r.input ?? 0;
    const cacheRead = r.cache_read ?? 0;
    return input > 0 || cacheRead > 0;
  });
  if (withInput.length === 0) {
    return makeMetricResult("cache_hit_rate", null, {
      state: "not-captured", missing_reason: "zero_denominator",
    });
  }
  let totalCache = 0, totalFullInput = 0;
  for (const r of withInput) {
    const input = r.input ?? 0;
    const cacheRead = r.cache_read ?? 0;
    const includesCache = r.input_includes_cache === true;
    totalCache += cacheRead;
    totalFullInput += includesCache ? input : input + cacheRead;
  }
  if (totalFullInput === 0) {
    return makeMetricResult("cache_hit_rate", null, {
      state: "not-captured", missing_reason: "zero_denominator",
    });
  }
  return makeMetricResult("cache_hit_rate", totalCache / totalFullInput, {
    numerator: totalCache, denominator: totalFullInput,
    state: "captured", evidence_grade: "derived",
    comparable: true,
  });
}

export function computeSuccessRate(knownOk, knownError) {
  const total = knownOk + knownError;
  if (total === 0) {
    return makeMetricResult("success_rate", null, {
      state: "not-captured", missing_reason: "zero_denominator",
      coverage: { eligible: 0, observed: 0, finished: 0 },
    });
  }
  return makeMetricResult("success_rate", knownOk / total, {
    numerator: knownOk, denominator: total,
    state: "captured", evidence_grade: "derived",
    coverage: { eligible: total, observed: total, finished: total },
    comparable: true,
  });
}

export function computeRetryRate(retryCount, attemptCount) {
  if (attemptCount === 0) {
    return makeMetricResult("retry_rate", null, {
      state: "not-captured", missing_reason: "zero_denominator",
    });
  }
  return makeMetricResult("retry_rate", retryCount / attemptCount, {
    numerator: retryCount, denominator: attemptCount,
    state: "captured", evidence_grade: retryCount > 0 ? "direct" : "derived",
  });
}

export function computeOutputTps(outputTokens, generationMs) {
  if (!generationMs || generationMs <= 0 || outputTokens == null) {
    return makeMetricResult("generation_output_tps", null, {
      state: "not-captured", missing_reason: !outputTokens ? "not_instrumented" : "missing_start",
    });
  }
  return makeMetricResult("generation_output_tps", outputTokens / (generationMs / 1000), {
    unit: "tok/s", state: "captured", evidence_grade: "derived",
    semantic_profile: "output_tokens_per_generation_second",
    comparable: true,
  });
}
