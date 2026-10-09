import { BaseAdapter } from "./base-adapter.mjs";
import { resolveAgentConfig } from "../lib/config.mjs";
import { normalizeEvent, normalizeSession, normalizeUsageRecord } from "../lib/normalizer.mjs";
import { makeDataCompleteness, makeMetricResult } from "../lib/evidence.mjs";
import {
  computeSuccessRate,
  computeCacheHitRate,
  computeOutputTps,
  aggregateTokens,
  computeSessionTurnE2eAvg,
  computeSessionLifespanMs,
} from "../lib/metrics.mjs";
import { zstdDecompressSync } from "node:zlib";
import path from "node:path";
import fs from "node:fs/promises";

const MISSING = ["credits", "failures", "compaction"];

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export class DshAdapter extends BaseAdapter {
  static agentObject = "dsh";
  static adapterVersion = "0.1.0";

  async discover(config) {
    const cfg = resolveAgentConfig("dsh");
    const checks = { sessionsDir: false, storagesDir: false, electronData: false };
    try { await fs.access(cfg.sessionsDir); checks.sessionsDir = true; } catch {}
    try { await fs.access(cfg.storagesDir); checks.storagesDir = true; } catch {}
    try { await fs.access(cfg.electronDataDir); checks.electronData = true; } catch {}
    return {
      agent_object: "dsh",
      installation_id: "default",
      sources: checks,
      available: checks.sessionsDir || checks.storagesDir,
      missing_reasons: [],
      adapter_version: DshAdapter.adapterVersion,
      modes: ["offline"],
    };
  }

  async capabilities(context) {
    return {
      has_tokens: true,
      has_ttft: true,
      has_retry: true,
      has_model_routing: true,
      has_event_stream: true,
      has_step: true,
      has_tool_calls: true,
      has_human_confirm: false,
      missing_fields: MISSING,
    };
  }

  async extractSessions(options = {}) {
    const cfg = resolveAgentConfig("dsh");
    const items = [];
    try {
      const workspaceDirs = await readDirSafe(cfg.sessionsDir);
      for (const wsSlug of workspaceDirs) {
        const wsDir = path.join(cfg.sessionsDir, wsSlug);
        const wsStat = await fs.stat(wsDir).catch(() => null);
        if (!wsStat || !wsStat.isDirectory()) continue;
        const sessionDirs = await readDirSafe(wsDir);
        for (const sd of sessionDirs) {
          if (!sd.startsWith("session-")) continue;
          const sessionId = sd;
          const fullDir = path.join(wsDir, sd);
          let createdAt = null;
          try {
            const header = await this._readSessionHeader(fullDir);
            if (header?.createdAt) createdAt = header.createdAt;
          } catch {}
          if (options.since && createdAt && createdAt < options.since) continue;
          if (options.until && createdAt && createdAt > options.until) continue;
          items.push(normalizeSession({
            agent_object: "dsh",
            session_id: sessionId,
            project_dir: this._slugToCwd(wsSlug),
            started_at: createdAt ? epochToBeijing(createdAt) : null,
            source_status: "ok",
            data_completeness: makeDataCompleteness(MISSING),
          }));
        }
      }
    } catch {}
    return { items, nextCursor: null, asOf: Date.now(), coverage: { total: items.length } };
  }

  async extractEvents(sessionId, options = {}) {
    const events = await this._readSessionEvents(sessionId);
    let seq = 0;
    const mapped = [];
    for (const ev of events) {
      const mapped_ev = mapDshEvent(ev, sessionId, seq++);
      if (mapped_ev) mapped.push(normalizeEvent(mapped_ev));
    }
    return mapped;
  }

  async extractUsage(sessionId, options = {}) {
    const proj = await this._readProjectionCache(sessionId);
    if (!proj?.tokenUsage?.totals) return [];
    const t = proj.tokenUsage.totals;
    const modelSel = proj.modelSelection?.lastUsed;
    return [normalizeUsageRecord({
      usage_record_id: `dsh_usage_${sessionId}`,
      scope: "session",
      input: t.uncachedInputTokens ?? null,
      output: t.outputTokens ?? null,
      cache_read: t.cacheReadTokens ?? null,
      cache_write: t.cacheWriteTokens ?? null,
      input_includes_cache: false,
      routed_model: modelSel?.model || null,
    })];
  }

  async extractCalls(sessionId, options = {}) {
    const events = await this._readSessionEvents(sessionId);
    const llmCalls = [];
    const toolCalls = [];
    let stepCount = 0;
    const stepsByTurn = new Map();

    for (const ev of events) {
      if (ev.type === "step/start") {
        const turn = ev.data?.turn || 0;
        const step = ev.data?.step || 0;
        stepCount++;
        const key = `${turn}-${step}`;
        stepsByTurn.set(key, {
          llm_call_id: `dsh_step_${turn}_${step}`,
          session_id: sessionId,
          agent_object: "dsh",
          requested_model: null,
          requested_at: ev.time,
          generation_ended_at: null,
          first_output_at: null,
          status: "ok",
        });
      }
      if (ev.type === "reasoning-chunks" || ev.type === "text-chunks") {
        const key = `${ev.data?.turn || 0}-${ev.data?.step || 0}`;
        const step = stepsByTurn.get(key);
        if (step) {
          const t = ev.time0 || ev.time;
          if (step.first_output_at == null) step.first_output_at = t;
          step.generation_ended_at = t;
        }
      }
      if (ev.type === "tool/call") {
        toolCalls.push({
          call_id: ev.data?.callId || `dsh_tool_${toolCalls.length}`,
          session_id: sessionId,
          agent_object: "dsh",
          tool_name: ev.data?.name || null,
          started_at: ev.time,
          ended_at: ev.time,
          status: "ok",
        });
      }
    }

    for (const step of stepsByTurn.values()) {
      llmCalls.push(step);
    }

    return { llm_calls: llmCalls, tool_calls: toolCalls };
  }

  async extractFailures(sessionId, options = {}) {
    return { diagnostics: [], summary: { gateway: 0, tool: 0, model: 0, dependency: 0, agent: 0 } };
  }

  async extractMetrics(sessionId, options = {}) {
    const usage = await this.extractUsage(sessionId);
    const calls = await this.extractCalls(sessionId, options);
    const tokens = aggregateTokens(usage);
    const proj = await this._readProjectionCache(sessionId);
    const stats = proj?.sessionStats;
    const ctxPressure = proj?.contextPressure;

    const llmCalls = calls.llm_calls || [];
    const toolCalls = calls.tool_calls || [];
    const llmOk = llmCalls.filter((c) => c.status === "ok").length;
    const llmError = llmCalls.filter((c) => c.status === "error").length;
    const toolOk = toolCalls.filter((c) => c.status === "ok").length;
    const toolError = toolCalls.filter((c) => c.status === "error").length;

    const ttftValues = llmCalls
      .filter((c) => c.requested_at && c.first_output_at)
      .map((c) => c.first_output_at - c.requested_at);
    const ttftMs = ttftValues.length > 0
      ? Math.round(ttftValues.reduce((s, v) => s + v, 0) / ttftValues.length)
      : (stats && stats.ttftSteps > 0 ? Math.round(stats.ttftMs / stats.ttftSteps) : null);

    const turns = stats?.turns || llmCalls.length;
    const generationMs = stats?.decodeMs || llmCalls
      .filter((c) => c.first_output_at && c.generation_ended_at)
      .reduce((s, c) => s + (c.generation_ended_at - c.first_output_at), 0);

    const events = await this._readSessionEvents(sessionId);
    const turnBoundaries = [];
    let curTurn = null;
    let turnStart = null;
    let turnEnd = null;
    for (const ev of events) {
      if (ev.type === "session/end-seed") continue;
      const t = ev.time ?? ev.time0;
      if (t == null) continue;
      const turn = ev.data?.turn;
      if (turn != null && turn !== curTurn) {
        if (curTurn != null && turnStart != null && turnEnd != null) {
          turnBoundaries.push({ submitted_at: turnStart, execution_ended_at: turnEnd });
        }
        curTurn = turn;
        turnStart = t;
        turnEnd = t;
      } else if (turn != null && turnStart != null) {
        if (turnEnd == null || t > turnEnd) turnEnd = t;
      }
    }
    if (curTurn != null && turnStart != null && turnEnd != null) {
      turnBoundaries.push({ submitted_at: turnStart, execution_ended_at: turnEnd });
    }
    const turnE2e = computeSessionTurnE2eAvg(turnBoundaries);
    turnE2e.scope_id = sessionId;

    const firstTs = events.length > 0 ? (events[0].time ?? events[0].time0) : null;
    const lastTs = events.length > 0
      ? (() => {
          let last = null;
          for (const ev of events) {
            const t = ev.time ?? ev.time0;
            if (t != null && ev.type !== "session/end-seed") {
              if (last == null || t > last) last = t;
            }
          }
          return last;
        })()
      : null;
    const lifespan = computeSessionLifespanMs(firstTs, lastTs);
    lifespan.scope_id = sessionId;

    const userMsgCount = stats?.turns || new Set(events.filter(e => e.data?.turn != null).map(e => e.data.turn)).size;
    const assistantMsgCount = events.filter((e) => e.type === "text-chunks").length;
    const funcCallCount = toolCalls.length;
    const funcResultCount = toolCalls.length;
    const reasoningCount = events.filter((e) => e.type === "reasoning-chunks").length;

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
      makeMetricResult("token_reasoning", null, {
        unit: "tokens", scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      makeMetricResult("token_total",
        ((tokens.input || 0) + (tokens.output || 0) + (tokens.cache_read || 0)) || null,
        { unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "derived" }
      ),
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
      makeMetricResult("tool_call_count", toolCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      computeSuccessRate(toolOk, toolError),
      computeCacheHitRate(usage),
      computeOutputTps(tokens.output, generationMs),
      makeMetricResult("step_count", stats?.steps ?? llmCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
        semantic_profile: "sessionStats_steps",
      }),
      makeMetricResult("compaction_count", null, {
        scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
      makeMetricResult("event_count_agent_input", userMsgCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "derived",
      }),
      makeMetricResult("event_count_llm_request", llmCalls.length, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_llm_response", assistantMsgCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_tool_call", funcCallCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "direct",
      }),
      makeMetricResult("event_count_tool_result", funcResultCount, {
        scope: "session", scope_id: sessionId, evidence_grade: "derived",
      }),
      makeMetricResult("max_context", ctxPressure?.surfaceTokens ?? null, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct",
        semantic_profile: "peak_surface_tokens",
      }),
      makeMetricResult("context_window", ctxPressure?.contextWindow ?? null, {
        unit: "tokens", scope: "session", scope_id: sessionId, evidence_grade: "direct",
        semantic_profile: "model_context_limit",
      }),
      makeMetricResult("human_confirm_count", null, {
        scope: "session", scope_id: sessionId,
        state: "not-captured", missing_reason: "not_instrumented",
      }),
    ];
  }

  async extractTimeline(sessionId) {
    const proj = await this._readProjectionCache(sessionId);
    const totals = proj?.tokenUsage?.totals;
    const last = proj?.tokenUsage?.last;
    const stats = proj?.sessionStats;
    if (!totals) return [];

    const ti = totals.uncachedInputTokens || 0;
    const to = totals.outputTokens || 0;
    const tcr = totals.cacheReadTokens || 0;
    const totalTurns = stats?.turns || 1;

    const points = [{ seq: 0, turn: 0, cumulative_input: 0, cumulative_output: 0, cumulative_cache_read: 0, cumulative_total: 0 }];

    if (last && last.buckets) {
      const li = last.buckets.uncachedInputTokens || 0;
      const lo = last.buckets.outputTokens || 0;
      const lcr = last.buckets.cacheReadTokens || 0;
      points.push({
        seq: 1, turn: totalTurns - 1,
        cumulative_input: ti - li, cumulative_output: to - lo,
        cumulative_cache_read: tcr - lcr,
        cumulative_total: (ti - li) + (to - lo) + (tcr - lcr),
      });
    }

    points.push({
      seq: points.length, turn: totalTurns,
      cumulative_input: ti, cumulative_output: to,
      cumulative_cache_read: tcr, cumulative_total: ti + to + tcr,
    });
    return points;
  }
  async _findSessionDir(sessionId) {
    const cfg = resolveAgentConfig("dsh");
    const workspaceDirs = await readDirSafe(cfg.sessionsDir);
    for (const wsSlug of workspaceDirs) {
      const dir = path.join(cfg.sessionsDir, wsSlug, sessionId);
      try {
        await fs.access(dir);
        return dir;
      } catch {}
    }
    return null;
  }

  async _readSessionHeader(sessionDir) {
    for (const fn of ["session.v4.jsonl.zstd", "session.jsonl.zstd"]) {
      const filePath = path.join(sessionDir, fn);
      try {
        const buf = await fs.readFile(filePath);
        const lines = decompressMultiFrameZstd(buf);
        if (lines.length > 0) {
          return JSON.parse(lines[0]);
        }
      } catch {}
    }
    return null;
  }

  async _readSessionEvents(sessionId) {
    const sessionDir = await this._findSessionDir(sessionId);
    if (!sessionDir) return [];
    for (const fn of ["session.v4.jsonl.zstd", "session.jsonl.zstd"]) {
      const filePath = path.join(sessionDir, fn);
      try {
        const buf = await fs.readFile(filePath);
        const lines = decompressMultiFrameZstd(buf);
        const events = [];
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type !== "session") events.push(obj);
          } catch {}
        }
        if (events.length > 0) return events;
      } catch {}
    }
    return [];
  }

  async _readProjectionCache(sessionId) {
    const cfg = resolveAgentConfig("dsh");
    const cachePath = path.join(cfg.storagesDir, "session_projcache", "sessions", `${sessionId}.json`);
    try {
      const raw = JSON.parse(await fs.readFile(cachePath, "utf8"));
      const rows = raw?.record?.rows || raw?.rows || raw || {};
      const result = {};
      for (const [key, entry] of Object.entries(rows)) {
        if (entry && typeof entry === "object" && "val" in entry) {
          result[key] = entry.val;
        } else {
          result[key] = entry;
        }
      }
      return result;
    } catch {
      return null;
    }
  }

  _slugToCwd(slug) {
    if (!slug) return null;
    let cwd = slug.replace(/^--/, "").replace(/--/g, path.sep);
    cwd = cwd.replace(/~(\d{4})/g, (m, code) => String.fromCharCode(parseInt(code, 16)));
    return cwd || null;
  }
}

function decompressMultiFrameZstd(buf) {
  const framePositions = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      framePositions.push(i);
    }
  }
  if (framePositions.length === 0) return [];
  const lines = [];
  for (let i = 0; i < framePositions.length; i++) {
    const start = framePositions[i];
    const end = i + 1 < framePositions.length ? framePositions[i + 1] : buf.length;
    const chunk = buf.subarray(start, end);
    try {
      const out = zstdDecompressSync(chunk);
      const text = out.toString("utf8").trim();
      if (text) lines.push(text);
    } catch {
      try {
        const out = zstdDecompressSync(buf.subarray(start));
        const text = out.toString("utf8").trim();
        if (text) lines.push(text);
      } catch {}
    }
  }
  return lines;
}

function mapDshEvent(ev, sessionId, seq) {
  const ts = ev.time ?? ev.time0;
  const tsIso = ts != null ? epochToBeijing(ts) : null;
  const type = ev.type;
  let category = "other";
  let toolName = null;
  let callId = null;
  let model = null;

  if (type === "step/start") category = "step.start";
  else if (type === "reasoning-chunks") category = "llm.response";
  else if (type === "text-chunks") category = "llm.response";
  else if (type === "tool-call-chunks") category = "tool.call";
  else if (type === "assistant/chunk") category = "llm.response";
  else if (type === "tool/call") {
    category = "tool.call";
    toolName = ev.data?.name || null;
    callId = ev.data?.callId || null;
  } else if (type === "session/title-llm-request") {
    category = "llm.request";
    model = ev.data?.route?.model || null;
  } else if (type === "session/end-seed") {
    category = "other";
  }

  return {
    agent_object: "dsh",
    session_id: sessionId,
    event_category: category,
    event_type_raw: type,
    occurred_at: tsIso,
    source_seq: seq,
    tool_name: toolName,
    call_id: callId,
    routed_model: model,
    event_subtype: type.includes("reasoning") ? "reasoning" : type.includes("tool") ? "tool" : null,
    metadata: { turn: ev.data?.turn ?? null, step: ev.data?.step ?? null },
  };
}

async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

function epochToBeijing(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${String(d.getMilliseconds()).padStart(3, "0")}+08:00`;
}
