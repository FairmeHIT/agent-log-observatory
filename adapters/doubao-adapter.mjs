import { BaseAdapter } from "./base-adapter.mjs";
import { resolveAgentConfig } from "../lib/config.mjs";
import { normalizeEvent, normalizeSession } from "../lib/normalizer.mjs";
import { makeDataCompleteness, makeMetricResult } from "../lib/evidence.mjs";
import { computeSuccessRate } from "../lib/metrics.mjs";
import { getFileObservations } from "../lib/observatory-db.mjs";
import {
  readAttempts, hasCollectorData, readAllAttempts, filterByTimeWindow,
  computeTtftFromAttempts, computeRetryFromAttempts,
} from "../lib/collector-reader.mjs";
import path from "node:path";
import fs from "node:fs/promises";

const MISSING = ["tokens", "ttft", "model"];

export class DoubaoAdapter extends BaseAdapter {
  static agentObject = "doubao";
  static adapterVersion = "0.2.0";

  async discover(config) {
    const cfg = resolveAgentConfig("doubao");
    const checks = { trajectory: false, rpaTraces: false, bridgeLog: false };
    try {
      const sessions = await fs.readdir(cfg.sessionsRoot);
      for (const s of sessions) {
        const trajDir = path.join(cfg.sessionsRoot, s, "agents");
        const agents = await readDirSafe(trajDir);
        for (const a of agents) {
          try {
            await fs.access(path.join(trajDir, a, "system", "trajectory.jsonl"));
            checks.trajectory = true; break;
          } catch {}
        }
        if (checks.trajectory) break;
    } } catch {}
    try { await fs.access(path.join(cfg.rpaDevDir, "local-preview", "production-traces")); checks.rpaTraces = true; } catch {}
    try { await fs.access(path.join(cfg.rpaDevDir, "local-preview", "bridge.log")); checks.bridgeLog = true; } catch {}
    return {
      agent_object: "doubao",
      installation_id: "default",
      sources: checks,
      available: checks.trajectory || checks.rpaTraces,
      missing_reasons: [],
      adapter_version: DoubaoAdapter.adapterVersion,
      modes: ["offline"],
    };
  }

  async capabilities(context) {
    const collectorActive = await hasCollectorData("doubao");
    return {
      has_tokens: collectorActive, has_ttft: collectorActive, has_retry: collectorActive,
      has_model_routing: false, has_event_stream: true,
      has_step: true, has_tool_calls: true, has_human_confirm: true,
      missing_fields: collectorActive ? ["model"] : MISSING,
      collector_active: collectorActive,
    };
  }

  async extractSessions(options = {}) {
    const cfg = resolveAgentConfig("doubao");
    const items = [];
    try {
      const sessions = await fs.readdir(cfg.sessionsRoot);
      for (const sessionId of sessions) {
        const sessionDir = path.join(cfg.sessionsRoot, sessionId);
        const stat = await fs.stat(sessionDir).catch(() => null);
        if (!stat || !stat.isDirectory()) continue;
        const mtimeMs = stat.mtimeMs;
        if (options.since && mtimeMs < options.since) continue;
        if (options.until && mtimeMs > options.until) continue;
        items.push(normalizeSession({
          agent_object: "doubao",
          session_id: sessionId,
          started_at: epochToBeijing(mtimeMs),
          source_status: "ok",
          data_completeness: makeDataCompleteness(MISSING),
        }));
      }
    } catch {}
    return { items, nextCursor: null, asOf: Date.now(), coverage: { total: items.length } };
  }

  // trajectory.jsonl 无 token 字段；CDP SSE 响应体也无 usage → 返回空数组（不抛错）
  // 注：BaseAdapter.extractUsage 默认抛 "not implemented"，若不覆盖会令 syncAgentData 的
  // Promise.all 整体 reject，被内层 catch 吞掉，导致 doubao session_metrics 恒为 0 行。
  async extractUsage(sessionId, options = {}) {
    return [];
  }

  async extractEvents(sessionId, options = {}) {
    const cfg = resolveAgentConfig("doubao");
    const events = [];
    const agentsDir = path.join(cfg.sessionsRoot, sessionId, "agents");
    const agents = await readDirSafe(agentsDir);
    for (const agentId of agents) {
      const trajPath = path.join(agentsDir, agentId, "system", "trajectory.jsonl");
      try {
        await fs.access(trajPath);
      } catch { continue; }
      const content = await fs.readFile(trajPath, "utf8");
      let seq = 0;
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const ev = mapDoubaoTrajectory(obj, sessionId, agentId, seq++);
          if (ev) events.push(normalizeEvent(ev));
        } catch {}
      }
    }
    return events;
  }

  async extractCalls(sessionId, options = {}) {
    const cfg = resolveAgentConfig("doubao");
    const llmCalls = [];
    const toolCalls = [];
    const agentsDir = path.join(cfg.sessionsRoot, sessionId, "agents");
    const agents = await readDirSafe(agentsDir);
    let seq = 0;

    for (const agentId of agents) {
      const trajPath = path.join(agentsDir, agentId, "system", "trajectory.jsonl");
      try { await fs.access(trajPath); } catch { continue; }
      const content = await fs.readFile(trajPath, "utf8");
      let lineIdx = 0;
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.role === "assistant") {
            const callId = `doubao_llm_${sessionId}_${lineIdx}`;
            llmCalls.push({
              llm_call_id: callId,
              session_id: sessionId,
              agent_object: "doubao",
              requested_model: null,
              routed_model: null,
              provider: null,
              requested_at: null,
              first_output_at: null,
              generation_ended_at: null,
              status: "ok",
              usage_record_ids: [],
            });
            if (obj.tool_calls) {
              for (const tc of obj.tool_calls) {
                toolCalls.push({
                  call_id: tc.id || `doubao_tool_${toolCalls.length}`,
                  session_id: sessionId,
                  agent_object: "doubao",
                  tool_name: tc.function?.name || null,
                  started_at: null,
                  ended_at: null,
                  status: "running",
                  exit_code: null,
                  llm_call_id: callId,
                });
              }
            }
          }
          if (obj.role === "tool") {
            const tc = toolCalls.find((t2) => t2.call_id === obj.tool_call_id && t2.status === "running");
            if (tc) {
              tc.status = (obj.content || "").includes("error") || (obj.content || "").includes("Error") ? "error" : "ok";
            }
          }
          lineIdx++;
        } catch {}
      }
    }
    return { llm_calls: llmCalls, tool_calls: toolCalls };
  }

  async extractFailures(sessionId, options = {}) {
    const cfg = resolveAgentConfig("doubao");
    const diagnostics = [];
    const summary = { gateway: 0, tool: 0, model: 0, dependency: 0, agent: 0 };

    // 仅扫描 session 级 trajectory.jsonl。bridge.log 和 production-traces/
    // runner-events.ndjson 是全局文件（非 session 维度），在 per-session
    // extractFailures 中读取会导致 N 倍重复计数（compare 取 sum）。
    // 这些全局 RPA 基础设施错误（snapshot relay 失败）不归属到具体 session。
    const agentsDir = path.join(cfg.sessionsRoot, sessionId, "agents");
    const agents = await readDirSafe(agentsDir);
    for (const agentId of agents) {
      const trajPath = path.join(agentsDir, agentId, "system", "trajectory.jsonl");
      try { await fs.access(trajPath); } catch { continue; }
      const content = await fs.readFile(trajPath, "utf8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.role === "tool") {
            const c = (obj.content || "").toLowerCase();
            if (c.includes("error") || c.includes("exit code") && !c.includes("exit code: 0")) {
              const exitMatch = c.match(/exit code[:\s]*(\d+)/);
              const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
              diagnostics.push({
                category: "tool",
                entity: obj.tool_call_id || null,
                exit_code: exitCode,
                evidence_grade: "direct",
                rule: "trajectory tool content contains error",
              });
              summary.tool++;
            }
          }
        } catch {}
      }
    }

    return { diagnostics, summary };
  }

  async extractMetrics(sessionId, options = {}) {
    const calls = await this.extractCalls(sessionId, options);
    const llmCalls = calls.llm_calls || [];
    const toolCalls = calls.tool_calls || [];
    const llmOk = toolCalls.filter((c) => c.status === "ok").length;
    const toolOk = toolCalls.filter((c) => c.status === "ok").length;
    const toolError = toolCalls.filter((c) => c.status === "error").length;

    const events = await this.extractEvents(sessionId);
    const userCount = events.filter((e) => e.event_category === "agent.input").length;
    const assistantCount = llmCalls.length;
    const humanConfirms = events.filter((e) => e.event_subtype === "human_confirm").length;
    const stepCount = Math.min(llmCalls.length, toolCalls.length) + Math.abs(llmCalls.length - toolCalls.length);

    // Collector data (CDP): TTFT / retry / token usage
    // Session ID spaces differ (conversation_id vs trajectory dir) → use time-window filtering
    let collectorAttempts = [];
    try {
      // Get session time window from trajectory file ctime/mtime
      const cfg = resolveAgentConfig("doubao");
      const agentsDir = path.join(cfg.sessionsRoot, sessionId, "agents");
      let since = null, until = null;
      try {
        const agentIds = await fs.readdir(agentsDir);
        for (const agentId of agentIds) {
          const trajPath = path.join(agentsDir, agentId, "system", "trajectory.jsonl");
          try {
            const st = await fs.stat(trajPath);
            if (st.birthtimeMs) since = since == null ? st.birthtimeMs : Math.min(since, st.birthtimeMs);
            until = until == null ? st.mtimeMs : Math.max(until, st.mtimeMs);
          } catch {}
        }
      } catch {}
      if (since != null && until != null && until >= since) {
        collectorAttempts = filterByTimeWindow(await readAllAttempts("doubao"), since, until);
      } else {
        collectorAttempts = await readAllAttempts("doubao");
      }
    } catch {}
    const collectorActive = collectorAttempts.length > 0;

    // Aggregate token usage from collector attempts
    let tokenInput = null, tokenOutput = null, tokenTotal = null, tokenCacheRead = null;
    if (collectorActive) {
      const withUsage = collectorAttempts.filter((a) => a.usage && (a.usage.input != null || a.usage.output != null));
      if (withUsage.length > 0) {
        tokenInput = withUsage.reduce((s, a) => s + (a.usage.input || 0), 0);
        tokenOutput = withUsage.reduce((s, a) => s + (a.usage.output || 0), 0);
        tokenCacheRead = withUsage.reduce((s, a) => s + (a.usage.cache_read || 0), 0);
        tokenTotal = tokenInput + tokenOutput;
      }
    }

    // Derive turn_e2e_ms and session_lifespan_ms from file observations
    let turnE2eMs = null;
    let sessionLifespanMs = null;
    try {
      const obs = getFileObservations("doubao", sessionId);
      if (obs.length >= 2) {
        // Group by file, compute per-file intervals
        const byFile = new Map();
        for (const o of obs) {
          if (!byFile.has(o.file_path)) byFile.set(o.file_path, []);
          byFile.get(o.file_path).push(o);
        }
        // session_lifespan = global min → max
        const allTimes = obs.map((o) => o.observed_at);
        sessionLifespanMs = Math.max(...allTimes) - Math.min(...allTimes);
        // turn_e2e = median interval between consecutive line-growth events (across all files)
        const intervals = [];
        for (const points of byFile.values()) {
          for (let i = 1; i < points.length; i++) {
            if (points[i].line_count > points[i - 1].line_count) {
              intervals.push(points[i].observed_at - points[i - 1].observed_at);
            }
          }
        }
        if (intervals.length > 0) {
          intervals.sort((a, b) => a - b);
          turnE2eMs = intervals[Math.floor(intervals.length / 2)];
        }
      } else if (obs.length === 1) {
        sessionLifespanMs = 0; // only one observation, can't compute span
      }
    } catch {}
    // Fallback: file ctime/mtime for session_lifespan if no observations
    if (sessionLifespanMs == null || sessionLifespanMs === 0) {
      try {
        const cfg = resolveAgentConfig("doubao");
        const agentsDir = path.join(cfg.sessionsRoot, sessionId, "agents");
        const agentIds = await fs.readdir(agentsDir);
        let minCtime = Infinity, maxMtime = 0;
        for (const agentId of agentIds) {
          const trajPath = path.join(agentsDir, agentId, "system", "trajectory.jsonl");
          try {
            const st = await fs.stat(trajPath);
            if (st.birthtimeMs) minCtime = Math.min(minCtime, st.birthtimeMs);
            maxMtime = Math.max(maxMtime, st.mtimeMs);
          } catch {}
        }
        if (minCtime !== Infinity && maxMtime > minCtime) {
          sessionLifespanMs = maxMtime - minCtime;
        }
      } catch {}
    }

    return [
      makeMetricResult("llm_call_count", llmCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("tool_call_count", toolCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      computeSuccessRate(toolOk, toolError),
      makeMetricResult("human_confirm_count", humanConfirms, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("step_count", stepCount, { scope: "session", scope_id: sessionId, evidence_grade: "derived", semantic_profile: "assistant_tool_pairs" }),
      makeMetricResult("event_count_agent_input", userCount, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_llm_response", assistantCount, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_tool_call", toolCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_tool_result", toolCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("token_input", tokenInput, {
        scope: "session", scope_id: sessionId,
        state: tokenInput != null ? "captured" : "not-captured",
        missing_reason: tokenInput != null ? null : "not_instrumented",
        evidence_grade: tokenInput != null ? "direct" : "unknown",
      }),
      makeMetricResult("token_output", tokenOutput, {
        scope: "session", scope_id: sessionId,
        state: tokenOutput != null ? "captured" : "not-captured",
        missing_reason: tokenOutput != null ? null : "not_instrumented",
        evidence_grade: tokenOutput != null ? "direct" : "unknown",
      }),
      makeMetricResult("token_total", tokenTotal, {
        scope: "session", scope_id: sessionId,
        state: tokenTotal != null ? "captured" : "not-captured",
        missing_reason: tokenTotal != null ? null : "not_instrumented",
        evidence_grade: tokenTotal != null ? "derived" : "unknown",
      }),
      makeMetricResult("token_cache_read", tokenCacheRead, {
        scope: "session", scope_id: sessionId,
        state: tokenCacheRead != null ? "captured" : "not-captured",
        missing_reason: tokenCacheRead != null ? null : "not_instrumented",
        evidence_grade: tokenCacheRead != null ? "direct" : "unknown",
      }),
      // TTFT: collector first, fallback not_instrumented
      collectorActive
        ? computeTtftFromAttempts(collectorAttempts, sessionId)
        : makeMetricResult("llm_attempt_ttft_ms", null, { unit: "ms", scope: "session", scope_id: sessionId, state: "not-captured", missing_reason: "not_instrumented" }),
      // LLM retry: collector first, fallback not_instrumented
      collectorActive
        ? computeRetryFromAttempts(collectorAttempts, sessionId)
        : makeMetricResult("llm_retry_count", null, { scope: "session", scope_id: sessionId, state: "not-captured", missing_reason: "not_instrumented" }),
      turnE2eMs != null
        ? makeMetricResult("turn_e2e_ms", turnE2eMs, { unit: "ms", scope: "session", scope_id: sessionId, evidence_grade: "derived", semantic_profile: "file_growth_interval_median" })
        : makeMetricResult("turn_e2e_ms", null, { unit: "ms", scope: "session", scope_id: sessionId, state: "not-captured", missing_reason: "not_instrumented" }),
      sessionLifespanMs != null
        ? makeMetricResult("session_lifespan_ms", sessionLifespanMs, { unit: "ms", scope: "session", scope_id: sessionId, evidence_grade: "derived", semantic_profile: "file_observation_span" })
        : makeMetricResult("session_lifespan_ms", null, { unit: "ms", scope: "session", scope_id: sessionId, state: "not-captured", missing_reason: "not_instrumented" }),
      makeMetricResult("credits", null, { scope: "session", scope_id: sessionId, state: "not-captured", missing_reason: "not_instrumented" }),
      makeMetricResult("max_context", null, { unit: "tokens", scope: "session", scope_id: sessionId, state: "not-captured", missing_reason: "not_instrumented" }),
      makeMetricResult("context_window", null, { unit: "tokens", scope: "session", scope_id: sessionId, state: "not-captured", missing_reason: "not_instrumented" }),
    ];
  }
}

function mapDoubaoTrajectory(obj, sessionId, agentId, seq) {
  const role = obj.role;
  if (role === "user") {
    const isConfirm = /^(确认|完成|是|是的|确认完成|去人)$/.test((obj.content || "").trim());
    return {
      agent_object: "doubao", session_id: sessionId,
      event_category: "agent.input",
      event_subtype: isConfirm ? "human_confirm" : null,
      event_type_raw: "trajectory.user",
      source_seq: seq,
      timestamp_basis: "unknown",
      metadata: { agent_id: agentId },
    };
  }
  if (role === "assistant") {
    const toolCalls = obj.tool_calls || [];
    const events = [];
    if (obj.content) {
      events.push({
        agent_object: "doubao", session_id: sessionId,
        event_category: "llm.response",
        event_type_raw: "trajectory.assistant",
        source_seq: seq,
        timestamp_basis: "unknown",
        metadata: { agent_id: agentId },
      });
    }
    for (let i = 0; i < toolCalls.length; i++) {
      events.push({
        agent_object: "doubao", session_id: sessionId,
        event_category: "tool.call",
        event_type_raw: "trajectory.tool_calls",
        source_seq: seq,
        timestamp_basis: "unknown",
        tool_name: toolCalls[i]?.function?.name || null,
        call_id: toolCalls[i]?.id || null,
        metadata: { agent_id: agentId, tool_index: i },
      });
    }
    return events.length === 1 ? events[0] : (events.length > 1 ? events : null);
  }
  if (role === "tool") {
    return {
      agent_object: "doubao", session_id: sessionId,
      event_category: "tool.result",
      event_type_raw: "trajectory.tool",
      source_seq: seq,
      timestamp_basis: "unknown",
      call_id: obj.tool_call_id || null,
      status: (obj.content || "").includes("error") || (obj.content || "").includes("Error") ? "error" : "ok",
      metadata: { agent_id: agentId },
    };
  }
  return null;
}

function epochToBeijing(ms) { if (!ms) return null; const d = new Date(ms); const p = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{}); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${String(d.getMilliseconds()).padStart(3,"0")}+08:00`; }
async function readDirSafe(dir) { try { return await fs.readdir(dir); } catch { return []; } }
