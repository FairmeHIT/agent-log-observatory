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
