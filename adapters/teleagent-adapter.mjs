import { BaseAdapter } from "./base-adapter.mjs";
import { resolveAgentConfig, config as globalConfig } from "../lib/config.mjs";
import { normalizeEvent, normalizeSession, normalizeUsageRecord } from "../lib/normalizer.mjs";
import { makeDataCompleteness, makeMetricResult } from "../lib/evidence.mjs";
import { parseGoLogLine } from "../lib/log-parser.mjs";
import {
  computeSuccessRate, computeCacheHitRate, computeOutputTps, aggregateTokens,
  computeSessionLifespanMs, computeSessionTurnE2eAvg,
} from "../lib/metrics.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { querySqlite } from "../lib/sqlite-query.mjs";

const execFileAsync = promisify(execFile);

const MISSING = ["credits", "compaction"];

export class TeleAgentAdapter extends BaseAdapter {
  static agentObject = "teleagent";
  static adapterVersion = "0.3.0";

  async discover(config) {
    const cfg = resolveAgentConfig("teleagent");
    const checks = { db: false, logsDir: false, oldLogs: false };
    try {
      const db = await this._findDb();
      if (db) checks.db = true;
    } catch {}
    try { await fs.access(path.join(cfg.dataDir, "logs")); checks.logsDir = true; } catch {}
    try { await fs.access(path.join(cfg.dataDir, "log")); checks.oldLogs = true; } catch {}
    return {
      agent_object: "teleagent",
      installation_id: "default",
      sources: checks,
      available: checks.db || checks.oldLogs,
      missing_reasons: [],
      adapter_version: TeleAgentAdapter.adapterVersion,
      modes: ["offline"],
    };
  }

  async capabilities(context) {
    const hasDb = !!await this._findDb().catch(() => null);
    return {
      has_tokens: true,
      has_ttft: hasDb,
      has_retry: false,
      has_model_routing: hasDb,
      has_event_stream: true,
      has_step: hasDb,
      has_tool_calls: true,
      has_human_confirm: true,
      missing_fields: MISSING,
    };
  }

  async _findDb() {
    const cfg = resolveAgentConfig("teleagent");
    try {
      const userDirs = await fs.readdir(cfg.dbDir);
      for (const ud of userDirs) {
        const dbPath = path.join(cfg.dbDir, ud, "teleagent.db");
        try {
          await fs.access(dbPath);
          return dbPath;
        } catch {}
      }
    } catch {}
    return null;
  }

  async _dbQuery(sql) {
    const dbPath = await this._findDb();
    if (!dbPath) return [];
    const sqliteExe = globalConfig.sqliteExecutable;
    if (!sqliteExe || !dbPath) return [];
    return querySqlite(sqliteExe, dbPath, sql);
  }

  async extractSessions(options = {}) {
    const cfg = resolveAgentConfig("teleagent");
    const dbPath = await this._findDb();
    if (dbPath) {
      let where = "1=1";
      if (options.since) where += ` AND time_created >= ${options.since}`;
      if (options.until) where += ` AND time_created <= ${options.until}`;
      const rows = await this._dbQuery(
        `SELECT id, title, time_created, time_updated, time_compacting, directory, workspace_id FROM session WHERE ${where} ORDER BY time_created DESC LIMIT 500`
      );
      const items = rows.map(r => normalizeSession({
        agent_object: "teleagent",
        session_id: r.id,
        project_dir: r.directory || null,
        title: r.title || null,
        started_at: r.time_created ? epochToBeijing(r.time_created) : null,
        source_status: "ok",
        data_completeness: makeDataCompleteness(MISSING),
      }));
      return { items, nextCursor: null, asOf: Date.now(), coverage: { total: items.length } };
    }
    return this._extractSessionsFromLogs(options);
  }

  async _extractSessionsFromLogs(options = {}) {
    const cfg = resolveAgentConfig("teleagent");
    const logDir = path.join(cfg.dataDir, "log");
    const sessionMap = new Map();
    for (const file of await readDirSafe(logDir)) {
      if (!file.startsWith("super-agent-server-") || !file.endsWith(".log")) continue;
      const content = await fs.readFile(path.join(logDir, file), "utf8");
      for (const line of content.split("\n")) {
        const parsed = parseGoLogLine(line, "teleagent");
        if (!parsed || !parsed.request_id) continue;
        if (parsed.tag === "session_start" && parsed.session_id) {
          if (!sessionMap.has(parsed.session_id)) {
            if (options.since && parsed.timestamp < options.since) continue;
            if (options.until && parsed.timestamp > options.until) continue;
            sessionMap.set(parsed.session_id, { session_id: parsed.session_id, first_seen: parsed.timestamp });
          }
        }
      }
    }
    const items = Array.from(sessionMap.entries()).map(([sid, info]) =>
      normalizeSession({
        agent_object: "teleagent",
        session_id: sid,
        started_at: epochToBeijing(info.first_seen),
        source_status: "ok",
        data_completeness: makeDataCompleteness(MISSING),
      })
    );
    return { items, nextCursor: null, asOf: Date.now(), coverage: { total: items.length } };
  }

  async extractEvents(sessionId, options = {}) {
    const rows = await this._dbQuery(
      `SELECT p.id, p.message_id, p.time_created, p.data, m.data as msg_data FROM part p LEFT JOIN message m ON p.message_id = m.id WHERE p.session_id = '${esc(sessionId)}' ORDER BY p.time_created ASC`
    );
    if (rows.length > 0) {
      const events = [];
      let seq = 0;
      for (const r of rows) {
        const pd = safeJsonParse(r.data) || {};
        const md = safeJsonParse(r.msg_data) || {};
        let category = "other";
        let toolName = null, callId = null, model = null;
        const t = pd.type || "";
        if (t === "step-start") category = "step.start";
        else if (t === "step-finish") category = "llm.response";
        else if (t === "text") category = md.role === "user" ? "agent.input" : "llm.response";
        else if (t === "reasoning") category = "llm.response";
        else if (t === "tool") { category = "tool.call"; toolName = pd.name || pd.tool || null; callId = pd.id || pd.callId || null; }
        else if (t === "compaction") category = "other";
        if (md.model) model = md.model.modelID || null;
        events.push(normalizeEvent({
          agent_object: "teleagent",
          session_id: sessionId,
          event_category: category,
          event_type_raw: t,
          occurred_at: r.time_created ? epochToBeijing(r.time_created) : null,
          source_seq: seq++,
          tool_name: toolName,
          call_id: callId,
          routed_model: model,
          event_subtype: t === "compaction" ? "compaction" : t === "reasoning" ? "reasoning" : null,
        }));
      }
      return events;
    }
    return this._extractEventsFromLogs(sessionId);
  }

  async _extractEventsFromLogs(sessionId) {
    const cfg = resolveAgentConfig("teleagent");
    const logDir = path.join(cfg.dataDir, "log");
    const events = [];
    for (const file of await readDirSafe(logDir)) {
      if (!file.startsWith("super-agent-server-") || !file.endsWith(".log")) continue;
      const content = await fs.readFile(path.join(logDir, file), "utf8");
      let seq = 0;
      for (const line of content.split("\n")) {
        const parsed = parseGoLogLine(line, "teleagent");
        if (!parsed || !parsed.request_id) continue;
        const ev = mapTeleAgentEvent(parsed, sessionId, seq++);
        if (ev) events.push(normalizeEvent(ev));
      }
    }
    return events;
  }

  async extractUsage(sessionId, options = {}) {
    const rows = await this._dbQuery(
      `SELECT data FROM part WHERE session_id = '${esc(sessionId)}' AND json_extract(data, '$.type') = 'step-finish' ORDER BY time_created ASC`
    );
    if (rows.length > 0) {
      const records = [];
      for (const r of rows) {
        const d = safeJsonParse(r.data) || {};
        const t = d.tokens || {};
        records.push(normalizeUsageRecord({
          usage_record_id: `ta_db_${sessionId}_${records.length}`,
          scope: "llm_attempt",
          input: t.input ?? null,
          output: t.output ?? null,
          cache_read: t.cache?.read ?? null,
          cache_write: t.cache?.write ?? null,
          monetary_cost: d.cost ?? null,
          cost_unit: "USD",
          input_includes_cache: false,
        }));
      }
      return records;
    }
    return this._extractUsageFromLogs(sessionId);
  }

  async _extractUsageFromLogs(sessionId) {
    const cfg = resolveAgentConfig("teleagent");
    const logDir = path.join(cfg.dataDir, "log");
    const records = [];
    const sessionReqMap = new Map();
    for (const file of await readDirSafe(logDir)) {
      if (!file.startsWith("super-agent-server-") || !file.endsWith(".log")) continue;
      const content = await fs.readFile(path.join(logDir, file), "utf8");
      for (const line of content.split("\n")) {
        const parsed = parseGoLogLine(line, "teleagent");
        if (!parsed || !parsed.request_id) continue;
        if (parsed.tag === "session_start" && parsed.session_id) {
          sessionReqMap.set(parsed.request_id, parsed.session_id);
        }
      }
    }
    for (const file of await readDirSafe(logDir)) {
      if (!file.startsWith("super-agent-server-") || !file.endsWith(".log")) continue;
      const content = await fs.readFile(path.join(logDir, file), "utf8");
      for (const line of content.split("\n")) {
        const parsed = parseGoLogLine(line, "teleagent");
        if (!parsed || parsed.tag !== "cost" || !parsed.request_id) continue;
        if (sessionReqMap.get(parsed.request_id) !== sessionId) continue;
        records.push(normalizeUsageRecord({
          usage_record_id: `ta_cost_${parsed.request_id}_${records.length}`,
          scope: "llm_attempt",
          input: parsed.tokens_in,
          output: parsed.tokens_out,
          cache_read: parsed.tokens_cache_read,
          monetary_cost: parsed.cost,
          cost_unit: "USD",
          input_includes_cache: false,
        }));
      }
    }
    return records;
  }

  async extractCalls(sessionId, options = {}) {
    // 用 json_extract 在 SQLite 侧提取字段，避免 querySqlite list-mode 回退截断长 JSON
    // 导致 safeJsonParse 失败（AGENTS.md 第 7 节已知限制）。
    const partRows = await this._dbQuery(
      `SELECT id, time_created,
              json_extract(data, '$.type') as ptype,
              json_extract(data, '$.time.start') as t_start,
              json_extract(data, '$.time.end') as t_end,
              json_extract(data, '$.name') as t_name,
              json_extract(data, '$.id') as t_id
       FROM part WHERE session_id = '${esc(sessionId)}' ORDER BY time_created ASC`
    );
    if (partRows.length > 0) {
      const llmCalls = [];
      const toolCalls = [];
      let stepIdx = -1;
      for (const r of partRows) {
        const ptype = r.ptype;
        if (ptype === "step-start") {
          stepIdx++;
          llmCalls.push({
            llm_call_id: `ta_step_${stepIdx}`,
            session_id: sessionId,
            agent_object: "teleagent",
            requested_at: r.time_created,
            // TeleAgent 无首 token 时间戳数据源（SPEC TIME-04）。
            // reasoning.time.start 恒等于 step-start.time_created（是 step 开始，不是首 token），
            // text.time_created 是生成完成后的落盘时间，也不是首 token。
            // first_output_at 保持 null，TTFT 由 extractMetrics 判 not-captured/missing_first_chunk。
            first_output_at: null,
            generation_ended_at: null,
            status: "ok",
          });
        }
        if (ptype === "reasoning" && r.t_end != null) {
          // reasoning.time.end = 生成结束时间，用于 turn_e2e_ms（完整生成时间）
          const step = llmCalls[llmCalls.length - 1];
          if (step && step.generation_ended_at == null) step.generation_ended_at = Number(r.t_end);
        }
        if (ptype === "text" && stepIdx >= 0) {
          // text.time_created = 生成完成后的落盘时间，用于 generation_ended_at 回退
          const step = llmCalls[llmCalls.length - 1];
          if (step && step.generation_ended_at == null) step.generation_ended_at = r.time_created;
        }
        if (ptype === "tool") {
          toolCalls.push({
            call_id: r.t_id || `ta_tool_${toolCalls.length}`,
            session_id: sessionId,
            agent_object: "teleagent",
            tool_name: r.t_name || null,
            started_at: r.time_created,
            ended_at: r.time_created,
            status: "ok",
          });
        }
      }
      return { llm_calls: llmCalls, tool_calls: toolCalls };
    }
    return this._extractCallsFromLogs(sessionId);
  }

  async _extractCallsFromLogs(sessionId) {
    const cfg = resolveAgentConfig("teleagent");
    const logDir = path.join(cfg.dataDir, "log");
    const allParsed = [];
    for (const file of await readDirSafe(logDir)) {
      if (!file.startsWith("super-agent-server-") || !file.endsWith(".log")) continue;
      const content = await fs.readFile(path.join(logDir, file), "utf8");
      for (const line of content.split("\n")) {
        const parsed = parseGoLogLine(line, "teleagent");
        if (parsed) allParsed.push(parsed);
      }
    }
    const byRequest = new Map();
    for (const p of allParsed) {
      if (!p.request_id) continue;
      if (!byRequest.has(p.request_id)) byRequest.set(p.request_id, { events: [] });
      byRequest.get(p.request_id).events.push(p);
    }
    const sessionReqMap = new Map();
    for (const p of allParsed) {
      if (p.tag === "session_start" && p.session_id) sessionReqMap.set(p.request_id, p.session_id);
    }
    const llmCalls = [];
    const toolCalls = [];
    for (const [reqId, entry] of byRequest) {
      if (sessionReqMap.get(reqId) !== sessionId) continue;
      const evs = entry.events.sort((a, b) => a.timestamp - b.timestamp);
      let requestedAt = null;
      for (const ev of evs) {
        if (ev.tag === "http" && ev.http_phase === "receive" && ev.path?.includes("/message")) requestedAt = ev.timestamp;
        if (ev.tag === "perm") {
          toolCalls.push({
            call_id: `ta_perm_${reqId}_${toolCalls.length}`,
            session_id: sessionId, agent_object: "teleagent",
            tool_name: ev.tool_name, started_at: ev.timestamp, ended_at: ev.timestamp,
            status: "ok", permission_action: ev.action, permission_by: ev.permission_by,
          });
        }
      }
      let costSeq = 0;
      for (const ev of evs) {
        if (ev.tag === "cost") {
          // [cost] 日志在生成结束时写入，不是首 token 时间。
          // TeleAgent 无首 token 时间戳数据源（SPEC TIME-04），
          // first_output_at 必须为 null，TTFT 由 extractMetrics 判 not-captured/missing_first_chunk。
          // generation_ended_at = [cost] 时间戳，用于 turn_e2e_ms（完整生成时间）。
          llmCalls.push({
            llm_call_id: `ta_llm_${reqId}_${costSeq++}`,
            session_id: sessionId, agent_object: "teleagent",
            requested_at: requestedAt, first_output_at: null,
            generation_ended_at: ev.timestamp, request_ended_at: ev.timestamp, status: "ok",
          });
        }
      }
    }
    return { llm_calls: llmCalls, tool_calls: toolCalls };
  }

  async extractFailures(sessionId, options = {}) {
    const summary = { gateway: 0, tool: 0, model: 0, dependency: 0, agent: 0 };
    const diagnostics = [];
    return { diagnostics, summary };
  }

  async extractMetrics(sessionId, options = {}) {
    const usage = await this.extractUsage(sessionId);
    const calls = await this.extractCalls(sessionId, options);
    const tokens = aggregateTokens(usage);
    const llmCalls = calls.llm_calls || [];
    const toolCalls = calls.tool_calls || [];
    const llmOk = llmCalls.filter(c => c.status === "ok").length;
    const llmError = llmCalls.filter(c => c.status === "error").length;
    const toolOk = toolCalls.filter(c => c.status === "ok").length;
    const toolError = toolCalls.filter(c => c.status === "error").length;

    const ttftValues = llmCalls
      .filter(c => c.requested_at && c.first_output_at)
      .map(c => c.first_output_at - c.requested_at);
    const ttftMs = ttftValues.length > 0
      ? Math.round(ttftValues.reduce((s, v) => s + v, 0) / ttftValues.length)
      : null;

    const generationMs = llmCalls
      .filter(c => c.first_output_at && c.generation_ended_at)
      .reduce((s, c) => s + (c.generation_ended_at - c.first_output_at), 0);

    const sessRows = await this._dbQuery(
      `SELECT time_created, time_updated, time_compacting FROM session WHERE id = '${esc(sessionId)}'`
    );
    const sr = sessRows[0] || {};

    const lifespan = computeSessionLifespanMs(sr.time_created ?? null, sr.time_updated ?? null);
    lifespan.scope_id = sessionId;

    const e2eValues = llmCalls
      .filter(c => c.requested_at && c.generation_ended_at)
      .map(c => c.generation_ended_at - c.requested_at);
    const turnE2e = computeSessionTurnE2eAvg(e2eValues);
    turnE2e.scope_id = sessionId;

    const compactionRows = await this._dbQuery(
      `SELECT COUNT(*) as cnt FROM part WHERE session_id = '${esc(sessionId)}' AND json_extract(data, '$.type') = 'compaction'`
    );
    const compactionCount = compactionRows[0]?.cnt ?? 0;

    const humanConfirms = toolCalls.filter(c =>
      c.permission_by && c.permission_by !== "*:*" && c.permission_action === "allow"
    ).length;

    const stepRows = await this._dbQuery(
      `SELECT COUNT(*) as cnt FROM part WHERE session_id = '${esc(sessionId)}' AND json_extract(data, '$.type') = 'step-start'`
    );
    const stepCount = stepRows[0]?.cnt ?? llmCalls.length;

    const modelRow = await this._dbQuery(
      `SELECT json_extract(data, '$.model.modelID') as model FROM message WHERE session_id = '${esc(sessionId)}' AND json_extract(data, '$.model') IS NOT NULL LIMIT 1`
    );
    const model = modelRow[0]?.model || null;

    return [
      makeMetricResult("llm_attempt_ttft_ms", ttftMs, {
        unit: "ms", scope: "session", scope_id: sessionId,
        state: ttftMs != null ? "captured" : "not-captured",
        missing_reason: ttftMs != null ? null : "missing_first_chunk",
        evidence_grade: ttftMs != null ? "derived" : "unknown",
        semantic_profile: "mean_step_ttft",
      }),
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
      makeMetricResult("token_total",
        ((tokens.input || 0) + (tokens.output || 0) + (tokens.cache_read || 0)) || null,
        { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived" }
      ),
      makeMetricResult("credits", tokens.monetary_cost || null, {
        unit: "USD", scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("llm_call_count", llmCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      computeSuccessRate(llmOk, llmError),
      makeMetricResult("llm_retry_count", null, {
        scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      makeMetricResult("tool_call_count", toolCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      computeSuccessRate(toolOk, toolError),
      computeCacheHitRate(usage),
      computeOutputTps(tokens.output, generationMs),
      makeMetricResult("step_count", stepCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("compaction_count", compactionCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_agent_input", llmCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "derived",
      }),
      makeMetricResult("event_count_llm_request", llmCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_llm_response", llmCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_tool_call", toolCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_tool_result", toolCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "derived",
      }),
      makeMetricResult("max_context", usage.length > 0
        ? Math.max(...usage.map(r => (r.input || 0) + (r.cache_read || 0)))
        : null,
        { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived",
          semantic_profile: "peak_input_plus_cache_read" }
      ),
      makeMetricResult("context_window", null, {
        unit: "tokens", scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      makeMetricResult("human_confirm_count", humanConfirms, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
    ];
  }

  async extractTimeline(sessionId) {
    const usage = await this.extractUsage(sessionId);
    const events = await this.extractEvents(sessionId);
    const points = [];
    let cumInput = 0, cumOutput = 0, cumCacheRead = 0;
    let seq = 0;
    const stepFinishEvents = events.filter(e => e.event_type_raw === "step-finish");
    for (let i = 0; i < stepFinishEvents.length; i++) {
      const u = usage[i];
      if (u) {
        cumInput += u.input || 0;
        cumOutput += u.output || 0;
        cumCacheRead += u.cache_read || 0;
        points.push({
          seq: seq + 1, turn: seq + 1,
          time: stepFinishEvents[i].occurred_at,
          input: u.input || 0, output: u.output || 0, cache_read: u.cache_read || 0,
          cumulative_input: cumInput, cumulative_output: cumOutput,
          cumulative_cache_read: cumCacheRead,
          cumulative_total: cumInput + cumOutput + cumCacheRead,
        });
        seq++;
      }
    }
    return points;
  }
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function esc(s) { return String(s).replace(/'/g, "''"); }

function epochToBeijing(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${String(d.getMilliseconds()).padStart(3, "0")}+08:00`;
}

async function readDirSafe(dir) {
  try { return await fs.readdir(dir); } catch { return []; }
}

function mapTeleAgentEvent(parsed, sessionId, seq) {
  if (parsed.tag === "cost") {
    return { agent_object: "teleagent", session_id: sessionId, event_category: "llm.request", event_subtype: "cost_summary", event_type_raw: "[cost]", occurred_at: epochToBeijing(parsed.timestamp), source_seq: seq, provider: parsed.provider };
  }
  if (parsed.tag === "perm") {
    return { agent_object: "teleagent", session_id: sessionId, event_category: "tool.call", event_subtype: "permission", event_type_raw: "[perm]", occurred_at: epochToBeijing(parsed.timestamp), source_seq: seq, tool_name: parsed.tool_name, metadata: { action: parsed.action, by: parsed.permission_by } };
  }
  if (parsed.tag === "tool_instruction_review") {
    return { agent_object: "teleagent", session_id: sessionId, event_category: "tool.result", event_subtype: "review_decision", event_type_raw: "[tool_instruction_review]", occurred_at: epochToBeijing(parsed.timestamp), source_seq: seq, tool_name: parsed.tool_id, status: parsed.result === 1 ? "ok" : "error" };
  }
  if (parsed.tag === "prune") {
    return { agent_object: "teleagent", session_id: sessionId, event_category: "other", event_subtype: "compaction", event_type_raw: "[prune]", occurred_at: epochToBeijing(parsed.timestamp), source_seq: seq };
  }
  if (parsed.tag === "resolveModel") {
    return { agent_object: "teleagent", session_id: sessionId, event_category: "other", event_subtype: "model_resolution", event_type_raw: "resolveModel", occurred_at: epochToBeijing(parsed.timestamp), source_seq: seq, requested_model: parsed.model, routed_model: parsed.model, provider: parsed.model?.split("/")[0] };
  }
  if (parsed.tag === "error") {
    return { agent_object: "teleagent", session_id: sessionId, event_category: "other", event_subtype: "error", event_type_raw: "[Error]", occurred_at: epochToBeijing(parsed.timestamp), source_seq: seq, status: "error" };
  }
  return null;
}
