import { BaseAdapter } from "./base-adapter.mjs";
import { resolveAgentConfig } from "../lib/config.mjs";
import { normalizeEvent, normalizeSession, normalizeUsageRecord } from "../lib/normalizer.mjs";
import { makeFieldEvidence, makeDataCompleteness, makeMetricResult, METRIC_DEFINITION_VERSION } from "../lib/evidence.mjs";
import { parseElectronLogLine } from "../lib/log-parser.mjs";
import { redact } from "../lib/redactor.mjs";
import { computeSuccessRate, computeRetryRate, aggregateTokens, computeCacheHitRate, computeOutputTps, computeSessionTurnE2eAvg, computeSessionLifespanMs } from "../lib/metrics.mjs";
import { computeTtftFromAttempts } from "../lib/collector-reader.mjs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const MISSING = ["retry", "human_confirm"]; // ttft 由 trace generation spans 补全

export class WorkBuddyAdapter extends BaseAdapter {
  static agentObject = "workbuddy";
  static adapterVersion = "0.2.0";

  async discover(config) {
    const cfg = resolveAgentConfig("workbuddy");
    const dataDir = cfg.dataDir;
    const checks = {
      projectsDir: false,
      tracesDir: false,
      sessionsDir: false,
      logsDir: false,
      electronLogsDir: false,
    };
    try { await fs.access(path.join(dataDir, "projects")); checks.projectsDir = true; } catch {}
    try { await fs.access(path.join(dataDir, "traces")); checks.tracesDir = true; } catch {}
    try { await fs.access(path.join(dataDir, "sessions")); checks.sessionsDir = true; } catch {}
    try { await fs.access(path.join(dataDir, "logs")); checks.logsDir = true; } catch {}
    try { await fs.access(cfg.electronLogsDir); checks.electronLogsDir = true; } catch {}
    const available = checks.projectsDir || checks.tracesDir;
    return {
      agent_object: "workbuddy",
      installation_id: "default",
      sources: checks,
      available,
      missing_reasons: available ? [] : ["source_unavailable"],
      adapter_version: WorkBuddyAdapter.adapterVersion,
      agent_version: null,
      modes: ["offline"],
    };
  }

  async capabilities(context) {
    const tracesAvailable = await this._hasTraceGenerationSpans();
    const missing = tracesAvailable
      ? ["retry", "human_confirm"] // trace 补全了 ttft
      : ["ttft", "retry", "human_confirm"];
    return {
      has_tokens: true,
      has_ttft: tracesAvailable,
      has_retry: false,
      has_model_routing: true,
      has_event_stream: true,
      has_step: true,
      has_tool_calls: true,
      has_human_confirm: false,
      missing_fields: missing,
      trace_active: tracesAvailable,
      trace_caveat: "TTFT derived from trace generation spans (startedAt→endedAt); non-streaming response so first_output≈response complete",
    };
  }

  async extractSessions(options = {}) {
    const cfg = resolveAgentConfig("workbuddy");
    const sessionsDir = path.join(cfg.dataDir, "sessions");
    const items = [];

    try {
      const files = await fs.readdir(sessionsDir);
      for (const file of files.filter((f) => f.endsWith(".json"))) {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(sessionsDir, file), "utf8"));
          const startedMs = raw.startedAt || null;
          if (options.since && startedMs && startedMs < options.since) continue;
          if (options.until && startedMs && startedMs > options.until) continue;
          items.push(normalizeSession({
            agent_object: "workbuddy",
            session_id: raw.sessionId,
            project_dir: raw.cwd,
            started_at: startedMs ? beijingIso(startedMs) : null,
            model: null,
            agent_name: "workbuddy",
            source_status: "ok",
            data_completeness: makeDataCompleteness(MISSING),
          }));
        } catch {}
      }
    } catch {}

    return { items, nextCursor: null, asOf: Date.now(), coverage: { total: items.length } };
  }

  async extractEvents(sessionId, options = {}) {
    const cfg = resolveAgentConfig("workbuddy");
    const projectsDir = path.join(cfg.dataDir, "projects");
    const events = [];
    for await (const dir of readDirEntries(projectsDir)) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try {
        await fs.access(jsonlPath);
      } catch { continue; }
      const content = await fs.readFile(jsonlPath, "utf8");
      let seq = 0;
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const ev = mapWorkBuddyLine(obj, sessionId, seq++);
          if (ev) events.push(normalizeEvent(ev));
        } catch {}
      }
      break;
    }
    return events;
  }

  async extractUsage(sessionId, options = {}) {
    const cfg = resolveAgentConfig("workbuddy");
    const projectsDir = path.join(cfg.dataDir, "projects");
    const records = [];
    for await (const dir of readDirEntries(projectsDir)) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try {
        await fs.access(jsonlPath);
      } catch { continue; }
      const content = await fs.readFile(jsonlPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const raw = obj?.providerData?.rawUsage;
          if (!raw) continue;
          records.push(normalizeUsageRecord({
            usage_record_id: obj.providerData?.messageId || `wb_${records.length}`,
            scope: "llm_call",
            scope_id: obj.providerData?.messageId || null,
            input: raw.prompt_tokens,
            output: raw.completion_tokens,
            reasoning: raw.completion_thinking_tokens,
            cache_read: raw.prompt_cache_hit_tokens,
            cache_write: raw.prompt_cache_write_tokens || 0,
            reported_total: raw.total_tokens,
            credits: raw.credit,
            input_includes_cache: true,
            output_includes_reasoning: true,
          }));
        } catch {}
      }
      break;
    }
    return records;
  }

  async extractCalls(sessionId, options = {}) {
    const cfg = resolveAgentConfig("workbuddy");
    const projectsDir = path.join(cfg.dataDir, "projects");
    const tracesDir = path.join(cfg.dataDir, "traces");
    const llmCalls = [];
    const toolCalls = [];

    for await (const dir of readDirEntries(projectsDir)) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try { await fs.access(jsonlPath); } catch { continue; }

      const content = await fs.readFile(jsonlPath, "utf8");
      const lines = [];
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try { lines.push(JSON.parse(t)); } catch {}
      }

      const callByMsgId = new Map();

      for (const obj of lines) {
        const pd = obj.providerData || {};
        const ts = obj.timestamp;
        const msgId = pd.messageId;

        if (obj.type === "reasoning" && msgId) {
          if (!callByMsgId.has(msgId)) {
            callByMsgId.set(msgId, {
              llm_call_id: msgId,
              session_id: sessionId,
              agent_object: "workbuddy",
              requested_model: pd.model || null,
              routed_model: pd.model || null,
              provider: null,
              requested_at: ts,
              first_output_at: ts,
              generation_ended_at: null,
              status: "running",
              usage_record_ids: [],
            });
          } else {
            const c = callByMsgId.get(msgId);
            if (c.first_output_at === c.requested_at) c.first_output_at = ts;
          }
        }

        if (obj.type === "function_call" && msgId) {
          if (!callByMsgId.has(msgId)) {
            callByMsgId.set(msgId, {
              llm_call_id: msgId,
              session_id: sessionId,
              agent_object: "workbuddy",
              requested_model: pd.model || null,
              routed_model: pd.model || null,
              provider: null,
              requested_at: ts,
              first_output_at: ts,
              generation_ended_at: null,
              status: "running",
              usage_record_ids: [],
            });
          } else {
            const c = callByMsgId.get(msgId);
            c.generation_ended_at = ts;
          }

          if (obj.callId) {
            toolCalls.push({
              call_id: obj.callId,
              session_id: sessionId,
              agent_object: "workbuddy",
              tool_name: obj.name || null,
              started_at: ts,
              ended_at: null,
              status: "running",
              exit_code: null,
              llm_call_id: msgId,
            });
          }
        }

        if (obj.type === "function_call_result" && obj.callId) {
          const tc = toolCalls.find((t) => t.call_id === obj.callId && t.status === "running");
          if (tc) {
            tc.ended_at = ts;
            tc.status = obj.status === "completed" ? "ok" : (obj.status === "error" ? "error" : "unknown");
            const rawResp = pd?.rawResponse || obj?.output?.rawResponse;
            if (rawResp?.exitCode != null) tc.exit_code = rawResp.exitCode;
          }

          if (msgId) {
            const c = callByMsgId.get(msgId);
            if (c) {
              c.generation_ended_at = ts;
              c.status = "ok";
              if (pd.rawUsage) c.usage_record_ids.push(msgId);
            }
          }
        }

        if (obj.type === "message" && obj.role === "assistant" && msgId) {
          const c = callByMsgId.get(msgId);
          if (c) {
            c.generation_ended_at = ts;
            c.status = "ok";
          } else {
            callByMsgId.set(msgId, {
              llm_call_id: msgId,
              session_id: sessionId,
              agent_object: "workbuddy",
              requested_model: pd.model || null,
              routed_model: pd.model || null,
              provider: null,
              requested_at: ts,
              first_output_at: ts,
              generation_ended_at: ts,
              status: "ok",
              usage_record_ids: [],
            });
          }
        }
      }

      for (const c of callByMsgId.values()) {
        llmCalls.push(c);
      }
      break;
    }

    let traceDuration = null;
    try {
      const traceDirs = await readDirEntries(tracesDir);
      for (const pid of traceDirs) {
        const traceDir = path.join(tracesDir, pid);
        const traceFiles = await fs.readdir(traceDir).catch(() => []);
        for (const tf of traceFiles) {
          if (!tf.startsWith("trace_") || !tf.endsWith(".json")) continue;
          try {
            const raw = JSON.parse(await fs.readFile(path.join(traceDir, tf), "utf8"));
            const trace = raw.trace || {};
            const spans = raw.spans || [];
            const agentSpans = spans.filter((s) => s.type === "agent");
            for (const s of agentSpans) {
              if (traceDuration == null || (s.duration > traceDuration)) traceDuration = s.duration;
            }
          } catch {}
        }
      }
    } catch {}

    return {
      llm_calls: llmCalls,
      tool_calls: toolCalls,
      trace_duration_ms: traceDuration,
    };
  }

  async extractMetrics(sessionId, options = {}) {
    const usage = await this.extractUsage(sessionId);
    const calls = await this.extractCalls(sessionId, options);
    const tokens = aggregateTokens(usage);

    // trace generation spans → attempt 对象 → computeTtftFromAttempts
    // 无 trace 数据时回退 not_instrumented（不抛错）
    const genSpans = await this._readGenerationSpans(sessionId);
    const traceAttempts = this._generationSpansToAttempts(genSpans, sessionId);
    const traceActive = traceAttempts.length > 0;

    const llmCalls = calls.llm_calls || [];
    const toolCalls = calls.tool_calls || [];
    const llmOk = llmCalls.filter((c) => c.status === "ok").length;
    const llmError = llmCalls.filter((c) => c.status === "error").length;
    const toolOk = toolCalls.filter((c) => c.status === "ok").length;
    const toolError = toolCalls.filter((c) => c.status === "error").length;

    const hasTranscript = await this._hasTranscript(sessionId);
    const countMetric = (metric, value, opts = {}) =>
      hasTranscript
        ? makeMetricResult(metric, value, { scope: "session", scope_id: sessionId, evidence_grade: "direct", ...opts })
        : makeMetricResult(metric, null, {
            scope: "session", scope_id: sessionId, evidence_grade: "unknown",
            state: "not-captured", missing_reason: "source_unavailable", ...opts,
          });

    const reasoningCount = await this._countTranscriptTypes(sessionId, ["reasoning"]);
    const funcCallCount = toolCalls.length;
    const funcResultCount = await this._countTranscriptTypes(sessionId, ["function_call_result"]);
    const userMsgCount = await this._countTranscriptTypes(sessionId, ["message"], "user");
    const assistantMsgCount = await this._countTranscriptTypes(sessionId, ["message"], "assistant");

    const turns = await this._getTurns(sessionId);
    const turnE2e = computeSessionTurnE2eAvg(turns);
    turnE2e.scope_id = sessionId;
    if (!hasTranscript && turnE2e.state === "not-captured") {
      turnE2e.missing_reason = "source_unavailable";
    }
    const transcriptRange = await this._getTranscriptTimeRange(sessionId);
    const lifespan = computeSessionLifespanMs(transcriptRange.first, transcriptRange.last);
    lifespan.scope_id = sessionId;
    if (!hasTranscript && lifespan.state === "not-captured") {
      lifespan.missing_reason = "source_unavailable";
    }

    const generationMs = llmCalls
      .filter((c) => c.requested_at && c.generation_ended_at)
      .reduce((s, c) => s + (c.generation_ended_at - c.requested_at), 0);

    return [
      turnE2e,
      lifespan,
      makeMetricResult("token_input", tokens.input || null, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("token_output", tokens.output || null, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("token_cache_read", tokens.cache_read || null, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("token_reasoning", tokens.reasoning || null, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("token_total", (tokens.input || 0) + (tokens.output || 0) || null, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived",
        semantic_profile: "input_plus_output",
      }),
      makeMetricResult("credits", tokens.credits || null, {
        unit: "credits", scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      countMetric("llm_call_count", llmCalls.length),
      computeSuccessRate(llmOk, llmError),
      countMetric("tool_call_count", toolCalls.length),
      computeSuccessRate(toolOk, toolError),
      computeCacheHitRate(usage),
      computeOutputTps(tokens.output, generationMs),
      countMetric("step_count", reasoningCount + funcCallCount + funcResultCount, {
        semantic_profile: "reasoning_plus_action_plus_observation",
      }),
      countMetric("event_count_llm_request", llmCalls.length),
      countMetric("event_count_llm_response", assistantMsgCount),
      countMetric("event_count_tool_call", funcCallCount),
      countMetric("event_count_tool_result", funcResultCount),
      countMetric("event_count_agent_input", userMsgCount),
      // TTFT：优先用 trace generation spans（startedAt→endedAt），无则回退 not_instrumented。
      traceActive
        ? computeTtftFromAttempts(traceAttempts, sessionId)
        : makeMetricResult("llm_attempt_ttft_ms", null, {
            unit: "ms", scope: "session", scope_id: sessionId,
            state: "not-captured", missing_reason: "not_instrumented",
            evidence_grade: "unknown",
          }),
      makeMetricResult("llm_retry_count", null, {
        scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      makeMetricResult("human_confirm_count", null, {
        scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      makeMetricResult("max_context", usage.length > 0 ? Math.max(...usage.map((r) => (r.input || 0) + (r.output || 0))) : null, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived",
        semantic_profile: "peak_input_plus_output",
      }),
      makeMetricResult("context_window", null, {
        unit: "tokens", scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
    ];
  }

  async extractTimeline(sessionId) {
    const cfg = resolveAgentConfig("workbuddy");
    const projectsDir = path.join(cfg.dataDir, "projects");
    const points = [];
    let cumInput = 0, cumOutput = 0, cumCacheRead = 0;
    let turn = 0;

    for await (const dir of readDirEntries(projectsDir)) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try { await fs.access(jsonlPath); } catch { continue; }
      const content = await fs.readFile(jsonlPath, "utf8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.type === "message" && obj.role === "user") turn++;
          const ru = obj.providerData?.rawUsage;
          if (ru && obj.timestamp != null) {
            const input = ru.prompt_tokens || 0;
            const output = ru.completion_tokens || 0;
            const cacheRead = ru.prompt_cache_hit_tokens || 0;
            cumInput += input;
            cumOutput += output;
            cumCacheRead += cacheRead;
            points.push({
              seq: points.length + 1, turn,
              time: obj.timestamp,
              input, output, cache_read: cacheRead,
              cumulative_input: cumInput,
              cumulative_output: cumOutput,
              cumulative_cache_read: cumCacheRead,
              cumulative_total: cumInput + cumOutput + cumCacheRead,
            });
          }
        } catch {}
      }
      break;
    }
    return points;
  }

  async _countTranscriptTypes(sessionId, types, role = null) {
    const cfg = resolveAgentConfig("workbuddy");
    const projectsDir = path.join(cfg.dataDir, "projects");
    let count = 0;
    for await (const dir of readDirEntries(projectsDir)) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try { await fs.access(jsonlPath); } catch { continue; }
      const content = await fs.readFile(jsonlPath, "utf8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (types.includes(obj.type) && (!role || obj.role === role)) count++;
        } catch {}
      }
      break;
    }
    return count;
  }

  async _getTurns(sessionId) {
    const cfg = resolveAgentConfig("workbuddy");
    const projectsDir = path.join(cfg.dataDir, "projects");
    const lines = [];
    for await (const dir of readDirEntries(projectsDir)) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try { await fs.access(jsonlPath); } catch { continue; }
      const content = await fs.readFile(jsonlPath, "utf8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t);
          if (o.timestamp != null) lines.push(o);
        } catch {}
      }
      break;
    }

    const turns = [];
    let submittedAt = null;
    let execEnd = null;
    const closeTurn = () => {
      if (submittedAt != null) {
        turns.push({ submitted_at: submittedAt, execution_ended_at: execEnd });
      }
    };
    for (const o of lines) {
      const isUser = o.type === "message" && o.role === "user";
      const isExec = (o.type === "message" && o.role !== "user")
        || o.type === "function_call" || o.type === "function_call_result" || o.type === "reasoning";
      if (isUser) {
        closeTurn();
        submittedAt = o.timestamp;
        execEnd = null;
      } else if (isExec && submittedAt != null) {
        if (execEnd == null || o.timestamp > execEnd) execEnd = o.timestamp;
      }
    }
    closeTurn();
    return turns;
  }

  async _hasTranscript(sessionId) {
    const cfg = resolveAgentConfig("workbuddy");
    const projectsDir = path.join(cfg.dataDir, "projects");
    for await (const dir of readDirEntries(projectsDir)) {
      try {
        await fs.access(path.join(projectsDir, dir, `${sessionId}.jsonl`));
        return true;
      } catch {}
    }
    return false;
  }

  // ── trace generation span 读取（P2：trace 直读 TTFT）──
  // WorkBuddy traces/<pid>/trace_*.json 含 generation 类型 span，每条带
  // startedAt/endedAt（ISO string）/duration（ms）/status。trace.sessionId
  // 可直接关联 session。非流式响应：first_output ≈ response complete = endedAt。
  // dataDir 动态读 env var（AGENT_LOG_WORKBUDDY_DATADIR），便于测试覆盖。
  _wbDataDir() {
    return process.env.AGENT_LOG_WORKBUDDY_DATADIR
      || path.join(os.homedir(), ".workbuddy");
  }

  async _findTraceFile(sessionId) {
    const tracesDir = path.join(this._wbDataDir(), "traces");
    try {
      for await (const pid of readDirEntries(tracesDir)) {
        const traceDir = path.join(tracesDir, pid);
        const files = await fs.readdir(traceDir).catch(() => []);
        for (const tf of files) {
          if (!tf.startsWith("trace_") || !tf.endsWith(".json")) continue;
          try {
            const raw = JSON.parse(await fs.readFile(path.join(traceDir, tf), "utf8"));
            if (raw?.trace?.sessionId === sessionId) return path.join(traceDir, tf);
          } catch {}
        }
      }
    } catch {}
    return null;
  }

  async _readGenerationSpans(sessionId) {
    const traceFile = await this._findTraceFile(sessionId);
    if (!traceFile) return [];
    try {
      const raw = JSON.parse(await fs.readFile(traceFile, "utf8"));
      const spans = raw.spans || [];
      return spans.filter((s) => s.type === "generation" && s.startedAt && s.endedAt);
    } catch {
      return [];
    }
  }

  // 把 generation span 转为 collector-attempt 格式（对齐 computeTTftMs 输入）
  _generationSpansToAttempts(spans, sessionId) {
    return spans.map((s) => {
      const requestedAt = new Date(s.startedAt).getTime();
      const firstOutputAt = new Date(s.endedAt).getTime();
      return {
        schema_version: "collector-attempt-0.1.0",
        agent_object: "workbuddy",
        installation_id: "default",
        session_id: sessionId,
        llm_call_id: s.spanId || null,
        attempt_id: s.spanId || `att_${sessionId}_${requestedAt}`,
        attempt_index: 0,
        is_retry: false,
        retry_of: null,
        requested_at: requestedAt,
        first_output_at: firstOutputAt,
        // 非流式：response complete = first output（标 derived）
        first_output_source: "derived",
        stream_ended_at: firstOutputAt,
        timestamp_basis: "epoch_ms",
        precision_ns: 1,
        provider: null,
        requested_model: null,
        routed_model: null,
        status: s.status === "ok" ? "ok" : (s.status === "error" ? "error" : "unknown"),
        error_kind: s.error ? String(s.error).slice(0, 100) : null,
        http_status: null,
        usage: null,
        human_confirm: null,
        collector: "workbuddy-trace-generation",
        collector_version: "0.1.0",
        collected_at: Date.now(),
      };
    });
  }

  async _hasTraceGenerationSpans() {
    const tracesDir = path.join(this._wbDataDir(), "traces");
    try {
      for await (const pid of readDirEntries(tracesDir)) {
        const traceDir = path.join(tracesDir, pid);
        const files = await fs.readdir(traceDir).catch(() => []);
        for (const tf of files) {
          if (!tf.startsWith("trace_") || !tf.endsWith(".json")) continue;
          try {
            const raw = JSON.parse(await fs.readFile(path.join(traceDir, tf), "utf8"));
            const spans = (raw.spans || []).filter((s) => s.type === "generation");
            if (spans.length > 0) return true;
          } catch {}
        }
      }
    } catch {}
    return false;
  }

  async _getTranscriptTimeRange(sessionId) {
    const cfg = resolveAgentConfig("workbuddy");
    const projectsDir = path.join(cfg.dataDir, "projects");
    let first = null, last = null;
    for await (const dir of readDirEntries(projectsDir)) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try { await fs.access(jsonlPath); } catch { continue; }
      const content = await fs.readFile(jsonlPath, "utf8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.timestamp != null) {
            if (first == null) first = obj.timestamp;
            last = obj.timestamp;
          }
        } catch {}
      }
      break;
    }
    return { first, last };
  }

  async extractFailures(sessionId, options = {}) {
    const cfg = resolveAgentConfig("workbuddy");
    const projectsDir = path.join(cfg.dataDir, "projects");
    const diagnostics = [];
    const summary = { gateway: 0, tool: 0, model: 0, dependency: 0, agent: 0 };

    for await (const dir of readDirEntries(projectsDir)) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try { await fs.access(jsonlPath); } catch { continue; }
      const content = await fs.readFile(jsonlPath, "utf8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          const pd = obj.providerData || {};

          if (obj.type === "function_call_result" && obj.status && obj.status !== "completed") {
            const rawResp = pd.rawResponse || obj.output?.rawResponse;
            const exitCode = rawResp?.exitCode;
            diagnostics.push({
              category: "tool",
              entity: obj.callId || null,
              tool_name: obj.name || null,
              exit_code: exitCode ?? null,
              status: obj.status,
              evidence_grade: "direct",
              rule: "function_call_result.status != completed",
            });
            summary.tool++;
          }

          if (obj.type === "function_call_result" && pd.rawResponse?.exitCode && pd.rawResponse.exitCode !== 0) {
            diagnostics.push({
              category: "tool",
              entity: obj.callId || null,
              tool_name: obj.name || null,
              exit_code: pd.rawResponse.exitCode,
              evidence_grade: "direct",
              rule: "rawResponse.exitCode != 0",
            });
            summary.tool++;
          }

          if (obj.error) {
            const errMsg = typeof obj.error === "string" ? obj.error : (obj.error.message || JSON.stringify(obj.error));
            const isRetryable = obj.error.isRetryable;
            let cat = "model";
            if (/gateway|5\d\d|502|503|timeout|ENOTFOUND|ECONN/.test(errMsg)) cat = "gateway";
            else if (/sidecar|daemon|IPC|ENOENT|dependency/.test(errMsg)) cat = "dependency";
            else if (/agent|cancelled|streaming/.test(errMsg)) cat = "agent";
            diagnostics.push({
              category: cat,
              entity: pd.messageId || null,
              message: errMsg.substring(0, 200),
              is_retryable: isRetryable ?? null,
              evidence_grade: "direct",
              rule: "error field present",
            });
            summary[cat]++;
          }
        } catch {}
      }
      break;
    }

    try {
      const logsDir = path.join(cfg.dataDir, "logs");
      const logFiles = await readDirEntries(logsDir);
      for (const lf of logFiles) {
        if (!lf.endsWith(".log")) continue;
        try {
          const logContent = await fs.readFile(path.join(logsDir, lf), "utf8");
          for (const line of logContent.split("\n")) {
            if (!line.includes('"level":"error"')) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.level !== "error") continue;
              const msg = Array.isArray(obj.message) ? obj.message.join(" ") : String(obj.message || "");
              let cat = "dependency";
              if (/ENOTFOUND|gateway|network|proxy/.test(msg)) cat = "gateway";
              else if (/sidecar|daemon|IPC|ENOENT/.test(msg)) cat = "dependency";
              diagnostics.push({
                category: cat,
                source: lf,
                scope: obj.scope || null,
                message: msg.substring(0, 200),
                evidence_grade: "estimated",
                rule: "electron log level=error",
              });
              summary[cat]++;
            } catch {}
          }
        } catch {}
      }
    } catch {}

    const sourceAvailable = diagnostics.length > 0 || (await this._hasTranscript(sessionId));
    return { diagnostics, summary, source_available: sourceAvailable };
  }
}

function beijingIso(epochMs) {
  const instant = new Date(epochMs);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const ms = String(instant.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}+08:00`;
}

function mapWorkBuddyLine(obj, sessionId, seq) {
  const ts = obj.timestamp;
  const tsIso = ts ? beijingIso(ts) : null;
  const pd = obj.providerData || {};
  switch (obj.type) {
    case "message":
      if (obj.role === "user") {
        return { event_category: "agent.input", event_type_raw: "message.user", occurred_at: tsIso, source_seq: seq, session_id: sessionId, agent_object: "workbuddy" };
      }
      if (obj.role === "assistant") {
        return { event_category: "llm.response", event_type_raw: "message.assistant", occurred_at: tsIso, source_seq: seq, session_id: sessionId, agent_object: "workbuddy", requested_model: pd.model, routed_model: pd.model, message_id: pd.messageId, trace_id: pd.traceId };
      }
      return null;
    case "reasoning":
      return { event_category: "step.start", event_subtype: "reasoning", event_type_raw: "reasoning", occurred_at: tsIso, source_seq: seq, session_id: sessionId, agent_object: "workbuddy", message_id: pd.messageId, trace_id: pd.traceId };
    case "function_call":
      return { event_category: "tool.call", event_type_raw: "function_call", occurred_at: tsIso, source_seq: seq, session_id: sessionId, agent_object: "workbuddy", tool_name: obj.name, call_id: obj.callId, requested_model: pd.model, message_id: pd.messageId, trace_id: pd.traceId };
    case "function_call_result":
      return { event_category: "tool.result", event_type_raw: "function_call_result", occurred_at: tsIso, source_seq: seq, session_id: sessionId, agent_object: "workbuddy", tool_name: obj.name, call_id: obj.callId, status: obj.status || "unknown" };
    default:
      return { event_category: "other", event_type_raw: obj.type || "unknown", occurred_at: tsIso, source_seq: seq, session_id: sessionId, agent_object: "workbuddy" };
  }
}

async function* readDirEntries(dir) {
  try {
    const entries = await fs.readdir(dir);
    for (const entry of entries) yield entry;
  } catch {}
}
