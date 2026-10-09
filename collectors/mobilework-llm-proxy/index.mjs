// collectors/mobilework-llm-proxy/index.mjs
//
// 双模式 HTTP 代理：采集 Mobilework LLM 请求的 TTFT（request→first-response-byte）。
//
// 模式 1 — 正向代理（推荐，配合 HTTP_PROXY 环境变量）：
//   设 HTTP_PROXY=http://127.0.0.1:8890 后，opencode 引擎的所有 HTTP 请求
//   经过本代理。req.url 是完整 URL（http://host:port/path），代理解析后转发。
//   优点：不需修改 providers.jsonc，对所有 provider 生效。
//
// 模式 2 — 反向代理（配合 install-mobilework-proxy.mjs）：
//   providers.jsonc 的 baseURL 改为 http://127.0.0.1:8890/<prefix>
//   代理按 proxy-config.json 的 path_prefix → target 路由转发。
//
// 自动检测：req.url 以 http:// 或 https:// 开头 → 正向代理；否则 → 反向代理。
//
// session_id 处理：
//   HTTP 请求体是标准 OpenAI chat 格式，不含 session_id。
//   代理写 session_id: null，适配器用 time-window 匹配
//   （requested_at ∈ [session.time_created, session.time_updated]）。
//
// 落盘：runtime/collectors/mobilework/attempts-<YYYYMMDD>.jsonl
// 字段对齐 schemas/collector-attempt.schema.json（collector-attempt-0.1.0）。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getCollectorRoot, runtimePath } from "../../lib/runtime-paths.mjs";
import { URL } from "node:url";

const SCHEMA_VERSION = "collector-attempt-0.1.0";
const COLLECTOR_NAME = "mobilework-llm-proxy";
const COLLECTOR_VERSION = "0.2.0";
const COLLECTOR_DIR = path.join(getCollectorRoot(), "mobilework");

// ── config (for reverse proxy mode) ─────────────────────────────────
const CONFIG_PATH = process.env.AGENT_LOG_PROXY_CONFIG || runtimePath("mobilework-proxy.json");

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    return {
      port: cfg.port || 8890,
      host: cfg.host || "127.0.0.1",
      routes: Array.isArray(cfg.routes) ? cfg.routes : [],
    };
  } catch {
    return { port: 8890, host: "127.0.0.1", routes: [] };
  }
}

// ── helpers ─────────────────────────────────────────────────────────
function todayStamp() {
  const d = new Date();
  return (
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0")
  );
}

let attemptCounter = 0;

function appendAttempt(record) {
  try {
    fs.mkdirSync(COLLECTOR_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(COLLECTOR_DIR, `attempts-${todayStamp()}.jsonl`),
      JSON.stringify(record) + "\n"
    );
  } catch (e) {
    console.error("[mobilework-llm-proxy] append failed:", e?.message || e);
  }
}

/**
 * Find matching route by path prefix (longest prefix wins).
 * Only used in reverse proxy mode.
 */
function findRoute(reqUrl) {
  const pathname = new URL(reqUrl, "http://localhost").pathname;
  let best = null;
  let bestLen = 0;
  for (const r of CONFIG.routes) {
    if (pathname.startsWith(r.path_prefix) && r.path_prefix.length > bestLen) {
      best = r;
      bestLen = r.path_prefix.length;
    }
  }
  return best;
}

/**
 * Detect proxy mode from req.url.
 * Forward proxy: req.url starts with http:// or https:// (full URL)
 * Reverse proxy: req.url starts with / (path only)
 */
function isForwardProxy(reqUrl) {
  return reqUrl.startsWith("http://") || reqUrl.startsWith("https://");
}

/**
 * Buffer request body (for POST JSON) and extract `model` field.
 */
function bufferBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const MAX = 4 * 1024 * 1024;
    req.on("data", (c) => {
      if (size < MAX) {
        chunks.push(c);
        size += c.length;
      }
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks, size);
      let model = null;
      try {
        const json = JSON.parse(buf.toString("utf8"));
        model = json.model || null;
      } catch {}
      resolve({ bodyBuffer: buf, model });
    });
    req.on("error", () => resolve({ bodyBuffer: Buffer.alloc(0), model: null }));
  });
}

/**
 * Write collector attempt record.
 * @param {string} requestPath - the URL path (for diagnostics)
 */
function writeRecord(attemptId, requestedAt, firstOutputAt, streamEndedAt, model, httpStatus, errorKind, requestPath) {
  // 只采集 LLM 调用（/chat/completions 或 /completions），跳过 /models 等其他请求
  // 但仍转发所有请求，只是不写 collector 记录
  if (requestPath && !requestPath.includes("/completions") && !requestPath.includes("/chat/")) {
    return; // 非 LLM 调用，跳过采集
  }
  appendAttempt({
    schema_version: SCHEMA_VERSION,
    agent_object: "mobilework",
    installation_id: "default",
    session_id: null,
    turn_id: null,
    step_id: null,
    llm_call_id: null,
    attempt_id: attemptId,
    attempt_index: 0,
    is_retry: false,
    retry_of: null,
    requested_at: requestedAt,
    first_output_at: firstOutputAt,
    first_output_source: firstOutputAt != null ? "derived" : null,
    stream_ended_at: streamEndedAt,
    timestamp_basis: "epoch_ms",
    precision_ns: 1_000_000,
    provider: null,
    requested_model: model,
    routed_model: model,
    status: errorKind ? "error" : (httpStatus && httpStatus < 400 ? "ok" : "error"),
    error_kind: errorKind || null,
    http_status: httpStatus || null,
    usage: null,
    human_confirm: null,
    collector: COLLECTOR_NAME,
    collector_version: COLLECTOR_VERSION,
    collected_at: Date.now(),
  });
}

// ── proxy server ────────────────────────────────────────────────────
const CONFIG = loadConfig();

const server = http.createServer(async (req, res) => {
  // Handle CONNECT (HTTPS tunneling) — reject since LLM API is HTTP
  if (req.method === "CONNECT") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("[mobilework-llm-proxy] CONNECT not supported (LLM API is HTTP, not HTTPS)");
    return;
  }

  const requestedAt = Date.now();
  attemptCounter++;
  const attemptId = `mwproxy_${todayStamp()}_${attemptCounter}_${requestedAt}`;

  // Determine target URL based on proxy mode
  let targetUrl;
  let forwardMode;

  if (isForwardProxy(req.url)) {
    // Forward proxy mode: req.url is a full URL
    forwardMode = true;
    try {
      targetUrl = new URL(req.url);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("[mobilework-llm-proxy] invalid URL: " + req.url);
      return;
    }
  } else {
    // Reverse proxy mode: req.url is a path, find matching route
    forwardMode = false;
    const route = findRoute(req.url);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("[mobilework-llm-proxy] no matching route for " + req.url);
      return;
    }
    const incomingUrl = new URL(req.url, "http://localhost");
    targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, route.target);
  }

  // Buffer request body to extract model field
  const { bodyBuffer, model } = await bufferBody(req);

  // Forward headers
  const fwdHeaders = { ...req.headers };
  delete fwdHeaders["host"];
  delete fwdHeaders["connection"];
  delete fwdHeaders["proxy-connection"];
  delete fwdHeaders["proxy-authorization"];
  fwdHeaders["host"] = targetUrl.host;

  // Build request path (path + query, no host)
  const requestPath = targetUrl.pathname + targetUrl.search;

  // Log every request for diagnostics
  const isLlm = requestPath.includes("/completions") || requestPath.includes("/chat/");
  console.log(`[proxy] ${req.method} ${requestPath} model=${model || "-"} llm=${isLlm}`);

  const proxyReq = http.request(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: requestPath,
      method: req.method,
      headers: fwdHeaders,
    },
    (proxyRes) => {
      const firstOutputAt = Date.now();
      const httpStatus = proxyRes.statusCode || null;

      // Forward response to client
      const respHeaders = { ...proxyRes.headers };
      if (forwardMode) {
        // Add Via header for forward proxy compliance
        respHeaders["via"] = `1.1 mobilework-llm-proxy`;
      }
      res.writeHead(proxyRes.statusCode || 200, respHeaders);

      // Pipe body (handles SSE streaming)
      proxyRes.pipe(res);

      // On stream end, write collector record
      let streamEndedAt = null;
      res.on("finish", () => {
        streamEndedAt = Date.now();
        writeRecord(attemptId, requestedAt, firstOutputAt, streamEndedAt, model, httpStatus, null, requestPath);
      });
    }
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("[mobilework-llm-proxy] upstream error: " + (err?.message || err));
    }
    writeRecord(attemptId, requestedAt, null, null, model, null,
      String(err?.code || err?.message || "upstream_error").slice(0, 100), requestPath);
  });

  // Send buffered body to upstream
  if (bodyBuffer.length > 0) {
    proxyReq.end(bodyBuffer);
  } else {
    proxyReq.end();
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[mobilework-llm-proxy] listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[mobilework-llm-proxy] mode: dual (forward proxy via HTTP_PROXY env + reverse proxy via routes)`);
  console.log(`[mobilework-llm-proxy] forward proxy: set HTTP_PROXY=http://${CONFIG.host}:${CONFIG.port}`);
  if (CONFIG.routes.length > 0) {
    console.log(`[mobilework-llm-proxy] reverse proxy routes:`);
    for (const r of CONFIG.routes) {
      console.log(`  ${r.path_prefix} → ${r.target}`);
    }
  }
  console.log(`[mobilework-llm-proxy] collector dir: ${COLLECTOR_DIR}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
