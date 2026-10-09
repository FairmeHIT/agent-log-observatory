import { BaseAdapter } from "./base-adapter.mjs";
import { resolveAgentConfig, config as globalConfig } from "../lib/config.mjs";
import { normalizeEvent, normalizeSession, normalizeUsageRecord } from "../lib/normalizer.mjs";
import { makeDataCompleteness, makeMetricResult } from "../lib/evidence.mjs";
import { computeSuccessRate, computeCacheHitRate, computeOutputTps, aggregateTokens, computeSessionTurnE2eAvg, computeSessionLifespanMs } from "../lib/metrics.mjs";
import { querySqlite } from "../lib/sqlite-query.mjs";
import {
  hasCollectorData,
  readAllAttempts,
  filterByTimeWindow,
  computeTtftFromAttempts,
} from "../lib/collector-reader.mjs";
import path from "node:path";
import fs from "node:fs/promises";

const MISSING_MODEL_RAW = [];

export class MobileworkAdapter extends BaseAdapter {
  static agentObject = "mobilework";
  static adapterVersion = "0.2.0";

  async discover(config) {
    const cfg = resolveAgentConfig("mobilework");
    const dbPath = path.join(cfg.dataDir, "xdg", "data", "opencode", "opencode.db");
    const runsPath = path.join(cfg.dataDir, "data");
    const checks = { opencodeDb: false, modelRaw: false, runsJsonl: false, streamTimings: false, logs: false };
    try { await fs.access(dbPath); checks.opencodeDb = true; } catch {}
    try { await fs.access(path.join(cfg.dataDir, "plugin-reporting", "model-raw")); checks.modelRaw = true; } catch {}
    try { await fs.access(path.join(cfg.dashboardDataDir, "stream-timings.json")); checks.streamTimings = true; } catch {}
    try { await fs.access(path.join(cfg.dataDir, "electron", "logs")); checks.logs = true; } catch {}
    for (const d of await readDirSafe(runsPath)) {
      try {
        await fs.access(path.join(runsPath, d, "analytics", "runs.jsonl"));
        checks.runsJsonl = true; break;
      } catch {}
    }
    return {
      agent_object: "mobilework",
      installation_id: "default",
      sources: checks,
      available: checks.opencodeDb,
      missing_reasons: checks.opencodeDb ? [] : ["source_unavailable"],
      adapter_version: MobileworkAdapter.adapterVersion,
      modes: ["offline", "local-live"],
    };
  }

  async capabilities(context) {
    const collectorActive = await hasCollectorData("mobilework");
    const cfg = resolveAgentConfig("mobilework");
    let streamTimingsAvailable = false;
    try { await fs.access(path.join(cfg.dashboardDataDir, "stream-timings.json")); streamTimingsAvailable = true; } catch {}
    return {
      has_tokens: true,
      has_ttft: collectorActive || streamTimingsAvailable,
      has_retry: true,
      has_model_routing: true,
      has_event_stream: true,
      has_step: true, has_tool_calls: true, has_human_confirm: true,
      missing_fields: [],
      ttft_caveat: collectorActive
        ? "MITM reverse proxy (collectors/mobilework-llm-proxy) captures real TTFT via HTTP interception; session_id matched by time window (requested_at ∈ [session.time_created, time_updated]) since standard OpenAI requests don't carry session_id"
        : "stream-timings.json is persisted fallback; startedAt is runtime-step boundary with timestamp collision (sidecar closed-source); install mobilework-llm-proxy for real TTFT",
      human_confirm_caveat: "inferred from session.permission (ask rules) × tool.called events; permission.updated/replied events are SSE-only, not persisted in opencode.db",
    };
  }

  async extractSessions(options = {}) {
    const cfg = resolveAgentConfig("mobilework");
    const dbPath = path.join(cfg.dataDir, "xdg", "data", "opencode", "opencode.db");
    const sqliteExe = globalConfig.sqliteExecutable;
    let whereClause = "1=1";
    if (options.since) whereClause += ` AND time_created >= ${options.since}`;
    if (options.until) whereClause += ` AND time_created <= ${options.until}`;
    const rows = await query(sqliteExe, dbPath, `SELECT id, model, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, parent_id, workspace_id, title FROM session WHERE ${whereClause} ORDER BY time_created DESC LIMIT 500`);
    const items = rows.map((r) => normalizeSession({
      agent_object: "mobilework",
      session_id: r.id,
      parent_session_id: r.parent_id,
      title: r.title,
      model: safeJsonParse(r.model)?.id || r.model,
      agent_name: r.agent,
      started_at: epochToBeijing(r.time_created),
      ended_at: epochToBeijing(r.time_updated),
      duration_ms: r.time_updated && r.time_created ? r.time_updated - r.time_created : null,
      tokens: { input: r.tokens_input, output: r.tokens_output, reasoning: r.tokens_reasoning, cache_read: r.tokens_cache_read, cache_write: r.tokens_cache_write, total: (r.tokens_input||0)+(r.tokens_output||0)+(r.tokens_reasoning||0) },
      cost: r.cost,
      source_status: "ok",
      data_completeness: makeDataCompleteness([]),
    }));
    return { items, nextCursor: null, asOf: Date.now(), coverage: { total: items.length } };
  }

  async extractEvents(sessionId, options = {}) {
    const cfg = resolveAgentConfig("mobilework");
    const dbPath = path.join(cfg.dataDir, "xdg", "data", "opencode", "opencode.db");
    const sqliteExe = globalConfig.sqliteExecutable;
    const rows = await query(sqliteExe, dbPath, `SELECT type, data, seq FROM event WHERE aggregate_id = '${sessionId.replace(/'/g, "''")}' ORDER BY seq ASC`);
    return rows.map((r, i) => normalizeEvent(mapMobileworkEvent(r, sessionId, i)));
  }

  async extractUsage(sessionId, options = {}) {
    const cfg = resolveAgentConfig("mobilework");
    const dbPath = path.join(cfg.dataDir, "xdg", "data", "opencode", "opencode.db");
    const sqliteExe = globalConfig.sqliteExecutable;
    const rows = await query(sqliteExe, dbPath, `SELECT id, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = '${sessionId.replace(/'/g, "''")}'`);
    return rows.map((r) => normalizeUsageRecord({
      usage_record_id: `mw_session_${r.id}`,
      scope: "session",
      scope_id: r.id,
      input: r.tokens_input,
      output: r.tokens_output,
      reasoning: r.tokens_reasoning,
      cache_read: r.tokens_cache_read,
      cache_write: r.tokens_cache_write,
      monetary_cost: r.cost,
      cost_unit: "USD",
    }));
  }

  async extractCalls(sessionId, options = {}) {
    const cfg = resolveAgentConfig("mobilework");
    const dbPath = path.join(cfg.dataDir, "xdg", "data", "opencode", "opencode.db");
    const sqliteExe = globalConfig.sqliteExecutable;
    const llmCalls = [];
    const toolCalls = [];

    const events = await query(sqliteExe, dbPath,
      `SELECT type, data, seq FROM event WHERE aggregate_id = '${sessionId.replace(/'/g, "''")}' ORDER BY seq ASC`);

    let currentStepId = null;
    let stepCount = 0;

    for (const ev of events) {
      const data = safeJsonParse(ev.data) || {};
      const type = ev.type || "";
      const ts = data.timestamp;

      if (type.includes("step.started")) {
        currentStepId = `mw_step_${stepCount++}`;
      }
      if (type.includes("step.ended") || type.includes("step.failed")) {
        currentStepId = null;
      }
      if (type.includes("text.started") || type.includes("reasoning.started") || type.includes("tool.input.started")) {
        const msgId = data.assistantMessageID || `mw_msg_${ev.seq}`;
        llmCalls.push({
          llm_call_id: msgId,
          session_id: sessionId,
          agent_object: "mobilework",
          requested_model: data.model?.id || (typeof data.model === "string" ? data.model : null),
          routed_model: data.model?.id || (typeof data.model === "string" ? data.model : null),
          provider: data.model?.providerID || null,
          requested_at: ts,
          first_output_at: null,
          generation_ended_at: null,
          status: "running",
          step_id: currentStepId,
          usage_record_ids: [],
        });
      }
      if (type.includes("text.ended") || type.includes("reasoning.ended") || type.includes("tool.input.ended")) {
        const msgId = data.assistantMessageID;
        const c = llmCalls.find((c) => c.llm_call_id === msgId && c.status === "running");
        if (c) {
          if (!c.first_output_at) c.first_output_at = ts;
          c.generation_ended_at = ts;
          c.status = "ok";
        }
      }
      if (type.includes("tool.called")) {
        const callId = data.callID || `mw_tool_${toolCalls.length}`;
        toolCalls.push({
          call_id: callId,
          session_id: sessionId,
          agent_object: "mobilework",
          tool_name: data.tool || null,
          started_at: ts,
          ended_at: null,
          status: "running",
          exit_code: null,
          step_id: currentStepId,
        });
      }
      if (type.includes("tool.success")) {
        const callId = data.callID;
        const tc = toolCalls.find((t) => t.call_id === callId && t.status === "running");
        if (tc) { tc.ended_at = ts; tc.status = "ok"; }
      }
      if (type.includes("tool.failed")) {
        const callId = data.callID;
        const tc = toolCalls.find((t) => t.call_id === callId && t.status === "running");
        if (tc) { tc.ended_at = ts; tc.status = "error"; }
      }
      if (type.includes("retried")) {
        llmCalls.push({
          llm_call_id: `mw_retry_${ev.seq}`,
          session_id: sessionId,
          agent_object: "mobilework",
          requested_model: null, routed_model: null, provider: null,
          requested_at: ts, first_output_at: null, generation_ended_at: null,
          status: "ok", is_retry: true, usage_record_ids: [],
        });
      }
    }

    return { llm_calls: llmCalls, tool_calls: toolCalls };
  }

  async extractFailures(sessionId, options = {}) {
    const cfg = resolveAgentConfig("mobilework");
    const dbPath = path.join(cfg.dataDir, "xdg", "data", "opencode", "opencode.db");
    const sqliteExe = globalConfig.sqliteExecutable;
    const diagnostics = [];
    const summary = { gateway: 0, tool: 0, model: 0, dependency: 0, agent: 0 };

    const events = await query(sqliteExe, dbPath,
      `SELECT type, data, seq FROM event WHERE aggregate_id = '${sessionId.replace(/'/g, "''")}' ORDER BY seq ASC`);

    for (const ev of events) {
      const data = safeJsonParse(ev.data) || {};
      const type = ev.type || "";

      if (type.includes("step.failed")) {
        diagnostics.push({
          category: "agent",
          entity: data.assistantMessageID || null,
          event_type: type,
          evidence_grade: "direct",
          rule: "session.next.step.failed event",
        });
        summary.agent++;
      }
      if (type.includes("tool.failed")) {
        diagnostics.push({
          category: "tool",
          entity: data.callID || null,
          tool_name: data.tool || null,
          event_type: type,
          evidence_grade: "direct",
          rule: "session.next.tool.failed event",
        });
        summary.tool++;
      }
      if (type.includes("retried")) {
        diagnostics.push({
          category: "model",
          entity: sessionId,
          event_type: type,
          evidence_grade: "direct",
          rule: "session.next.retried event",
        });
        summary.model++;
      }
    }

    try {
      const mafLog = path.join(cfg.dataDir, "electron", "logs", "maf.log");
      const content = await fs.readFile(mafLog, "utf8");
      for (const line of content.split("\n")) {
        if (!line.includes('"level":"error"') && !/"error"/i.test(line)) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.level !== "error") continue;
          const msg = Array.isArray(obj.message) ? obj.message.join(" ") : String(obj.message || "");
          let cat = "dependency";
          if (/gateway|network|5\d\d|timeout|ECONN/.test(msg)) cat = "gateway";
          else if (/sidecar|daemon|ENOENT|DB|database/.test(msg)) cat = "dependency";
          else if (/model|parse|protocol/.test(msg)) cat = "model";
          diagnostics.push({
            category: cat,
            source: "maf.log",
            scope: obj.scope || null,
            message: msg.substring(0, 200),
            evidence_grade: "estimated",
            rule: "maf.log level=error",
          });
          summary[cat]++;
        } catch {}
      }
    } catch {}

    return { diagnostics, summary };
  }

  async extractMetrics(sessionId, options = {}) {
    const usage = await this.extractUsage(sessionId);
    const calls = await this.extractCalls(sessionId, options);
    const tokens = aggregateTokens(usage);

    const llmCalls = (calls.llm_calls || []).filter((c) => !c.is_retry);
    const retryCalls = (calls.llm_calls || []).filter((c) => c.is_retry);
    const toolCalls = calls.tool_calls || [];
    const llmOk = llmCalls.filter((c) => c.status === "ok").length;
    const llmError = llmCalls.filter((c) => c.status === "error").length;
    const toolOk = toolCalls.filter((c) => c.status === "ok").length;
    const toolError = toolCalls.filter((c) => c.status === "error").length;

    const generationMs = llmCalls
      .filter((c) => c.first_output_at && c.generation_ended_at)
      .reduce((s, c) => s + (c.generation_ended_at - c.first_output_at), 0);

    const cfg = resolveAgentConfig("mobilework");
    const dbPath = path.join(cfg.dataDir, "xdg", "data", "opencode", "opencode.db");
    const sqliteExe = globalConfig.sqliteExecutable;
    const sessionRows = await query(sqliteExe, dbPath,
      `SELECT time_created, time_updated, permission FROM session WHERE id = '${sessionId.replace(/'/g, "''")}'`);
    const sr = sessionRows[0] || {};
    const runDurations = await this._getRunDurations(sessionId);
    const turnE2e = computeSessionTurnE2eAvg(runDurations);
    turnE2e.scope_id = sessionId;
    const lifespan = computeSessionLifespanMs(sr.time_created ?? null, sr.time_updated ?? null);
    lifespan.scope_id = sessionId;

    const eventRows = await query(sqliteExe, dbPath,
      `SELECT type, data FROM event WHERE aggregate_id = '${sessionId.replace(/'/g, "''")}'`);
    const promptedCount = eventRows.filter((r) => (r.type || "").includes("prompted")).length;
    const compactionCount = eventRows.filter((r) => (r.type || "").includes("compaction")).length;
    const stepCount = eventRows.filter((r) => (r.type || "").includes("step.started")).length;

    // ── TTFT ────────────────────────────────────────────────────────
    // 优先用 MITM 代理采集器数据（collectors/mobilework-llm-proxy），
    // 通过 time-window 匹配（requested_at ∈ [session.time_created, time_updated]）。
    // 无采集器数据时回退 stream-timings.json（已知时间戳碰撞：startedAt===firstChunkAt，
    // 因 trace-dashboard sidecar 闭源无法修复，会判 timestamp_collision）。
    let ttftResult = null;
    try {
      const collectorActive = await hasCollectorData("mobilework");
      if (collectorActive && sr.time_created && sr.time_updated) {
        const allAttempts = await readAllAttempts("mobilework", {
          since: sr.time_created,
          until: sr.time_updated,
        });
        const matched = filterByTimeWindow(allAttempts, sr.time_created, sr.time_updated);
        if (matched.length > 0) {
          ttftResult = computeTtftFromAttempts(matched, sessionId);
        }
      }
    } catch {}

    // Fallback: stream-timings.json（trace-dashboard sidecar，闭源，时间戳碰撞）
    if (!ttftResult || ttftResult.state !== "captured") {
      const TTFT_PHYSICAL_FLOOR_MS = 5;
      const streamTimingsPath = path.join(cfg.dashboardDataDir, "stream-timings.json");
      const ttftValues = [];
      let ttftEligibleAttempts = 0;
      let ttftObservedAttempts = 0;
      let ttftCollisionAttempts = 0;
      try {
        const stContent = await fs.readFile(streamTimingsPath, "utf8");
        const st = safeJsonParse(stContent);
        if (st?.steps) {
          const steps = Object.values(st.steps).filter((s) => s.sessionId === sessionId);
          for (const s of steps) {
            const attempts = Array.isArray(s.attempts) ? s.attempts : [s];
            for (const a of attempts) {
              ttftEligibleAttempts++;
              if (a.startedAt && a.firstChunkAt) {
                ttftObservedAttempts++;
                const v = a.firstChunkAt - a.startedAt;
                if (Number.isFinite(v) && v >= TTFT_PHYSICAL_FLOOR_MS) {
                  ttftValues.push(v);
                } else if (Number.isFinite(v) && v >= 0) {
                  ttftCollisionAttempts++;
                }
              }
            }
          }
        }
      } catch {}

      const ttftMs = ttftValues.length > 0
        ? Math.round(ttftValues.reduce((s, v) => s + v, 0) / ttftValues.length)
        : null;
      const ttftMissingReason = ttftObservedAttempts === 0
        ? "missing_first_chunk"
        : "timestamp_collision";
      // 只在采集器没有给出 captured 结果时才用 stream-timings fallback
      if (!ttftResult) {
        ttftResult = makeMetricResult("llm_attempt_ttft_ms", ttftMs, {
          unit: "ms", scope: "session", scope_id: sessionId,
          state: ttftMs != null ? "captured" : "not-captured",
          missing_reason: ttftMs != null ? null : ttftMissingReason,
          evidence_grade: ttftMs != null ? "derived" : "unknown",
          semantic_profile: "mean_attempt_ttft_first_chunk",
          coverage: { eligible: ttftEligibleAttempts, observed: ttftObservedAttempts, finished: ttftValues.length, collisions: ttftCollisionAttempts },
          comparable: ttftValues.length >= 5,
        });
      }
    }

    // Human confirm: opencode 的 permission.updated / permission.replied 事件是 SSE-only，
    // 不会持久化到 opencode.db。但 session.permission 列保存了该会话的权限规则
    // （JSON 数组，每条含 permission 类别 + action: allow/ask/deny）。
    // 策略：解析 session.permission，找出 action="ask" 的权限类别，按已知映射
    // (bash→bash, edit→edit/write) 匹配 tool.called 事件的 tool 名，计数即为
    // 人工确认次数（用户必须批准后工具才会 completed）。evidence_grade=estimated，
    // 因为 external_directory 等路径相关类别无法从 tool 名判定。
    const PERM_CATEGORY_TO_TOOLS = {
      bash: ["bash"],
      edit: ["edit", "write"],
    };
    const permConfig = safeJsonParse(sr.permission);
    const askTools = new Set();
    let hasAskRules = false;
    if (Array.isArray(permConfig)) {
      for (const rule of permConfig) {
        if (rule.action === "ask" && PERM_CATEGORY_TO_TOOLS[rule.permission]) {
          hasAskRules = true;
          for (const t of PERM_CATEGORY_TO_TOOLS[rule.permission]) askTools.add(t);
        }
      }
    }
    let humanConfirmCount = null;
    if (hasAskRules) {
      humanConfirmCount = eventRows
        .filter((r) => (r.type || "").includes("tool.called"))
        .reduce((cnt, r) => {
          const d = safeJsonParse(r.data) || {};
          return cnt + (d.tool && askTools.has(d.tool) ? 1 : 0);
        }, 0);
    }

    return [
      turnE2e,
      lifespan,
      ttftResult,
      makeMetricResult("token_input", tokens.input || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("token_output", tokens.output || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("token_cache_read", tokens.cache_read || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("token_reasoning", tokens.reasoning || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("token_total", (tokens.input || 0) + (tokens.output || 0) || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived" }),
      makeMetricResult("credits", tokens.monetary_cost || null, { unit: "USD", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("llm_call_count", llmCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      computeSuccessRate(llmOk, llmError),
      makeMetricResult("llm_retry_count", retryCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("tool_call_count", toolCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      computeSuccessRate(toolOk, toolError),
      computeCacheHitRate(usage),
      computeOutputTps(tokens.output, generationMs),
      makeMetricResult("step_count", stepCount, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("compaction_count", compactionCount, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_agent_input", promptedCount, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_tool_call", toolCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_tool_result", toolCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("max_context", usage.length > 0 ? Math.max(...usage.map((r) => (r.input || 0) + (r.cache_read || 0))) : null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived", semantic_profile: "peak_input_plus_cache_read" }),
      makeMetricResult("context_window", null, { unit: "tokens", scope: "session", scope_id: sessionId, state: "not-captured", missing_reason: "not_instrumented" }),
      makeMetricResult("human_confirm_count", humanConfirmCount, {
        scope: "session", scope_id: sessionId,
        state: humanConfirmCount != null ? "captured" : "not-captured",
        evidence_grade: humanConfirmCount != null ? "estimated" : "unknown",
        missing_reason: humanConfirmCount != null ? null : "not_instrumented",
        semantic_profile: "inferred_from_permission_ask_rules_x_tool_called",
      }),
    ];
  }

  async _getRunDurations(sessionId) {
    const cfg = resolveAgentConfig("mobilework");
    const dataRoot = path.join(cfg.dataDir, "data");
    const durations = [];
    for (const entry of await readDirSafe(dataRoot)) {
      const runsPath = path.join(dataRoot, entry, "analytics", "runs.jsonl");
      try {
        const content = await fs.readFile(runsPath, "utf8");
        for (const line of content.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          const row = safeJsonParse(t);
          if (row && row.instanceId === sessionId && typeof row.durationMs === "number") {
            durations.push(row.durationMs);
          }
        }
      } catch {}
    }
    return durations;
  }
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
function epochToBeijing(ms) { if (!ms) return null; const d = new Date(ms); const p = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{}); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${String(d.getMilliseconds()).padStart(3,"0")}+08:00`; }
async function readDirSafe(dir) { try { return await fs.readdir(dir); } catch { return []; } }

function mapMobileworkEvent(row, sessionId, seq) {
  const data = safeJsonParse(row.data) || {};
  const type = row.type || "";
  let category = "other";
  if (type.includes("step.started")) category = "step.start";
  else if (type.includes("step.ended") || type.includes("step.failed")) category = "step.end";
  else if (type.includes("tool.called")) category = "tool.call";
  else if (type.includes("tool.success") || type.includes("tool.failed")) category = "tool.result";
  else if (type.includes("text.started") || type.includes("reasoning.started") || type.includes("tool.input.started")) category = "llm.request";
  else if (type.includes("text.ended") || type.includes("reasoning.ended") || type.includes("tool.input.ended")) category = "llm.response";
  else if (type.includes("prompted")) category = "agent.input";
  return {
    agent_object: "mobilework",
    session_id: sessionId,
    event_category: category,
    event_type_raw: type,
    occurred_at: data.timestamp ? epochToBeijing(data.timestamp) : null,
    source_seq: row.seq ?? seq,
    event_subtype: type.includes("retried") ? "retry" : type.includes("compaction") ? "compaction" : null,
    tool_name: data.tool || null,
    call_id: data.callID || null,
    message_id: data.assistantMessageID || null,
    routed_model: data.model?.id || (typeof data.model === "string" ? data.model : null) || null,
  };
}

async function query(sqlite, db, sql) {
  if (!sqlite || !db) return [];
  return querySqlite(sqlite, db, sql);
}
