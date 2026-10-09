// collectors/opencode-collector-plugin/index.mjs
//
// OpenCode V2 plugin: 用 ctx.session.hook 注册 http.request/http.response/retry hooks，
// 采集 attempt 级时延（TTFT / retry）落盘到 Agent Log Observatory collector dir。
//
// 运行时探测确认：opencode v2.0.6 的 setup ctx 实际含 session.hook（.d.ts 为过时子集）。
// ctx.event.subscribe 返回的是全局 registry 事件（model/provider updated），不含 session 执行流；
// session 执行事件通过 ctx.session.hook("http.request"/"http.response"/"retry") 拿到。
//
// 文档依据（https://opencode.ai/v2/docs/build/plugins Hooks 章节）：
//   http.request  — event 含 sessionID/agent/model/kind/request（请求发出）
//   http.response — event 含 sessionID/agent/model/kind/response（响应头到达 ≈ 首 token）
//   retry         — event 含 sessionID/attempt/error/decision（重试决策）
//
// 落盘：runtime/collectors/opencode/attempts-<YYYYMMDD>.jsonl
// 字段对齐 schemas/collector-attempt.schema.json（collector-attempt-0.1.0）。

import fs from "node:fs";
import path from "node:path";
import { getCollectorRoot, runtimePath } from "../../lib/runtime-paths.mjs";

const SCHEMA_VERSION = "collector-attempt-0.1.0";
const COLLECTOR_NAME = "opencode-session-hook-plugin";
const COLLECTOR_VERSION = "0.3.0";
const COLLECTOR_DIR = path.join(getCollectorRoot(), "opencode");
const DIAG = runtimePath("plugin-hook-diag.jsonl");

function todayStamp() {
  const d = new Date();
  return (
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0")
  );
}

function appendAttempt(record) {
  try {
    fs.mkdirSync(COLLECTOR_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(COLLECTOR_DIR, `attempts-${todayStamp()}.jsonl`),
      JSON.stringify(record) + "\n"
    );
  } catch (e) {
    console.error("[opencode-collector] append failed:", e?.message || e);
  }
}

function diag(line) {
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, JSON.stringify(line) + "\n");
  } catch {}
}

// pending drafts: key = sessionID + ":" + kind
const drafts = new Map();

function draftKey(event) {
  return `${event.sessionID}:${event.kind || "primary"}`;
}

function modelRef(event) {
  const m = event.model || {};
  return { provider: m.providerID || null, model: m.modelID || m.id || null };
}

function finalizeDraft(d, firstOutputAt) {
  const mref = d.model_ref || {};
  appendAttempt({
    schema_version: SCHEMA_VERSION,
    agent_object: "opencode",
    installation_id: "default",
    session_id: d.session_id,
    turn_id: null,
    step_id: null,
    llm_call_id: d.call_id,
    attempt_id: d.call_id || `att_${d.session_id}_${d.requested_at}`,
    attempt_index: 0,
    is_retry: false,
    retry_of: null,
    requested_at: d.requested_at,
    first_output_at: firstOutputAt,
    // 响应头到达 ≈ 首 token，标 derived（非真实首 chunk，但足够接近）
    first_output_source: firstOutputAt != null ? "derived" : null,
    stream_ended_at: null,
    timestamp_basis: "epoch_ms",
    precision_ns: 1,
    provider: mref.provider,
    requested_model: mref.model,
    routed_model: mref.model,
    status: "ok",
    error_kind: null,
    http_status: d.http_status || null,
    usage: null,
    human_confirm: null,
    collector: COLLECTOR_NAME,
    collector_version: COLLECTOR_VERSION,
    collected_at: Date.now(),
  });
}

export default {
  id: "opencode-collector",
  async setup(ctx) {
    if (!ctx?.session || typeof ctx.session.hook !== "function") {
      console.error("[opencode-collector] ctx.session.hook unavailable");
      diag({ error: "no ctx.session.hook" });
      return;
    }

    let reqCounter = 0;

    try {
      await ctx.session.hook("http.request", (event) => {
        try {
          const kind = event?.kind || "primary";
          // 只采 primary（agent loop），忽略 compaction/title/generate
          if (kind !== "primary") return;
          const sid = event?.sessionID;
          if (!sid) { diag({ hk: "http.request", noSid: true, keys: event ? Object.keys(event) : [] }); return; }
          const now = Date.now();
          reqCounter++;
          const callId = `att_${sid}_${now}_${reqCounter}`;
          const mref = modelRef(event);
          drafts.set(draftKey(event), {
            session_id: sid,
            call_id: callId,
            requested_at: now,
            model_ref: mref,
            http_status: null,
          });
        } catch (e) {
          diag({ hk: "http.request", err: String(e?.message || e) });
        }
      });
    } catch (e) {
      diag({ hookRegErr: "http.request", err: String(e?.message || e) });
    }

    try {
      await ctx.session.hook("http.response", (event) => {
        try {
          const kind = event?.kind || "primary";
          if (kind !== "primary") return;
          const sid = event?.sessionID;
          if (!sid) return;
          const key = draftKey(event);
          const d = drafts.get(key);
          if (!d) { diag({ hk: "http.response", noDraft: true, key, keys: event ? Object.keys(event) : [] }); return; }
          const now = Date.now();
          const status = event?.response?.status || null;
          d.http_status = status;
          finalizeDraft(d, now);
          drafts.delete(key);
        } catch (e) {
          diag({ hk: "http.response", err: String(e?.message || e) });
        }
      });
    } catch (e) {
      diag({ hookRegErr: "http.response", err: String(e?.message || e) });
    }

    try {
      await ctx.session.hook("retry", (event) => {
        try {
          const sid = event?.sessionID;
          if (!sid) { diag({ hk: "retry", noSid: true, keys: event ? Object.keys(event) : [] }); return; }
          const attempt = typeof event?.attempt === "number" ? event.attempt : 1;
          const errKind =
            (event?.error && (event.error.type || event.error.status || event.error.code)) ||
            "retry";
          const now = Date.now();
          appendAttempt({
            schema_version: SCHEMA_VERSION,
            agent_object: "opencode",
            installation_id: "default",
            session_id: sid,
            turn_id: null,
            step_id: null,
            llm_call_id: null,
            attempt_id: `retry_${sid}_${attempt}_${now}`,
            attempt_index: attempt,
            is_retry: true,
            retry_of: null,
            requested_at: now,
            first_output_at: null,
            first_output_source: null,
            stream_ended_at: null,
            timestamp_basis: "epoch_ms",
            precision_ns: 1,
            provider: null,
            requested_model: null,
            routed_model: null,
            status: "error",
            error_kind: String(errKind),
            http_status: event?.error?.status || null,
            usage: null,
            human_confirm: null,
            collector: COLLECTOR_NAME,
            collector_version: COLLECTOR_VERSION,
            collected_at: now,
          });
        } catch (e) {
          diag({ hk: "retry", err: String(e?.message || e) });
        }
      });
    } catch (e) {
      diag({ hookRegErr: "retry", err: String(e?.message || e) });
    }

    // 清理：drafts 在 session 结束时未 finalize 的遗留（保守不处理，留给 reader）
    return () => {
      try { drafts.clear(); } catch {}
    };
  },
};
