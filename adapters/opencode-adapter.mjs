import { BaseAdapter } from "./base-adapter.mjs";
import { resolveAgentConfig, config as globalConfig } from "../lib/config.mjs";
import { normalizeEvent, normalizeSession, normalizeUsageRecord } from "../lib/normalizer.mjs";
import { makeDataCompleteness, makeMetricResult } from "../lib/evidence.mjs";
import {
  computeSuccessRate,
  computeCacheHitRate,
  computeSessionTurnE2eAvg,
  computeSessionLifespanMs,
  aggregateTokens,
} from "../lib/metrics.mjs";
import {
  readAttempts,
  computeTtftFromAttempts,
  computeRetryFromAttempts,
  hasCollectorData,
} from "../lib/collector-reader.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { querySqlite } from "../lib/sqlite-query.mjs";

const execFileAsync = promisify(execFile);

const MISSING = ["ttft", "retry"];

/**
 * OpencodeAdapter — standalone opencode CLI（非 Mobilework 封装）。
 *
 * 数据源：
 *   ~/.local/share/opencode/opencode.db  — session / part / message / event 表
 *   ~/.local/share/opencode/log/opencode.log — Go key=value 结构化日志（level=ERROR 含 session.id）
 *   ~/.config/opencode/opencode.jsonc — 配置
 *
 * 与 Mobilework adapter 的差异：
 *   - 无 XDG 子目录、无 electron 日志、无 stream-timings.json、无 runs.jsonl
 *   - event 表仅 message.part.updated / message.updated（无 session.next.* 细粒度事件）
 *   - 调用提取从 part 表直接解析（而非 event 表）
 *   - 日志为 key=value 格式（非 JSON），含 session.id 可做 session 级归因
 *   - session.permission 为 null 时使用 opencode 默认（bash=ask, edit=ask）
 */
export class OpencodeAdapter extends BaseAdapter {
  static agentObject = "opencode";
  static adapterVersion = "0.1.0";

  async discover(config) {
    const cfg = resolveAgentConfig("opencode");
    const dbPath = path.join(cfg.dataDir, "opencode.db");
    const logPath = path.join(cfg.dataDir, "log", "opencode.log");
    const checks = { opencodeDb: false, log: false, config: false };
    try { await fs.access(dbPath); checks.opencodeDb = true; } catch {}
    try { await fs.access(logPath); checks.log = true; } catch {}
    try { await fs.access(path.join(cfg.configDir, "opencode.jsonc")); checks.config = true; } catch {}
    return {
      agent_object: "opencode",
      installation_id: "default",
      sources: checks,
      available: checks.opencodeDb,
      missing_reasons: checks.opencodeDb ? [] : ["source_unavailable"],
      adapter_version: OpencodeAdapter.adapterVersion,
      modes: ["offline"],
    };
  }

  async capabilities(context) {
    const collectorActive = await hasCollectorData("opencode");
    const missing = collectorActive
      ? ["human_confirm"] // collector 补全了 ttft + retry；人工确认仍 estimated
      : MISSING;
    return {
      has_tokens: true,
      has_ttft: collectorActive,
      has_retry: collectorActive,
      has_model_routing: true, has_event_stream: true,
      has_step: true, has_tool_calls: true, has_human_confirm: true,
      missing_fields: missing,
      collector_active: collectorActive,
      human_confirm_caveat: "inferred from session.permission (ask rules or opencode defaults) × tool parts; permission events are SSE-only, not persisted",
    };
  }

  async _query(sql) {
    const cfg = resolveAgentConfig("opencode");
    const dbPath = path.join(cfg.dataDir, "opencode.db");
    const sqliteExe = globalConfig.sqliteExecutable;
    return querySqlite(sqliteExe, dbPath, sql);
  }

  /**
   * Detect which session table to use.
   * opencode V2 introduced `session_v2`; older versions only have `session`.
   * Caches the result to avoid repeated schema introspection.
   */
  async _sessionTable() {
    if (this._cachedSessionTable) return this._cachedSessionTable;
    try {
      const rows = await this._query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'`
      );
      this._cachedSessionTable = rows.length > 0 ? "session_v2" : "session";
    } catch {
      this._cachedSessionTable = "session";
    }
    return this._cachedSessionTable;
  }

  async extractSessions(options = {}) {
    let where = "1=1";
    if (options.since) where += ` AND time_created >= ${options.since}`;
    if (options.until) where += ` AND time_created <= ${options.until}`;
    const tbl = await this._sessionTable();
    const rows = await this._query(
      `SELECT id, title, agent, model, cost, directory, parent_id, permission,
              tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
              time_created, time_updated
       FROM ${tbl} WHERE ${where} ORDER BY time_created DESC LIMIT 500`
    );
    const items = rows.map((r) => normalizeSession({
      agent_object: "opencode",
      session_id: r.id,
      parent_session_id: r.parent_id,
      title: r.title,
      project_dir: r.directory || null,
      model: safeJsonParse(r.model)?.id || r.model,
      agent_name: r.agent,
      started_at: epochToBeijing(r.time_created),
      ended_at: epochToBeijing(r.time_updated),
      duration_ms: r.time_updated && r.time_created ? r.time_updated - r.time_created : null,
      tokens: {
        input: r.tokens_input, output: r.tokens_output, reasoning: r.tokens_reasoning,
        cache_read: r.tokens_cache_read, cache_write: r.tokens_cache_write,
        total: (r.tokens_input || 0) + (r.tokens_output || 0) + (r.tokens_reasoning || 0),
      },
      cost: r.cost,
      source_status: "ok",
      data_completeness: makeDataCompleteness(MISSING),
    }));
    return { items, nextCursor: null, asOf: Date.now(), coverage: { total: items.length } };
  }

  async extractEvents(sessionId, options = {}) {
    const parts = await this._query(
      `SELECT id, data, time_created FROM part WHERE session_id = '${esc(sessionId)}' ORDER BY time_created ASC, id ASC`
    );
    let seq = 0;
    const events = [];
    for (const p of parts) {
      const d = safeJsonParse(p.data) || {};
      let category = "other";
      if (d.type === "step-start") category = "step.start";
      else if (d.type === "step-finish") category = "step.end";
      else if (d.type === "tool") category = d.state?.status === "error" ? "tool.result" : "tool.call";
      else if (d.type === "text" || d.type === "reasoning") category = "llm.response";
      else if (d.type === "compaction") category = "other";
      else continue;
      events.push(normalizeEvent({
        agent_object: "opencode",
        session_id: sessionId,
        event_category: category,
        event_type_raw: d.type,
        occurred_at: epochToBeijing(p.time_created),
        source_seq: seq++,
        event_subtype: d.type === "compaction" ? "compaction" : null,
        tool_name: d.tool || null,
        call_id: d.callID || null,
      }));
    }
    return events;
  }

  async extractUsage(sessionId, options = {}) {
    const rows = await this._query(
      `SELECT data FROM message WHERE session_id = '${esc(sessionId)}' AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created ASC`
    );
    const records = [];
    for (const r of rows) {
      const d = safeJsonParse(r.data) || {};
      if (!d.tokens) continue;
      records.push(normalizeUsageRecord({
        usage_record_id: `opencode_msg_${sessionId}_${records.length}`,
        scope: "session",
        scope_id: sessionId,
        input: d.tokens.input ?? null,
        output: d.tokens.output ?? null,
        reasoning: d.tokens.reasoning ?? null,
        cache_read: d.tokens.cache?.read ?? null,
        cache_write: d.tokens.cache?.write ?? null,
        monetary_cost: d.cost || null,
        cost_unit: "USD",
        routed_model: d.modelID || null,
      }));
    }
    if (records.length === 0) {
      const tbl = await this._sessionTable();
      const sessRows = await this._query(
        `SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost, model FROM ${tbl} WHERE id = '${esc(sessionId)}'`
      );
      const s = sessRows[0] || {};
      if (s.tokens_input || s.tokens_output) {
        records.push(normalizeUsageRecord({
          usage_record_id: `opencode_sess_${sessionId}`,
          scope: "session", scope_id: sessionId,
          input: s.tokens_input, output: s.tokens_output,
          reasoning: s.tokens_reasoning,
          cache_read: s.tokens_cache_read, cache_write: s.tokens_cache_write,
          monetary_cost: s.cost, cost_unit: "USD",
          routed_model: safeJsonParse(s.model)?.id || null,
        }));
      }
    }
    return records;
  }

  async extractCalls(sessionId, options = {}) {
    const parts = await this._query(
      `SELECT id, data, time_created, time_updated FROM part WHERE session_id = '${esc(sessionId)}' ORDER BY time_created ASC, id ASC`
    );
    const llmCalls = [];
    const toolCalls = [];
    let currentStepId = null;
    let stepCount = 0;

    for (const p of parts) {
      const d = safeJsonParse(p.data) || {};
      if (d.type === "step-start") {
        currentStepId = `oc_step_${stepCount++}`;
      }
      if (d.type === "step-finish") {
        currentStepId = null;
      }
      if (d.type === "text" || d.type === "reasoning") {
        const time = d.time || {};
        llmCalls.push({
          llm_call_id: p.id,
          session_id: sessionId,
          agent_object: "opencode",
          requested_at: time.start ?? p.time_created ?? null,
          first_output_at: time.start ?? null,
          generation_ended_at: time.end ?? p.time_updated ?? null,
          status: "ok",
          step_id: currentStepId,
          usage_record_ids: [],
        });
      }
      if (d.type === "tool") {
        const state = d.state || {};
        const time = state.time || {};
        toolCalls.push({
          call_id: d.callID || `oc_tool_${toolCalls.length}`,
          session_id: sessionId,
          agent_object: "opencode",
          tool_name: d.tool || null,
          started_at: time.start ?? p.time_created ?? null,
          ended_at: time.end ?? p.time_updated ?? null,
          status: state.status === "completed" ? "ok" : state.status === "error" ? "error" : "running",
          exit_code: null,
          step_id: currentStepId,
        });
      }
    }
    return { llm_calls: llmCalls, tool_calls: toolCalls };
  }

  async extractFailures(sessionId, options = {}) {
    const cfg = resolveAgentConfig("opencode");
    const diagnostics = [];
    const summary = { gateway: 0, tool: 0, model: 0, dependency: 0, agent: 0 };

    // 1. Tool errors from parts（session 级，part.session_id 直接归属）
    const errorParts = await this._query(
      `SELECT data FROM part WHERE session_id = '${esc(sessionId)}' AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.state.status') = 'error'`
    );
    for (const ep of errorParts) {
      const d = safeJsonParse(ep.data) || {};
      const errMsg = d.state?.error || "";
      let cat = "tool";
      if (/abort|interrupt/i.test(errMsg)) cat = "agent";
      diagnostics.push({
        category: cat,
        entity: d.callID || null,
        tool_name: d.tool || null,
        message: errMsg.substring(0, 200),
        evidence_grade: "direct",
        rule: "part state.status=error",
      });
      summary[cat]++;
    }

    // 2. Log errors from opencode.log（session 级归因，via session.id 字段）
    try {
      const logPath = path.join(cfg.dataDir, "log", "opencode.log");
      const content = await fs.readFile(logPath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.includes("level=ERROR")) continue;
        const parsed = parseLogLine(line);
        if (!parsed || parsed["session.id"] !== sessionId) continue;
        const msg = parsed.message || "";
        const errMsg = parsed["error.error"] || parsed.error || "";
        let cat;
        if (msg === "stream error") {
          cat = /cannot connect|socket|connection|ECONN|timeout/i.test(errMsg) ? "gateway" : "model";
        } else if (/models\.dev|fetch|plugin/i.test(msg)) {
          cat = "dependency";
        } else if (/spawning/i.test(msg)) {
          cat = "dependency";
        } else if (/process|abort/i.test(msg)) {
          cat = "agent";
        } else {
          cat = "model";
        }
        diagnostics.push({
          category: cat,
          source: "opencode.log",
          message: `${msg}: ${errMsg}`.substring(0, 200),
          evidence_grade: "direct",
          rule: "opencode.log level=ERROR session.id match",
        });
        summary[cat]++;
      }
    } catch {}

    return { diagnostics, summary };
  }

  async extractMetrics(sessionId, options = {}) {
    const usage = await this.extractUsage(sessionId);
    const calls = await this.extractCalls(sessionId, options);
    const tokens = aggregateTokens(usage);

    // 采集器数据：opencode-collector-plugin 落盘的 attempt 级时延记录。
    // 无数据时返回空数组，下游回退 not_instrumented。
    const collectorAttempts = await readAttempts("opencode", sessionId);
    const collectorActive = collectorAttempts.length > 0;

    const llmCalls = calls.llm_calls || [];
    const toolCalls = calls.tool_calls || [];
    const llmOk = llmCalls.filter((c) => c.status === "ok").length;
    const llmError = llmCalls.filter((c) => c.status === "error").length;
    const toolOk = toolCalls.filter((c) => c.status === "ok").length;
    const toolError = toolCalls.filter((c) => c.status === "error").length;

    // Turn E2E from assistant message durations
    const msgRows = await this._query(
      `SELECT time_created, time_updated FROM message WHERE session_id = '${esc(sessionId)}' AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created ASC`
    );
    const turnDurations = msgRows
      .filter((m) => m.time_created && m.time_updated)
      .map((m) => m.time_updated - m.time_created);
    const turnE2e = computeSessionTurnE2eAvg(turnDurations);
    turnE2e.scope_id = sessionId;

    // Session lifespan + permission config
    const sessTbl = await this._sessionTable();
    const sessRows = await this._query(
      `SELECT time_created, time_updated, permission FROM ${sessTbl} WHERE id = '${esc(sessionId)}'`
    );
    const sr = sessRows[0] || {};
    const lifespan = computeSessionLifespanMs(sr.time_created ?? null, sr.time_updated ?? null);
    lifespan.scope_id = sessionId;

    // Part-type counts
    const partTypeRows = await this._query(
      `SELECT json_extract(data, '$.type') as type, COUNT(*) as cnt FROM part WHERE session_id = '${esc(sessionId)}' GROUP BY type`
    );
    const partCounts = {};
    for (const r of partTypeRows) partCounts[r.type] = r.cnt;
    const stepCount = partCounts["step-start"] || 0;
    const compactionCount = partCounts["compaction"] || 0;

    const userMsgRows = await this._query(
      `SELECT COUNT(*) as cnt FROM message WHERE session_id = '${esc(sessionId)}' AND json_extract(data, '$.role') = 'user'`
    );
    const userMsgCount = userMsgRows[0]?.cnt ?? 0;

    // Human confirm inference（同 Mobilework 策略）
    // opencode 默认权限：bash=ask, edit=ask。session.permission 可覆盖。
    // - permission 为 null → 全部使用默认（bash/edit 均 ask）
    // - permission 为非 null 数组 → 检查 ask 规则；对 bash/edit 若无显式
    //   allow/deny 覆盖，则默认 ask 仍生效
    const PERM_CATEGORY_TO_TOOLS = { bash: ["bash"], edit: ["edit", "write"] };
    const permConfig = safeJsonParse(sr.permission);
    const askTools = new Set();
    let hasAskRules = false;
    const overriddenCats = new Set();
    if (Array.isArray(permConfig)) {
      for (const rule of permConfig) {
        if (!PERM_CATEGORY_TO_TOOLS[rule.permission]) continue;
        overriddenCats.add(rule.permission);
        if (rule.action === "ask") {
          hasAskRules = true;
          for (const t of PERM_CATEGORY_TO_TOOLS[rule.permission]) askTools.add(t);
        }
      }
      // 对未被显式覆盖的 bash/edit，opencode 默认 ask 仍生效
      for (const cat of ["bash", "edit"]) {
        if (!overriddenCats.has(cat)) {
          hasAskRules = true;
          for (const t of PERM_CATEGORY_TO_TOOLS[cat]) askTools.add(t);
        }
      }
    } else if (permConfig === null) {
      hasAskRules = true;
      askTools.add("bash"); askTools.add("edit"); askTools.add("write");
    }
    let humanConfirmCount = null;
    if (hasAskRules) {
      humanConfirmCount = toolCalls.filter((c) => askTools.has(c.tool_name)).length;
    }

    return [
      turnE2e,
      lifespan,
      // TTFT：优先用采集器数据（collector-attempt-0.1.0），无则回退 not_instrumented。
      collectorActive
        ? computeTtftFromAttempts(collectorAttempts, sessionId)
        : makeMetricResult("llm_attempt_ttft_ms", null, {
            unit: "ms", scope: "session", scope_id: sessionId,
            state: "not-captured", missing_reason: "not_instrumented",
          }),
      makeMetricResult("token_input", tokens.input || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("token_output", tokens.output || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("token_cache_read", tokens.cache_read || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("token_reasoning", tokens.reasoning || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("token_total", (tokens.input || 0) + (tokens.output || 0) || null, { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived" }),
      makeMetricResult("credits", tokens.monetary_cost || null, { unit: "USD", scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("max_context",
        usage.length > 0 ? Math.max(...usage.map((r) => (r.input || 0) + (r.cache_read || 0))) : null,
        { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived", semantic_profile: "peak_input_plus_cache_read" }
      ),
      makeMetricResult("context_window", null, {
        unit: "tokens", scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      computeCacheHitRate(usage),
      makeMetricResult("llm_call_count", llmCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      computeSuccessRate(llmOk, llmError),
      // LLM 重试：优先用采集器数据（is_retry / attempt_index），无则回退 not_instrumented。
      collectorActive
        ? computeRetryFromAttempts(collectorAttempts, sessionId)
        : makeMetricResult("llm_retry_count", null, {
            scope: "session", scope_id: sessionId,
            state: "not-captured", missing_reason: "not_instrumented",
          }),
      makeMetricResult("tool_call_count", toolCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      computeSuccessRate(toolOk, toolError),
      makeMetricResult("step_count", stepCount, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("compaction_count", compactionCount, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_agent_input", userMsgCount, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_llm_response", llmCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_tool_call", toolCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("event_count_tool_result", toolCalls.length, { scope: "session", scope_id: sessionId, evidence_grade: "direct" }),
      makeMetricResult("human_confirm_count", humanConfirmCount, {
        scope: "session", scope_id: sessionId,
        state: humanConfirmCount != null ? "captured" : "not-captured",
        evidence_grade: humanConfirmCount != null ? "estimated" : "unknown",
        missing_reason: humanConfirmCount != null ? null : "not_instrumented",
        semantic_profile: "inferred_from_permission_ask_or_defaults_x_tool_parts",
      }),
    ];
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

/**
 * 解析 opencode.log 的 Go key=value 结构化日志行。
 * 处理带引号的值：message="stream error"  session.id=ses_xxx
 */
function parseLogLine(line) {
  const result = {};
  const regex = /([\w.]+)=("(?:[^"\\]|\\.)*"|\S+)/g;
  let match;
  while ((match = regex.exec(line)) !== null) {
    let val = match[2];
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    result[match[1]] = val;
  }
  return result;
}
