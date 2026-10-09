// collectors/doubao-cdp-collector/index.mjs
//
// Doubao CDP Collector: 通过 Chrome DevTools Protocol 抓取豆包 LLM 网络请求，
// 采集 attempt 级时延（TTFT / token usage / retry）落盘到 Agent Log Observatory collector dir。
//
// 前提：Doubao 需以 --remote-debugging-port=9223 启动。
//   "D:\02-software-install\doubao-zijie\Doubao\app\Doubao.exe" --remote-debugging-port=9223
//
// 原理：
//   WebSocket → CDP Network 域
//     Network.requestWillBeSent  → requested_at + model/conversation (from postData)
//     Network.responseReceived   → http_status + content-type
//     Network.streamDataReceived → first_output_at (TTFT, 首个 data chunk)
//     Network.loadingFinished    → stream_ended_at + getResponseBody → SSE usage
//     Network.loadingFailed      → status=error + error_kind
//
// 落盘：runtime/collectors/doubao/attempts-<YYYYMMDD>.jsonl
// 字段对齐 schemas/collector-attempt.schema.json（collector-attempt-0.1.0）。

import fs from "node:fs";
import path from "node:path";
import { getCollectorRoot, runtimePath } from "../../lib/runtime-paths.mjs";
import http from "node:http";

const SCHEMA_VERSION = "collector-attempt-0.1.0";
const COLLECTOR_NAME = "doubao-cdp-collector";
const COLLECTOR_VERSION = "0.1.0";
const DEBUG_PORT = Number(process.env.DOUBAO_CDP_PORT || 9223);
const LLM_URL_PATTERN = /\/chat\/completion/i;
const RECONNECT_DELAY_MS = 5000;
const FLUSH_INTERVAL_MS = 2000;

const COLLECTOR_DIR = path.join(getCollectorRoot(), "doubao");
const DIAG_PATH = runtimePath("doubao-cdp-diag.jsonl");
const LOCK_PATH = runtimePath("doubao-cdp-collector.lock");

// Process lock: prevent multiple instances
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, "utf8").trim(), 10);
      if (pid && !process.kill(pid, 0)) {
        console.error(`[${COLLECTOR_NAME}] Another instance running (pid=${pid}). Exiting.`);
        process.exit(0);
      }
    }
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    return true;
  } catch { return true; } // if lock check fails, continue anyway
}

function releaseLock() {
  try { if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH); } catch {}
}

let writeQueue = [];
let flushTimer = null;

function todayStamp() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

function diag(line) {
  try {
    fs.mkdirSync(path.dirname(DIAG_PATH), { recursive: true });
    fs.appendFileSync(DIAG_PATH, JSON.stringify({ ts: Date.now(), ...line }) + "\n");
  } catch {}
}

function queueAttempt(record) {
  writeQueue.push(record);
  if (!flushTimer) {
    flushTimer = setTimeout(flushQueue, FLUSH_INTERVAL_MS);
  }
}

function flushQueue() {
  flushTimer = null;
  if (writeQueue.length === 0) return;
  try {
    fs.mkdirSync(COLLECTOR_DIR, { recursive: true });
    const file = path.join(COLLECTOR_DIR, `attempts-${todayStamp()}.jsonl`);
    const data = writeQueue.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFileSync(file, data);
    diag({ flushed: writeQueue.length });
  } catch (e) {
    diag({ flushError: e?.message });
  }
  writeQueue = [];
}

// ---- CDP HTTP helpers ----

function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: DEBUG_PORT, path: pathname, timeout: 3000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function findChatTarget() {
  const r = await httpGet("/json/list");
  const targets = JSON.parse(r.body);
  return (
    targets.find((t) => t.type === "page" && (t.url || "").includes("doubao-chat")) ||
    targets.find((t) => t.type === "page" && (t.url || "").startsWith("doubao://") && /chat/i.test(t.url)) ||
    targets.find((t) => t.type === "page" && (t.url || "").startsWith("doubao://")) ||
    targets.find((t) => t.type === "page")
  );
}

// ---- CDP timestamp: seconds since epoch (float) → epoch ms ----
function cdpToMs(ts) {
  return ts != null ? Math.round(ts * 1000) : null;
}

// ---- Extract metadata from request ----
function extractMeta(postData, url) {
  let model = null;
  let conversationId = null;
  let provider = null;

  // Try URL params first
  try {
    const u = new URL(url);
    conversationId = u.searchParams.get("conversation_id") || u.searchParams.get("conv_id") || null;
  } catch {}

  // Try postData JSON
  if (postData) {
    try {
      const body = JSON.parse(postData);
      model = body.model || body.model_id || body.deploy_name || body.parameters?.model || null;
      provider = body.provider || body.channel || null;
      conversationId = conversationId ||
        body.conversation_id || body.conversationId || body.conv_id ||
        body.client_meta?.conversation_id || body.metadata?.conversation_id || null;
    } catch {}
    // Regex fallback for model + conversation_id (postData may be deeply nested)
    if (!model) {
      const m = postData.match(/"model"\s*:\s*"([^"]+)"/);
      if (m) model = m[1];
    }
    if (!conversationId) {
      const c = postData.match(/"conversation_?[iI]d"\s*:\s*"([^"]+)"/);
      if (c) conversationId = c[1];
    }
  }

  return { model, conversationId, provider };
}

// ---- Parse SSE response body for usage ----
function parseUsageFromSSE(body) {
  if (!body) return null;

  // Strategy 0: Extract data from specific SSE events (Doubao uses custom event names)
  const sseEventPatterns = [
    /event:\s*SSE_REPLY_END\s*\ndata:\s*(\{[\s\S]*?\})(?=\n\nevent:|\n*$)/,
    /event:\s*FULL_MSG_NOTIFY\s*\ndata:\s*(\{[\s\S]*?\})(?=\n\nevent:|\n*$)/,
    /event:\s*STREAM_MSG_NOTIFY\s*\ndata:\s*(\{[\s\S]*?\})(?=\n\nevent:|\n*$)/,
  ];
  for (const pattern of sseEventPatterns) {
    const m = body.match(pattern);
    if (m) {
      try {
        const obj = JSON.parse(m[1]);
        const usage = obj.usage || obj.token_usage || obj.tokens || obj.usage_info;
        if (usage) return normalizeUsage(usage);
        if (obj.prompt_tokens != null || obj.input_tokens != null || obj.completion_tokens != null || obj.output_tokens != null) {
          return normalizeUsage(obj);
        }
      } catch {}
    }
  }

  // Strategy 1: Find the last SSE data payload that parses as JSON with usage
  const lines = body.split("\n");
  const dataPayloads = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload && payload !== "[DONE]") dataPayloads.push(payload);
    }
  }

  for (let i = dataPayloads.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(dataPayloads[i]);
      const usage = obj.usage || obj.token_usage || obj.tokens || obj.token || obj.usage_info;
      if (usage && typeof usage === "object") return normalizeUsage(usage);
      if (obj.prompt_tokens != null || obj.input_tokens != null || obj.completion_tokens != null || obj.output_tokens != null) {
        return normalizeUsage(obj);
      }
    } catch {}
  }

  // Strategy 2: Search for usage patterns in the raw body
  const inputMatch = body.match(/"prompt_tokens"\s*:\s*(\d+)/) ||
                     body.match(/"input_tokens"\s*:\s*(\d+)/) ||
                     body.match(/"input_token_count"\s*:\s*(\d+)/) ||
                     body.match(/"prompt_token_count"\s*:\s*(\d+)/);
  const outputMatch = body.match(/"completion_tokens"\s*:\s*(\d+)/) ||
                      body.match(/"output_tokens"\s*:\s*(\d+)/) ||
                      body.match(/"output_token_count"\s*:\s*(\d+)/) ||
                      body.match(/"completion_token_count"\s*:\s*(\d+)/);
  if (inputMatch || outputMatch) {
    return {
      input: inputMatch ? parseInt(inputMatch[1], 10) : null,
      output: outputMatch ? parseInt(outputMatch[1], 10) : null,
      cache_read: null,
      cache_write: null,
      reasoning: null,
    };
  }

  // Strategy 3: Search for nested usage object
  const usageBlock = body.match(/"usage"\s*:\s*\{([^}]{0,500})\}/);
  if (usageBlock) {
    try {
      const usage = JSON.parse("{" + usageBlock[1] + "}");
      return normalizeUsage(usage);
    } catch {}
  }

  return null;
}

function normalizeUsage(u) {
  return {
    input: u.prompt_tokens ?? u.input_tokens ?? u.input ?? u.prompt_token_count ?? u.input_token_count ?? null,
    output: u.completion_tokens ?? u.output_tokens ?? u.output ?? u.completion_token_count ?? u.output_token_count ?? null,
    cache_read: u.prompt_cache_hit_tokens ?? u.cache_read ?? u.cached_tokens ?? null,
    cache_write: u.prompt_cache_miss_tokens ?? u.cache_write ?? null,
    reasoning: u.reasoning_tokens ?? u.reasoning ?? u.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

// ---- Extract model from SSE body (if not in request) ----
function extractModelFromBody(body) {
  if (!body) return null;
  const m = body.match(/"model"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

// ---- Attempt tracker ----
// Key: requestId (CDP's unique request identifier)
const attempts = new Map();
const processedRequestIds = new Set(); // dedup across reconnects
let attemptCounter = 0;

function makeAttemptId(sessionHint) {
  attemptCounter++;
  return `doubao_${sessionHint || "default"}_${Date.now()}_${attemptCounter}`;
}

// ---- Main CDP connection ----
async function connectAndCapture() {
  // Check port
  try {
    await httpGet("/json/version");
  } catch {
    diag({ error: "cdp_port_closed", port: DEBUG_PORT });
    console.error(`[${COLLECTOR_NAME}] CDP port ${DEBUG_PORT} not open. Start Doubao with --remote-debugging-port=${DEBUG_PORT}`);
    return false;
  }

  const target = await findChatTarget();
  if (!target || !target.webSocketDebuggerUrl) {
    diag({ error: "no_target" });
    console.error(`[${COLLECTOR_NAME}] No Doubao chat target found`);
    return false;
  }

  console.log(`[${COLLECTOR_NAME}] Connecting to ${target.title} (${target.url})`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();

  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new Error(`WS: ${e.message || e.type}`));
      setTimeout(() => reject(new Error("WS connect timeout")), 10000);
    });
  } catch (e) {
    try { ws.close(); } catch {}
    throw e;
  }

  console.log(`[${COLLECTOR_NAME}] WebSocket connected`);

  const send = (method, params = {}) => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 15000);
    });
  };

  let eventCount = 0;
  let networkReady = false; // don't process events until Network.enable succeeds

  ws.onmessage = async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.data); } catch { return; }

    // Response to our command
    if (msg.id !== undefined) {
      const resolver = pending.get(msg.id);
      if (resolver) {
        resolver(msg);
        pending.delete(msg.id);
        if (msg.id === 1) networkReady = true; // Network.enable acknowledged
        return;
      }
      // Unmatched response — log it
      diag({ unmatchedResp: msg.id, error: msg.error?.message });
      return;
    }

    const method = msg.method;
    const params = msg.params;
    if (!method) return;
    eventCount++;
    if (!networkReady) return; // ignore events before Network.enable ack

    try {
      if (method === "Network.requestWillBeSent") {
        const { requestId, request, timestamp, wallTime } = params;
        const url = request?.url || "";
        if (!LLM_URL_PATTERN.test(url)) return;
        if (processedRequestIds.has(requestId)) return; // dedup across reconnects
        processedRequestIds.add(requestId);
        if (processedRequestIds.size > 5000) {
          const first = processedRequestIds.values().next().value;
          processedRequestIds.delete(first);
        }

        const meta = extractMeta(request?.postData, url);
        const sessionHint = meta.conversationId || "default";
        const aid = makeAttemptId(sessionHint);

        attempts.set(requestId, {
          attempt_id: aid,
          session_id: sessionHint,
          requested_at: wallTime ? Math.round(wallTime * 1000) : cdpToMs(timestamp),
          req_ts: timestamp, // CDP monotonic reference for converting other timestamps
          first_output_at: null,
          stream_ended_at: null,
          model: meta.model,
          provider: meta.provider || "doubao",
          http_status: null,
          loading_failed: false,
          error_kind: null,
          body_usage: null,
          url,
        });

        diag({ req: requestId, aid, model: meta.model, conv: meta.conversationId, hasPostData: !!request?.postData, pdLen: (request?.postData || "").length, pdSnippet: (request?.postData || "").substring(0, 300) });
      }

      else if (method === "Network.responseReceived") {
        const { requestId, response, timestamp } = params;
        const a = attempts.get(requestId);
        if (!a) return;
        a.http_status = response?.status || null;
        const ct = response?.headers?.["content-type"] || response?.headers?.["Content-Type"] || "";
        a.content_type = ct;
        // Convert CDP monotonic timestamp → epoch ms using request reference
        const respEpochMs = a.req_ts != null ? Math.round(a.requested_at + (timestamp - a.req_ts) * 1000) : cdpToMs(timestamp);
        diag({ resp: requestId, status: a.http_status, ct });
        // For SSE: headers arrival ≈ first output (fallback TTFT). For non-SSE: also use it.
        if (a.first_output_at == null) {
          a.first_output_at = respEpochMs;
          a.first_output_source = "derived";
        }
      }

      else if (method === "Network.streamDataReceived") {
        const { requestId, timestamp, dataLength } = params;
        const a = attempts.get(requestId);
        if (!a) return;
        // First data chunk = TTFT (native, for SSE streaming) — overrides derived
        if (a.first_output_source !== "native") {
          a.first_output_at = a.req_ts != null ? Math.round(a.requested_at + (timestamp - a.req_ts) * 1000) : cdpToMs(timestamp);
          a.first_output_source = "native";
          diag({ ttft_native: requestId, at: a.first_output_at, dataLength });
        }
      }

      else if (method === "Network.loadingFinished") {
        const { requestId, timestamp } = params;
        const a = attempts.get(requestId);
        if (!a) return;
        a.stream_ended_at = a.req_ts != null ? Math.round(a.requested_at + (timestamp - a.req_ts) * 1000) : cdpToMs(timestamp);
        diag({ finished: requestId, firstOutput: a.first_output_at, ct: a.content_type });

        // Try to get response body for usage extraction
        try {
          const bodyResp = await send("Network.getResponseBody", { requestId });
          const body = bodyResp?.result?.body || "";
          a.body_usage = parseUsageFromSSE(body);
          if (!a.model) a.model = extractModelFromBody(body);
          // Only structural metadata; never persist response text or fetch_token.
          diag({ body: requestId, len: body.length, usage: a.body_usage, hasModel: Boolean(a.model) });
        } catch (e) {
          diag({ bodyErr: requestId, err: e?.message });
        }

        finalizeAttempt(a);
        attempts.delete(requestId);
      }

      else if (method === "Network.loadingFailed") {
        const { requestId, errorText, timestamp, canceled } = params;
        const a = attempts.get(requestId);
        if (!a) return;
        a.loading_failed = true;
        a.error_kind = canceled ? "cancelled" : (errorText || "network_error");
        finalizeAttempt(a);
        attempts.delete(requestId);
      }
    } catch (e) {
      diag({ eventError: method, err: e?.message });
    }
  };

  ws.onclose = () => {
    console.log(`[${COLLECTOR_NAME}] WebSocket closed (events processed: ${eventCount})`);
  };

  ws.onerror = (e) => {
    diag({ wsError: e?.message || e.type });
  };

  // Enable Network — MUST be after ws.onmessage is set so the response is handled
  try {
    await send("Network.enable");
    console.log(`[${COLLECTOR_NAME}] Network.enable OK (events ignored before ack: ${eventCount})`);
  } catch (e) {
    console.error(`[${COLLECTOR_NAME}] Network.enable failed: ${e.message} (events received: ${eventCount})`);
    try { ws.close(); } catch {}
    throw e;
  }
  console.log(`[${COLLECTOR_NAME}] Capturing LLM attempts...`);

  return { ws, send, eventCount: () => eventCount };
}

function finalizeAttempt(a) {
  const status = a.loading_failed ? "error" : (a.http_status >= 200 && a.http_status < 400 ? "ok" : (a.http_status ? "error" : "ok"));

  const record = {
    schema_version: SCHEMA_VERSION,
    agent_object: "doubao",
    installation_id: "default",
    session_id: a.session_id,
    turn_id: null,
    step_id: null,
    llm_call_id: a.attempt_id,
    attempt_id: a.attempt_id,
    attempt_index: 0,
    is_retry: false,
    retry_of: null,
    requested_at: a.requested_at,
    first_output_at: a.first_output_at,
    first_output_source: a.first_output_at != null ? (a.first_output_source || "derived") : null,
    stream_ended_at: a.stream_ended_at,
    timestamp_basis: "epoch_ms",
    precision_ns: 1,
    provider: a.provider,
    requested_model: a.model,
    routed_model: a.model,
    status,
    error_kind: a.error_kind,
    http_status: a.http_status,
    usage: a.body_usage,
    human_confirm: null,
    collector: COLLECTOR_NAME,
    collector_version: COLLECTOR_VERSION,
    collected_at: Date.now(),
  };

  queueAttempt(record);
  diag({ finalized: a.attempt_id, status, ttft: a.first_output_at && a.requested_at ? a.first_output_at - a.requested_at : null, usage: a.body_usage });
}

// ---- Main loop with reconnection ----
// Uncaught error handling — log and keep running
process.on("uncaughtException", (e) => {
  diag({ uncaughtException: e?.message, stack: e?.stack?.substring(0, 300) });
  console.error(`[${COLLECTOR_NAME}] Uncaught:`, e?.message);
});
process.on("unhandledRejection", (e) => {
  diag({ unhandledRejection: e?.message || String(e) });
  console.error(`[${COLLECTOR_NAME}] Unhandled rejection:`, e?.message || e);
});

async function main() {
  if (!acquireLock()) return;
  console.log(`[${COLLECTOR_NAME}] v${COLLECTOR_VERSION} starting (port ${DEBUG_PORT}, pid=${process.pid})`);

  // Keep-alive heartbeat: prevents the event loop from going idle
  const heartbeat = setInterval(() => {
    // no-op — just keeps the process alive
  }, 30000);

  let consecutiveFailures = 0;

  try {
    while (true) {
      try {
        const conn = await connectAndCapture();
        if (conn) {
          consecutiveFailures = 0;
          console.log(`[${COLLECTOR_NAME}] Entering keep-alive wait...`);
          // Keep alive: resolve only when WebSocket closes
          await new Promise((resolve) => {
            conn.ws.addEventListener("close", resolve, { once: true });
          });
          console.log(`[${COLLECTOR_NAME}] WebSocket closed, reconnecting...`);
        }
      } catch (e) {
        consecutiveFailures++;
        diag({ connectError: e?.message, attempt: consecutiveFailures });
        console.error(`[${COLLECTOR_NAME}] Connection error: ${e.message} (retry in ${RECONNECT_DELAY_MS}ms)`);
      }
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  } catch (e) {
    console.error(`[${COLLECTOR_NAME}] Main loop fatal error:`, e);
    diag({ mainFatal: e?.message, stack: e?.stack?.substring(0, 500) });
  } finally {
    clearInterval(heartbeat);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log(`[${COLLECTOR_NAME}] Flushing and exiting...`);
  flushQueue();
  releaseLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  flushQueue();
  releaseLock();
  process.exit(0);
});
process.on("exit", () => { releaseLock(); });

main().catch((e) => {
  console.error(`[${COLLECTOR_NAME}] Fatal:`, e);
  process.exit(1);
});
