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
  if (attempt.requested_at == null || attempt.first_output_at == null) {
    return makeMetricResult("llm_attempt_ttft_ms", null, {
      unit: "ms", scope: "llm_attempt", scope_id: attempt.attempt_id,
      state: "not-captured", missing_reason: attempt.requested_at == null ? "missing_start" : "missing_first_chunk",
      evidence_grade: "unknown",
    });
  }
  const value = attempt.first_output_at - attempt.requested_at;
  if (!Number.isFinite(attempt.requested_at)||!Number.isFinite(attempt.first_output_at)||value<0) return makeMetricResult('llm_attempt_ttft_ms',null,{unit:'ms',scope:'llm_attempt',scope_id:attempt.attempt_id,missing_reason:'ambiguous'});
  return makeMetricResult("llm_attempt_ttft_ms", value, {
    unit: "ms", scope: "llm_attempt", scope_id: attempt.attempt_id,
    state: "captured", evidence_grade: attempt.first_output_source === "native" ? "direct" : "derived",
    semantic_profile: "first-model-output",
    comparable: true,
  });
}

export function computeTurnE2eMs(turn) {
  if (turn.submitted_at == null) {
    return makeMetricResult("turn_e2e_ms", null, {
      unit: "ms", scope: "turn", scope_id: turn.turn_id,
      state: "not-captured", missing_reason: "missing_start",
    });
  }
  if (turn.execution_ended_at == null) {
    return makeMetricResult("turn_e2e_ms", null, {
      unit: "ms", scope: "turn", scope_id: turn.turn_id,
      state: "not-captured", missing_reason: "missing_end",
    });
  }
  const value = turn.execution_ended_at - turn.submitted_at;
  if (!Number.isFinite(turn.submitted_at)||!Number.isFinite(turn.execution_ended_at)||value<0) return makeMetricResult('turn_e2e_ms',null,{unit:'ms',scope:'turn',scope_id:turn.turn_id,missing_reason:'ambiguous'});
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
    if (!Number.isFinite(t.submitted_at)||!Number.isFinite(t.execution_ended_at)||!Number.isFinite(d)||d < 0) { reasons.push("ambiguous"); continue; }
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
    state: durations.length<turns.length?'partial':'captured', evidence_grade: "derived",
    missing_reason:durations.length<turns.length?'partial_capture':null,
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
  if(!Number.isFinite(firstTs)||!Number.isFinite(lastTs)||value<0)return makeMetricResult('session_lifespan_ms',null,{unit:'ms',scope:'session',missing_reason:'ambiguous',semantic_profile:'wall_clock_lifespan'});
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
export function makeErrorCountMetrics(llmError, toolError, failuresResult, sessionId, calls = {}) {
  const s = (failuresResult && failuresResult.summary) || {};
  const failuresNc = !failuresResult || failuresResult.source_available === false;
  const base = {
    scope: "session", scope_id: sessionId,
  };
  const callErrors=(kind,value)=>{
    const rows=calls[kind+'_calls'];
    if(!Array.isArray(rows))return {};
    const unique=uniqueCallRecords(rows,kind==='llm'?'llm_call_id':'call_id',sessionId);
    const known=unique.filter(c=>['ok','error','cancelled'].includes(c.status)).length;
    const errors=unique.filter(c=>c.status==='error').length;
    return {value:known<unique.length&&!errors?null:errors,state:known<unique.length?(errors?'partial':'not-captured'):'captured',missing_reason:known<unique.length?'partial_capture':null,coverage:{eligible:unique.length,observed:known,finished:known}};
  };
  const llm=callErrors('llm',llmError),tool=callErrors('tool',toolError);
  return [
    makeMetricResult("llm_error_count", 'value' in llm?llm.value:llmError ?? null, {
      ...base, evidence_grade: "direct",
      state: llmError != null ? "captured" : "not-captured",
      missing_reason: llmError != null ? null : "not_instrumented",
      ...llm,
    }),
    makeMetricResult("tool_error_count", 'value' in tool?tool.value:toolError ?? null, {
      ...base, evidence_grade: "direct",
      state: toolError != null ? "captured" : "not-captured",
      missing_reason: toolError != null ? null : "not_instrumented",
      ...tool,
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
  if (withInput.some(r => typeof r.input_includes_cache !== 'boolean' || r.input == null || r.cache_read == null)) {
    return makeMetricResult('cache_hit_rate', null, {
      state:'not-captured', missing_reason:'semantic_unknown', comparable:false,
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

export function computeSuccessRate(knownOk, knownError, eligible = knownOk + knownError) {
  const total = knownOk + knownError;
  if (total === 0) {
    return makeMetricResult("success_rate", null, {
      state: "not-captured", missing_reason: "zero_denominator",
      coverage: { eligible: 0, observed: 0, finished: 0 },
    });
  }
  return makeMetricResult("success_rate", knownOk / total, {
    numerator: knownOk, denominator: total,
    state: total<eligible?'partial':'captured', evidence_grade: "derived",
    missing_reason:total<eligible?'partial_capture':null,
    coverage: { eligible, observed: total, finished: total },
    comparable: total===eligible,
  });
}

// Records have adapter-specific grain. Count them independently of logical LLM
// calls/attempts; never reinterpret assistant messages or stream segments.
export function uniqueCallRecords(rows, id, sessionId) {
  const groups = new Map();
  for (const [i,row] of (rows || []).entries()) {
    const key=JSON.stringify([row.session_id ?? sessionId,row.agent_id ?? null,row[id] ?? `unidentified-row-${i}`]);
    const group=groups.get(key)||[];group.push(row);groups.set(key,group);
  }
  return [...groups.values()].map(group=>{
    const terminal=new Set(group.map(r=>r.status).filter(s=>['ok','error','cancelled'].includes(s)));
    const names=new Set(group.map(r=>r.tool_name).filter(Boolean));
    return {...group[0],tool_name:names.size===1?[...names][0]:null,
      status:terminal.size===1?[...terminal][0]:'unknown'};
  });
}

export function computeCallRecordMetrics(calls, sessionId) {
  const result = [];
  for (const [kind, key, id] of [['llm','llm_calls','llm_call_id'], ['tool','tool_calls','call_id']]) {
    const rows = calls?.[key];
    const available = Array.isArray(rows);
    const unique = uniqueCallRecords(rows,id,sessionId).map(r=>r.status);
    const ok = unique.filter(s=>s==='ok').length, errors = unique.filter(s=>s==='error').length;
    const cancelled = unique.filter(s=>s==='cancelled').length;
    const finished = ok + errors + cancelled, n = unique.length;
    const base = {scope:'session',scope_id:sessionId,evidence_grade:'derived',comparable:false,
      source_refs:[{source_id:'adapter-calls',source_kind:'summary',locator:null,raw_type:key,rule_version:'record-metrics-1.0'}],
      semantic_profile:`unique_adapter_${kind}_records`,
      coverage:{eligible:n,observed:n,finished}};
    const metric = (name,value,opts={}) => makeMetricResult(name,available?value:null,{
      ...base, state:available?'captured':'not-captured', missing_reason:available?null:'source_unavailable',...opts,
    });
    result.push(metric(`${kind}_record_count`,n), metric(`${kind}_raw_record_count`,rows?.length ?? null),
      metric(`${kind}_duplicate_record_count`,available?rows.length-n:null),
      metric(`${kind}_observed_ok_count`,ok), metric(`${kind}_observed_error_count`,errors),
      metric(`${kind}_observed_cancelled_count`,cancelled), metric(`${kind}_unresolved_record_count`,n-finished));
    for (const [name,num,den] of [[`${kind}_terminal_coverage`,finished,n],
      [`${kind}_observed_success_rate`,ok,ok+errors], [`${kind}_observed_error_rate`,errors,ok+errors]]) {
      result.push(metric(name,den?num/den:null,{unit:'ratio',numerator:num,denominator:den,
        state:!available||!den?'not-captured':finished<n?'partial':'captured',
        missing_reason:!available?'source_unavailable':!den?'zero_denominator':finished<n?'partial_capture':null}));
    }
  }
  return result;
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

// Observation-plane metrics: callers extract facts and identity; formulas live
// here. Client HTTP/message timing never substitutes for internal LLM timing.
export function computeObservationMetrics({ sessionId, trajectory, tools, records, asOf = Date.now(), collector = {}, infrastructure = [], sourceRefs = {} }) {
  const version = "metrics-0.3.0";
  const source = trajectory.stats.source_files > 0;
  const incomplete = trajectory.stats.parse_errors > 0 || trajectory.stats.partial_lines > 0 || trajectory.stats.limited || records.length>0;
  const base = { definition_version:version, scope:"session", scope_id:sessionId, comparable:false };
  const trajectoryRef=sourceRefs.trajectory??{source_id:"trajectory",source_kind:"trajectory",locator:null,raw_type:"message",rule_version:version};
  const collectorRef=sourceRefs.collector??{source_id:"client-observations",source_kind:"cdp",locator:null,raw_type:"client-observation",rule_version:version};
  const metric=(name,value,opts={})=>makeMetricResult(name,value,{...base,evidence_grade:value==null?"unknown":"direct",source_refs:value==null?[]:/^(client_|stream_|collector_|human_|task_)/.test(name)?[collectorRef]:/^tool_|^event_count_tool|^failures_tool/.test(name)&&records.length?[trajectoryRef,collectorRef]:[trajectoryRef],...opts});
  const missing=(name,reason="not_instrumented",unit=null)=>metric(name,null,{missing_reason:reason,unit});
  const count=(name,value,profile,eligible=trajectory.stats.raw_records)=>metric(name,source?value:null,{state:source?(incomplete?"partial":"captured"):"not-captured",missing_reason:source?(incomplete?"partial_capture":null):"source_unavailable",semantic_profile:profile,coverage:{eligible,observed:source?value:0,finished:source?value:0}});
  const answered=tools.filter(c=>c.result_count>0).length;
  const orphanResults=(collector.trajectory_orphan_results??trajectory.stats.orphan_results)+(collector.orphan_results??0);
  const known=tools.filter(c=>["ok","error","cancelled"].includes(c.status));
  const errors=known.filter(c=>c.status==="error").length,ok=known.filter(c=>c.status==="ok").length;
  const result=[
    count("assistant_message_count",trajectory.stats.assistant_count,"trajectory_assistant_messages"),
    count("tool_call_count",tools.length,"unique_tool_call_ids",tools.length),
    count("tool_result_count",answered+orphanResults,"unique_tool_result_ids"),
    count("tool_unresolved_count",tools.length-answered,"calls_without_observed_result",tools.length),
    count("tool_orphan_result_count",orphanResults,"results_without_observed_call"),
    count("tool_duplicate_call_count",trajectory.stats.duplicate_calls+(collector.duplicate_calls??0),"duplicate_call_id_records"),
    count("tool_duplicate_result_count",trajectory.stats.duplicate_results+(collector.duplicate_results??0),"duplicate_result_id_records"),
    count("tool_type_count",new Set(tools.map(c=>c.tool_name).filter(Boolean)).size,"distinct_tool_names"),
    count("agent_observed_count",trajectory.stats.agent_count,"agents_with_readable_trajectory"),
    count("event_count_agent_input",trajectory.stats.user_count,"trajectory_user_messages"),
    count("event_count_llm_response",trajectory.stats.assistant_count,"trajectory_assistant_messages"),
    count("event_count_tool_call",tools.length,"unique_tool_call_ids"),
    count("event_count_tool_result",trajectory.stats.result_records,"trajectory_tool_result_records"),
    count("source_parse_error_count",trajectory.stats.parse_errors,"complete_malformed_records"),
    count("source_partial_line_count",trajectory.stats.partial_lines,"incomplete_tail_records"),
    metric("tool_terminal_coverage",source&&tools.length?known.length/tools.length:null,{unit:"ratio",evidence_grade:"derived",missing_reason:tools.length?null:"zero_denominator",numerator:known.length,denominator:tools.length,semantic_profile:"explicit_tool_terminal_fraction"}),
    metric("tool_success_rate",ok+errors?ok/(ok+errors):null,{unit:"ratio",evidence_grade:"derived",state:ok+errors?(known.length<tools.length||incomplete?"partial":"captured"):"not-captured",missing_reason:ok+errors?(known.length<tools.length||incomplete?"partial_capture":null):"zero_denominator",numerator:ok,denominator:ok+errors,coverage:{eligible:tools.length,observed:known.length,finished:ok+errors},semantic_profile:"explicit_tool_outcomes"}),
    metric("tool_error_count",errors||source&&!incomplete&&known.length===tools.length?errors:null,{state:errors&&(known.length<tools.length||incomplete)?"partial":undefined,missing_reason:known.length<tools.length||incomplete?"partial_capture":null,coverage:{eligible:tools.length,observed:known.length,finished:known.length}}),
    metric("source_freshness_ms",trajectory.stats.updated_at==null?null:Math.max(0,asOf-trajectory.stats.updated_at),{unit:"ms",evidence_grade:"derived",semantic_profile:"since_latest_file_write"}),
    ...["llm_call_count","llm_error_count","llm_retry_count","success_rate","step_count","human_confirm_count","token_input","token_output","token_cache_read","token_reasoning","token_total","cache_hit_rate","max_context","context_window","credits","compaction_count","compaction_threshold","event_count_llm_request","dependency_error_count","agent_error_count","failures_gateway","failures_model","failures_dependency","failures_agent"].map(n=>missing(n,"semantic_unknown")),
    ...["turn_e2e_ms","session_lifespan_ms","session_first_response_ms","llm_attempt_ttft_ms"].map(n=>missing(n,"missing_start","ms")),
  ];
  if(trajectory.llm_calls.length)result.find(m=>m.metric==="llm_call_count").value=trajectory.llm_calls.length;
  if(trajectory.llm_calls.length)Object.assign(result.find(m=>m.metric==="llm_call_count"),{state:"partial",evidence_grade:"direct",missing_reason:"partial_capture",semantic_profile:"explicit_logical_call_ids",source_refs:[trajectoryRef]});
  result.push(metric("failures_tool",errors||known.length===tools.length&&source&&!incomplete?errors:null,{missing_reason:known.length<tools.length||incomplete?"partial_capture":null,state:errors&&(known.length<tools.length||incomplete)?"partial":undefined}));

  const byRequest=new Map();
  for(const r of records){if(!r.request_id)continue;if(!byRequest.has(r.request_id))byRequest.set(r.request_id,[]);byRequest.get(r.request_id).push(r);}
  const requests=[...byRequest.values()].filter(rs=>rs.some(r=>r.event_type==="client.request"));
  const samples={client_headers_ms:[],client_first_text_ms:[],client_stream_ms:[],client_reply_e2e_ms:[],stream_max_pause_ms:[],stream_output_chars:[],stream_output_chars_per_second:[]};
  let chunkCount=0,networkErrors=0,cancelled=0,gaps=0;
  for(const rs of requests){
    const start=rs.find(r=>r.event_type==="client.request"),headers=rs.find(r=>r.event_type==="client.headers"),end=rs.find(r=>r.event_type==="client.end"),reply=rs.find(r=>r.event_type==="reply.end");
    const texts=rs.filter(r=>r.event_type==="stream.text");chunkCount+=texts.length;
    if(end?.status==="error")networkErrors++;if(end?.status==="cancelled")cancelled++;
    if(rs.some(r=>r.event_type==="capture.gap")||end?.parse_errors>0)gaps++;
    const delta=(a,b)=>Number.isFinite(a?.occurred_at)&&Number.isFinite(b?.occurred_at)&&b.occurred_at>=a.occurred_at?b.occurred_at-a.occurred_at:null;
    for(const [name,pair]of [["client_headers_ms",[start,headers]],["client_first_text_ms",[start,texts[0]]],["client_stream_ms",[start,end]],["client_reply_e2e_ms",[start,reply]]]){const d=delta(...pair);if(d!=null)samples[name].push(d);}
    const pauses=[];for(let i=1;i<texts.length;i++){const d=delta(texts[i-1],texts[i]);if(d!=null)pauses.push(d);}
    if(pauses.length)samples.stream_max_pause_ms.push(Math.max(...pauses));
    // Latest absolute character counts per message prevent snapshot/delta double counting.
    const lengths=new Map();for(const t of texts)if(Number.isInteger(t.text_chars))lengths.set(t.message_id??"response",t.text_chars);
    const chars=[...lengths.values()].reduce((s,n)=>s+n,0);if(texts.length)samples.stream_output_chars.push(chars);
    const duration=delta(texts[0],texts.at(-1));if(duration>0&&texts.length)samples.stream_output_chars_per_second.push(chars/(duration/1000));
  }
  for(const [name,values]of Object.entries(samples)){
    const unit=name==="stream_output_chars"?"chars":name.endsWith("per_second")?"chars/s":"ms";
    result.push(metric(name,values.length?values.reduce((s,v)=>s+v,0)/values.length:null,{unit,evidence_grade:"derived",state:values.length?(values.length<requests.length||gaps?"partial":"captured"):"not-captured",missing_reason:values.length?(values.length<requests.length||gaps?"partial_capture":null):records.length?"missing_end":"unbound",semantic_profile:`mean_observed_${name}`,coverage:{eligible:requests.length,observed:values.length,finished:values.length}}));
  }
  for(const [name,value]of [["client_request_count",requests.length],["stream_chunk_count",chunkCount],["client_network_error_count",networkErrors],["client_cancelled_count",cancelled],["collector_gap_count",gaps]])result.push(metric(name,requests.length?value:null,{state:requests.length?"partial":"not-captured",missing_reason:requests.length?"partial_capture":"unbound",semantic_profile:"observed_client_capture_window"}));
  result.push(metric("collector_bound_event_count",records.length||null,{state:records.length?"partial":"not-captured",missing_reason:records.length?"partial_capture":"unbound"}));
  result.push(metric("collector_unbound_event_count",collector.unbound_count??null,{scope:"installation",scope_id:"default",missing_reason:collector.unbound_count==null?"source_unavailable":collector.limited||collector.parse_errors?"partial_capture":null,state:collector.unbound_count==null?"not-captured":collector.limited||collector.parse_errors?"partial":"captured",semantic_profile:"installation_events_without_unique_session_binding"}));

  const human=new Map();
  for(const r of records){if(!r.approval_id)continue;const key=JSON.stringify([r.conversation_id,r.agent_id,r.approval_id]);if(!human.has(key))human.set(key,{});const item=human.get(key);
    if(r.event_type==="human.request" || r.event_type==="tool.call"&&r.ask_human_type){if(!item.request)item.request=r;}
    if(r.event_type==="human.decision"&&["allow","deny","modified"].includes(r.decision)){if(!item.decision)item.decision=r;}
  }
  const waiting=[...human.values()].filter(r=>r.request),decided=waiting.filter(r=>r.decision);const durations=decided.filter(r=>Number.isFinite(r.request.occurred_at)&&Number.isFinite(r.decision.occurred_at)&&r.decision.occurred_at>=r.request.occurred_at).map(r=>r.decision.occurred_at-r.request.occurred_at);
  result.push(metric("human_request_count",waiting.length||null,{state:waiting.length?"partial":"not-captured",missing_reason:waiting.length?"partial_capture":"not_instrumented"}));
  if(decided.length)Object.assign(result.find(m=>m.metric==="human_confirm_count"),{value:decided.length,state:"partial",evidence_grade:"direct",missing_reason:"partial_capture",semantic_profile:"explicit_request_decision_pairs",source_refs:[collectorRef]});
  result.push(metric("human_wait_ms",durations.length?durations.reduce((s,n)=>s+n,0)/durations.length:null,{unit:"ms",evidence_grade:"derived",state:durations.length?"partial":"not-captured",missing_reason:durations.length?"partial_capture":"missing_end",coverage:{eligible:waiting.length,observed:durations.length,finished:durations.length}}));
  result.push(metric("task_completed_observed_count",records.some(r=>r.event_type==="task.status")?records.filter(r=>r.event_type==="task.status"&&r.task_status==="completed").length:null,{state:records.some(r=>r.event_type==="task.status")?"partial":"not-captured",missing_reason:"partial_capture",semantic_profile:"client_task_terminal_events_not_business_success"}));
  return [...result,...computeInfrastructureMetrics(infrastructure,{...base,...(sourceRefs.infrastructure?{source_refs:[sourceRefs.infrastructure]}:{})})];
}

export function computeInfrastructureMetrics(events,opts={}) {
  const metric=(n,value,extra={})=>makeMetricResult(n,value,{definition_version:"metrics-0.3.0",scope:"installation",scope_id:"default",evidence_grade:"derived",comparable:false,source_refs:value==null?[]:[{source_id:"runner-bridge",source_kind:"runner_bridge",locator:null,rule_version:"metrics-0.3.0"}],...opts,...extra});
  const rpa=events.filter(e=>e.event_type==="rpa.runner_completed"),commands=events.filter(e=>e.event_type==="rpa.child_command_finished"),bridge=events.filter(e=>e.event_type==="bridge.event");
  const mean=(name,rs,key,unit="ms")=>{const values=rs.map(r=>r[key]).filter(v=>Number.isFinite(v)&&v>=0);return metric(name,values.length?values.reduce((s,v)=>s+v,0)/values.length:null,{unit,state:values.length?"partial":"not-captured",missing_reason:values.length?"partial_capture":"not_instrumented",coverage:{eligible:rs.length,observed:values.length,finished:values.length}});};
  return [metric("rpa_run_count",rpa.length||null,{state:rpa.length?"partial":"not-captured",missing_reason:rpa.length?"partial_capture":"not_instrumented"}),mean("rpa_run_ms",rpa,"duration_ms"),mean("rpa_command_ms",commands,"duration_ms"),mean("bridge_latency_ms",bridge,"duration_ms"),mean("bridge_execution_ms",bridge,"execution_ms"),mean("bridge_queue_depth",bridge,"queue_depth","count")];
}
