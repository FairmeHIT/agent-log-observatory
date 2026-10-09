import { BaseAdapter } from "./base-adapter.mjs";
import { resolveAgentConfig, config as globalConfig } from "../lib/config.mjs";
import { normalizeEvent, normalizeSession, normalizeUsageRecord } from "../lib/normalizer.mjs";
import { makeDataCompleteness, makeMetricResult } from "../lib/evidence.mjs";
import {
  computeSuccessRate,
  computeSessionLifespanMs,
  computeSessionTurnE2eAvg,
  aggregateTokens,
  computeCacheHitRate,
} from "../lib/metrics.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { querySqlite } from "../lib/sqlite-query.mjs";

const execFileAsync = promisify(execFile);

// cache_read/cache_write 已由 rollout token_usage_record 提供（见 _readRolloutUsage）
const MISSING = ["credits", "retry"];

export class CodexAdapter extends BaseAdapter {
  static agentObject = "codex";
  static adapterVersion = "0.1.0";

  async discover(config) {
    const cfg = resolveAgentConfig("codex");
    const checks = { threadsDb: false, historyDb: false, logsDb: false, config: false };
    try { await fs.access(path.join(cfg.dataDir, "state_5.sqlite")); checks.threadsDb = true; } catch {}
    try { await fs.access(path.join(cfg.dataDir, "thread_history_1.sqlite")); checks.historyDb = true; } catch {}
    try { await fs.access(path.join(cfg.dataDir, "logs_2.sqlite")); checks.logsDb = true; } catch {}
    try { await fs.access(cfg.configPath); checks.config = true; } catch {}
    return {
      agent_object: "codex",
      installation_id: "default",
      sources: checks,
      available: checks.threadsDb,
      missing_reasons: [],
      adapter_version: CodexAdapter.adapterVersion,
      modes: ["offline"],
    };
  }

  async capabilities(context) {
    return {
      has_tokens: true,
      has_ttft: true,
      has_retry: false,
      has_model_routing: true,
      has_event_stream: true,
      has_step: true,
      has_tool_calls: true,
      has_human_confirm: false,
      missing_fields: MISSING,
    };
  }

  async _query(dbFile, sql) {
    const cfg = resolveAgentConfig("codex");
    const dbPath = path.join(cfg.dataDir, dbFile);
    const sqliteExe = globalConfig.sqliteExecutable;
    return querySqlite(sqliteExe, dbPath, sql);
  }

  async _readConfig() {
    const cfg = resolveAgentConfig("codex");
    try {
      const text = await fs.readFile(cfg.configPath, "utf8");
      const m = text.match(/model_context_window\s*=\s*(\d+)/);
      const cm = text.match(/model_auto_compact_token_limit\s*=\s*(\d+)/);
      return {
        contextWindow: m ? parseInt(m[1], 10) : null,
        compactLimit: cm ? parseInt(cm[1], 10) : null,
      };
    } catch { return { contextWindow: null, compactLimit: null }; }
  }

  async extractSessions(options = {}) {
    const cfg = resolveAgentConfig("codex");
    let where = "1=1";
    if (options.since) where += ` AND created_at_ms >= ${options.since}`;
    if (options.until) where += ` AND created_at_ms <= ${options.until}`;
    const rows = await this._query("state_5.sqlite",
      `SELECT id, title, created_at_ms, updated_at_ms, model, model_provider, tokens_used, cwd, approval_mode FROM threads WHERE ${where} ORDER BY created_at_ms DESC LIMIT 500`
    );
    const items = rows.map(r => normalizeSession({
      agent_object: "codex",
      session_id: r.id,
      project_dir: r.cwd || null,
      title: r.title || null,
      started_at: r.created_at_ms ? epochToBeijing(r.created_at_ms) : null,
      model: r.model || null,
      source_status: "ok",
      data_completeness: makeDataCompleteness(MISSING),
    }));
    return { items, nextCursor: null, asOf: Date.now(), coverage: { total: items.length } };
  }

  async extractEvents(sessionId, options = {}) {
    const rows = await this._query("thread_history_1.sqlite",
      `SELECT item_id, item_type, item_json, started_at_ms, completed_at_ms FROM thread_items WHERE thread_id = '${esc(sessionId)}' ORDER BY started_at_ms ASC`
    );
    let seq = 0;
    const events = [];
    for (const r of rows) {
      const d = safeJsonParse(r.item_json) || {};
      let category = "other";
      const t = r.item_type || d.type || "";
      if (t === "reasoning") category = "llm.response";
      else if (t === "agentMessage") category = "llm.response";
      else if (t === "userMessage") category = "agent.input";
      else if (t === "commandExecution" || t === "mcpToolCall") category = "tool.call";
      else if (t === "webSearch") category = "tool.call";
      else if (t === "contextCompaction") category = "other";
      else if (t === "fileChange") category = "other";
      events.push(normalizeEvent({
        agent_object: "codex",
        session_id: sessionId,
        event_category: category,
        event_type_raw: t,
        occurred_at: r.started_at_ms ? epochToBeijing(r.started_at_ms) : null,
        source_seq: seq++,
        event_subtype: t === "contextCompaction" ? "compaction" : t === "reasoning" ? "reasoning" : null,
      }));
    }
    return events;
  }

  async extractUsage(sessionId, options = {}) {
    // 优先读 rollout JSONL 的 token_usage_record（input/output/cache/reasoning 分项齐全）；
    // 无 rollout（旧会话/文件被清理）时回退 logs 累计值按 turn 去重取 diff。
    const rollout = await this._readRolloutUsage(sessionId);
    if (rollout) return rollout.records;
    return this._extractUsageFromLogs(sessionId, options);
  }

  // 读取 state_5.threads.rollout_path 指向的 rollout JSONL，提取每采样一次的 token usage 分项。
  async _readRolloutUsage(sessionId) {
    let rolloutPath = null;
    try {
      const rows = await this._query("state_5.sqlite",
        `SELECT rollout_path FROM threads WHERE id = '${esc(sessionId)}'`);
      rolloutPath = normalizeWinPath(rows[0]?.rollout_path);
    } catch { return null; }
    if (!rolloutPath) return null;
    let content;
    try { content = await fs.readFile(rolloutPath, "utf8"); } catch { return null; }
    return parseRolloutUsage(content, sessionId);
  }

  async _extractUsageFromLogs(sessionId, options = {}) {
    // Extract token values directly in SQL to avoid fetching full feedback_log_body
    // (which contains newlines that break querySqlite's list-mode fallback).
    const rows = await this._query("logs_2.sqlite",
      `SELECT ts, ` +
      `substr(feedback_log_body, instr(feedback_log_body, 'total_usage_tokens='), 40) as tok_str, ` +
      `CASE WHEN instr(feedback_log_body, 'turn_id=') > 0 ` +
      `THEN substr(feedback_log_body, instr(feedback_log_body, 'turn_id=') + 8, 36) ` +
      `ELSE '' END as turn_id, ` +
      `CASE WHEN instr(feedback_log_body, 'model=') > 0 ` +
      `THEN substr(feedback_log_body, instr(feedback_log_body, 'model=') + 6, 30) ` +
      `ELSE '' END as model_str ` +
      `FROM logs WHERE feedback_log_body LIKE '%thread_id=${esc(sessionId)}%' ` +
      `AND feedback_log_body LIKE '%total_usage_tokens%' ORDER BY ts ASC`
    );
    // total_usage_tokens is cumulative within the session; multiple logs per turn (per sampling).
    // Deduplicate by turn_id, taking the last (max) cumulative value per turn.
    const turnTotals = new Map(); // turn_id -> { total, ts, model }
    for (const r of rows) {
      const m = (r.tok_str || "").match(/total_usage_tokens=(\d+)/);
      if (!m) continue;
      const total = parseInt(m[1], 10);
      const turnId = r.turn_id || `unknown_${r.ts}`;
      const model = (r.model_str || "").replace(/\s.*$/, "").trim() || null;
      turnTotals.set(turnId, { total, ts: r.ts, model });
    }
    // Compute per-turn diffs (cumulative → incremental)
    const records = [];
    let prevTotal = 0;
    for (const [, info] of turnTotals) {
      const perTurn = info.total >= prevTotal ? info.total - prevTotal : info.total;
      prevTotal = info.total;
      records.push(normalizeUsageRecord({
        usage_record_id: `codex_turn_${sessionId}_${records.length}`,
        scope: "session",
        input: null,
        output: null,
        reported_total: perTurn,
        input_includes_cache: "unknown",
        routed_model: info.model,
      }));
    }
    if (records.length === 0) {
      const threadRows = await this._query("state_5.sqlite",
        `SELECT tokens_used FROM threads WHERE id = '${esc(sessionId)}'`
      );
      if (threadRows[0]?.tokens_used != null) {
        records.push(normalizeUsageRecord({
          usage_record_id: `codex_thread_${sessionId}`,
          scope: "session",
          input: null,
          output: null,
          reported_total: threadRows[0].tokens_used,
          input_includes_cache: "unknown",
        }));
      }
    }
    return records;
  }

  async extractCalls(sessionId, options = {}) {
    const turns = await this._query("thread_history_1.sqlite",
      `SELECT turn_id, started_at, completed_at, duration_ms, status FROM thread_turns WHERE thread_id = '${esc(sessionId)}' ORDER BY started_at ASC`
    );
    const items = await this._query("thread_history_1.sqlite",
      `SELECT item_id, turn_id, item_type, item_json, started_at_ms, completed_at_ms FROM thread_items WHERE thread_id = '${esc(sessionId)}' ORDER BY started_at_ms ASC`
    );
    const turnMap = new Map();
    const llmCalls = turns.map((t, i) => {
      const call = {
        llm_call_id: `codex_turn_${i}`,
        session_id: sessionId,
        agent_object: "codex",
        requested_at: t.started_at ? t.started_at * 1000 : null,
        first_output_at: null,
        generation_ended_at: t.completed_at ? t.completed_at * 1000 : null,
        turn_duration_ms: t.duration_ms ?? null,
        status: t.status === "completed" ? "ok" : (t.status === "inProgress" ? "running" : "error"),
      };
      turnMap.set(t.turn_id, call);
      return call;
    });
    for (const item of items) {
      const t = item.item_type;
      if (t === "reasoning" || t === "agentMessage") {
        const turn = turnMap.get(item.turn_id);
        if (turn && turn.first_output_at == null && item.started_at_ms) {
          turn.first_output_at = item.started_at_ms;
        }
      }
    }
    const toolCalls = items
      .filter(i => i.item_type === "commandExecution" || i.item_type === "mcpToolCall" || i.item_type === "webSearch")
      .map((i, idx) => ({
        call_id: i.item_id || `codex_tool_${idx}`,
        session_id: sessionId,
        agent_object: "codex",
        tool_name: i.item_type === "mcpToolCall" ? safeJsonParse(i.item_json)?.tool : i.item_type,
        started_at: i.started_at_ms || null,
        ended_at: i.completed_at_ms || null,
        status: "ok",
      }));
    return { llm_calls: llmCalls, tool_calls: toolCalls };
  }

  async extractFailures(sessionId, options = {}) {
    const turns = await this._query("thread_history_1.sqlite",
      `SELECT status, error_json FROM thread_turns WHERE thread_id = '${esc(sessionId)}'`
    );
    const summary = { gateway: 0, tool: 0, model: 0, dependency: 0, agent: 0 };
    for (const t of turns) {
      if (t.status && t.status !== "completed" && t.status !== "inProgress") {
        summary.agent++;
      }
    }
    return { diagnostics: [], summary };
  }

  async extractMetrics(sessionId, options = {}) {
    const rollout = await this._readRolloutUsage(sessionId);
    const usage = rollout ? rollout.records : await this._extractUsageFromLogs(sessionId, options);
    const tokens = aggregateTokens(usage);
    const hasTokenBreakdown = usage.some((r) => r.input != null);
    const calls = await this.extractCalls(sessionId, options);
    const llmCalls = calls.llm_calls || [];
    const toolCalls = calls.tool_calls || [];
    const llmOk = llmCalls.filter(c => c.status === "ok").length;
    const llmError = llmCalls.filter(c => c.status === "error").length;

    const ttftValues = llmCalls
      .filter(c => c.requested_at && c.first_output_at)
      .map(c => c.first_output_at - c.requested_at);
    const ttftMs = ttftValues.length > 0
      ? Math.round(ttftValues.reduce((s, v) => s + v, 0) / ttftValues.length)
      : null;

    const e2eDurations = llmCalls
      .filter(c => c.turn_duration_ms != null)
      .map(c => c.turn_duration_ms);
    const turnE2e = computeSessionTurnE2eAvg(e2eDurations.length > 0 ? e2eDurations : llmCalls
      .filter(c => c.requested_at && c.generation_ended_at)
      .map(c => c.generation_ended_at - c.requested_at));
    turnE2e.scope_id = sessionId;

    const threadRows = await this._query("state_5.sqlite",
      `SELECT created_at_ms, updated_at_ms, model, tokens_used FROM threads WHERE id = '${esc(sessionId)}'`
    );
    const tr = threadRows[0] || {};
    const lifespan = computeSessionLifespanMs(tr.created_at_ms ?? null, tr.updated_at_ms ?? null);
    lifespan.scope_id = sessionId;

    const compactionRows = await this._query("thread_history_1.sqlite",
      `SELECT COUNT(*) as cnt FROM thread_items WHERE thread_id = '${esc(sessionId)}' AND item_type = 'contextCompaction'`
    );
    const compactionCount = compactionRows[0]?.cnt ?? 0;

    const stepRows = await this._query("thread_history_1.sqlite",
      `SELECT COUNT(*) as cnt FROM thread_items WHERE thread_id = '${esc(sessionId)}' AND item_type NOT IN ('userMessage')`
    );
    const stepCount = stepRows[0]?.cnt ?? llmCalls.length;

    const toolCount = toolCalls.length;
    const userMsgRows = await this._query("thread_history_1.sqlite",
      `SELECT COUNT(*) as cnt FROM thread_items WHERE thread_id = '${esc(sessionId)}' AND item_type = 'userMessage'`
    );
    const userMsgCount = userMsgRows[0]?.cnt ?? 0;

    const cfg = await this._readConfig();
    // token_total：rollout 分项和（最精确）> threads.tokens_used（权威累计）> null
    const totalTokens = rollout
      ? (tokens.reported_total || null)
      : (tr.tokens_used ?? null);

    return [
      makeMetricResult("llm_attempt_ttft_ms", ttftMs, {
        unit: "ms", scope: "session", scope_id: sessionId,
        state: ttftMs != null ? "captured" : "not-captured",
        missing_reason: ttftMs != null ? null : "missing_first_chunk",
        evidence_grade: ttftMs != null ? "derived" : "unknown",
      }),
      turnE2e,
      lifespan,
      makeMetricResult("token_input", hasTokenBreakdown ? (tokens.input || null) : null, {
        unit: "tokens", scope: "session", scope_id: sessionId,
        evidence_grade: hasTokenBreakdown ? "direct" : "unknown",
        semantic_profile: "rollout_token_usage_record_sum",
        ...(hasTokenBreakdown ? {} : { state: "not-captured", missing_reason: "not_instrumented" }),
      }),
      makeMetricResult("token_output", hasTokenBreakdown ? (tokens.output || null) : null, {
        unit: "tokens", scope: "session", scope_id: sessionId,
        evidence_grade: hasTokenBreakdown ? "direct" : "unknown",
        semantic_profile: "rollout_token_usage_record_sum",
        ...(hasTokenBreakdown ? {} : { state: "not-captured", missing_reason: "not_instrumented" }),
      }),
      makeMetricResult("token_cache_read", hasTokenBreakdown ? (tokens.cache_read || null) : null, {
        unit: "tokens", scope: "session", scope_id: sessionId,
        evidence_grade: hasTokenBreakdown ? "direct" : "unknown",
        semantic_profile: "rollout_token_usage_record_sum",
        ...(hasTokenBreakdown ? {} : { state: "not-captured", missing_reason: "not_instrumented" }),
      }),
      makeMetricResult("token_reasoning", hasTokenBreakdown ? (tokens.reasoning || null) : null, {
        unit: "tokens", scope: "session", scope_id: sessionId,
        evidence_grade: hasTokenBreakdown ? "direct" : "unknown",
        semantic_profile: "rollout_token_usage_record_sum",
        ...(hasTokenBreakdown ? {} : { state: "not-captured", missing_reason: "not_instrumented" }),
      }),
      makeMetricResult("token_total", totalTokens, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct",
        semantic_profile: rollout ? "rollout_token_usage_record_sum" : "total_usage_tokens_or_threads_tokens_used",
      }),
      makeMetricResult("credits", null, {
        scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      makeMetricResult("llm_call_count", llmCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      computeSuccessRate(llmOk, llmError),
      makeMetricResult("llm_retry_count", null, {
        scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      makeMetricResult("tool_call_count", toolCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      computeSuccessRate(toolCalls.filter(c => c.status === "ok").length, toolCalls.filter(c => c.status === "error").length),
      (() => { const r = computeCacheHitRate(usage); r.scope = "session"; r.scope_id = sessionId; return r; })(),
      makeMetricResult("generation_output_tps", null, {
        unit: "tok/s", scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      makeMetricResult("step_count", stepCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("compaction_count", compactionCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_agent_input", userMsgCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_llm_request", llmCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_llm_response", llmCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_tool_call", toolCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_tool_result", toolCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "derived",
      }),
      makeMetricResult("max_context", rollout && rollout.maxInput != null ? rollout.maxInput : totalTokens, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived",
        semantic_profile: rollout && rollout.maxInput != null ? "peak_input_tokens_including_cache" : "total_tokens_used_approximate",
      }),
      makeMetricResult("context_window", (rollout && rollout.contextWindow) || cfg.contextWindow, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct",
        semantic_profile: (rollout && rollout.contextWindow) ? "runtime_token_count_model_context_window" : "config_toml_model_context_window",
      }),
      makeMetricResult("compaction_threshold", cfg.compactLimit, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct",
        semantic_profile: "config_toml_model_auto_compact_token_limit",
      }),
      makeMetricResult("human_confirm_count", null, {
        scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
    ];
  }

  async extractTimeline(sessionId) {
    // Extract token values directly in SQL to avoid fetching full feedback_log_body
    // (which contains newlines that break querySqlite's list-mode fallback).
    const rows = await this._query("logs_2.sqlite",
      `SELECT ts, ` +
      `substr(feedback_log_body, instr(feedback_log_body, 'total_usage_tokens='), 40) as tok_str, ` +
      `CASE WHEN instr(feedback_log_body, 'turn_id=') > 0 ` +
      `THEN substr(feedback_log_body, instr(feedback_log_body, 'turn_id=') + 8, 36) ` +
      `ELSE '' END as turn_id ` +
      `FROM logs WHERE feedback_log_body LIKE '%thread_id=${esc(sessionId)}%' ` +
      `AND feedback_log_body LIKE '%total_usage_tokens%' ORDER BY ts ASC`
    );
    if (rows.length === 0) return [];
    // Deduplicate by turn_id: take the last cumulative value per turn
    const turnMap = new Map(); // turn_id -> { ts, total }
    for (const r of rows) {
      const m = (r.tok_str || "").match(/total_usage_tokens=(\d+)/);
      if (!m) continue;
      const total = parseInt(m[1], 10);
      const turnId = r.turn_id || `unknown_${r.ts}`;
      turnMap.set(turnId, { ts: r.ts, total }); // last (max cumulative) per turn
    }
    const points = [];
    for (const [, info] of turnMap) {
      points.push({
        seq: points.length + 1,
        turn: points.length + 1,
        time: info.ts ? info.ts * 1000 : null,
        cumulative_total: info.total,
      });
    }
    return points;
  }
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

// 归一化 Windows 扩展路径：\\?\C:\x → C:\x；\\?\UNC\server\share → \\server\share
export function normalizeWinPath(p) {
  if (!p || typeof p !== "string") return null;
  if (p.startsWith("\\\\?\\UNC\\")) return "\\\\" + p.slice(8);
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

// 解析 rollout JSONL 内容，提取逐次 LLM 调用的 token usage 分项与运行时 context window。
// 字段语义（3646 条真实记录实测验证）：
//   total_tokens == input_tokens + output_tokens（100% 成立）
//   cached_input_tokens ⊆ input_tokens（input 含 cache_read → input_includes_cache=true）
//   reasoning_output_tokens ⊆ output_tokens（output 含 reasoning → output_includes_reasoning=true）
// 每条 token_usage_record 的 usage 为单次 LLM 调用值；turn_token_usage/thread_token_usage 是累计值（不使用）。
// 返回 { records, contextWindow, maxInput }；无 usage 记录时返回 null。
export function parseRolloutUsage(content, sessionId) {
  const records = [];
  let contextWindow = null;
  let maxInput = null;
  for (const line of content.split("\n")) {
    if (!line || (line.indexOf("token_usage_record") < 0 && line.indexOf("token_count") < 0)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "token_usage_record" && o.payload && o.payload.usage) {
      const u = o.payload.usage;
      records.push(normalizeUsageRecord({
        usage_record_id: `codex_rollout_${sessionId}_${records.length}`,
        scope: "session",
        scope_id: sessionId,
        input: typeof u.input_tokens === "number" ? u.input_tokens : null,
        output: typeof u.output_tokens === "number" ? u.output_tokens : null,
        reasoning: typeof u.reasoning_output_tokens === "number" ? u.reasoning_output_tokens : null,
        cache_read: typeof u.cached_input_tokens === "number" ? u.cached_input_tokens : null,
        cache_write: typeof u.cache_write_input_tokens === "number" ? u.cache_write_input_tokens : null,
        reported_total: typeof u.total_tokens === "number" ? u.total_tokens : null,
        input_includes_cache: true,
        output_includes_reasoning: true,
      }));
      if (typeof u.input_tokens === "number") {
        maxInput = maxInput == null ? u.input_tokens : Math.max(maxInput, u.input_tokens);
      }
    } else if (o.type === "event_msg" && o.payload && o.payload.type === "token_count"
      && o.payload.info && typeof o.payload.info.model_context_window === "number") {
      contextWindow = o.payload.info.model_context_window;
    }
  }
  if (records.length === 0) return null;
  return { records, contextWindow, maxInput };
}

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
