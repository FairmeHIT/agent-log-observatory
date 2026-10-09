#!/usr/bin/env node
/**
 * probe-doubao-cdp.mjs — Doubao CDP (Chrome DevTools Protocol) 可行性探测脚本
 *
 * 目的：验证方案 B — 通过 --remote-debugging-port 启动 Doubao，用 CDP 抓取
 *       LLM API 网络请求，获取 token/TTFT/model/retry 等指标。
 *
 * 用法：
 *   1. 检查当前 Doubao 是否已开启调试口
 *   2. 若未开启，提示用户重启 Doubao 并带调试参数
 *   3. 连接 CDP，启用 Network 域，抓取 30 秒网络事件
 *   4. 分析哪些指标可提取
 *
 * 依赖：Node.js >= 22（全局 WebSocket API）
 */

import http from "node:http";
import { execSync } from "node:child_process";

const DEBUG_PORT = 9223;
const CAPTURE_SECONDS = 30;

// ---- Step 1: Check if Doubao is running ----
function getDoubaoProcesses() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'Doubao.exe\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
      { encoding: "utf8", timeout: 10000 }
    );
    const procs = JSON.parse(out);
    return Array.isArray(procs) ? procs : [procs];
  } catch {
    return [];
  }
}

// ---- Step 2: HTTP helper ----
function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: DEBUG_PORT, path, timeout: 3000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function checkDebugPort() {
  try {
    const r = await httpGet("/json/version");
    if (r.status === 200) return { open: true, info: JSON.parse(r.body) };
    return { open: false, status: r.status };
  } catch (e) {
    return { open: false, error: e.message };
  }
}

async function listTargets() {
  try {
    const r = await httpGet("/json/list");
    return JSON.parse(r.body);
  } catch {
    return [];
  }
}

// ---- CDP over WebSocket (using Node >= 22 global WebSocket) ----
async function captureCDP(wsUrl, seconds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const events = [];
    const urls = new Set();
    let msgId = 0;
    const pending = new Map();

    ws.onopen = () => {
      console.log("  ✅ WebSocket connected");
      // Enable Network
      ws.send(JSON.stringify({ id: ++msgId, method: "Network.enable" }));
      console.log("  ✅ Network.enable sent");
    };

    ws.onmessage = (raw) => {
      try {
        const msg = JSON.parse(raw.data);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
          return;
        }
        if (msg.method === "Network.requestWillBeSent") {
          const url = msg.params?.request?.url || "";
          const method = msg.params?.request?.method;
          const ts = msg.params?.timestamp;
          const isLLM = /completion|chat|generate|llm|model|api|stream|inference/i.test(url);
          events.push({ type: "request", url, method, ts, isLLM });
          urls.add(url);
          if (isLLM) console.log(`  [REQ] ${method} ${url.substring(0, 130)}`);
        }
        if (msg.method === "Network.responseReceived") {
          const url = msg.params?.response?.url || "";
          const status = msg.params?.response?.status;
          const ts = msg.params?.timestamp;
          const ct = msg.params?.response?.headers?.["content-type"] || "";
          const isLLM = /completion|chat|generate|llm|model|api|stream|inference/i.test(url) || /event-stream|json/i.test(ct);
          events.push({ type: "response", url, status, ts, isLLM, contentType: ct });
          if (isLLM) console.log(`  [RES] ${status} ct=${ct} ${url.substring(0, 130)}`);
        }
        if (msg.method === "Network.loadingFailed") {
          events.push({ type: "failed", requestId: msg.params?.requestId, error: msg.params?.errorText, ts: msg.params?.timestamp });
        }
      } catch {}
    };

    ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message || e.type}`));
    ws.onclose = () => resolve({ events, urls: [...urls] });

    // Capture for N seconds then close
    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ events, urls: [...urls] });
    }, seconds * 1000);
  });
}

// ---- Main ----
async function main() {
  console.log("=== Doubao CDP Probe ===\n");

  // Step 1: Check running processes
  console.log("[1] Checking Doubao processes...");
  const procs = getDoubaoProcesses();
  if (procs.length === 0) {
    console.log("  Doubao is not running.");
    console.log(`  Start it with: Doubao.exe --remote-debugging-port=${DEBUG_PORT}`);
    process.exit(1);
  }
  console.log(`  Found ${procs.length} Doubao process(es):`);
  let hasDebugFlag = false;
  for (const p of procs) {
    const cl = p.CommandLine || "";
    console.log(`    pid=${p.ProcessId} cmdline=${cl.substring(0, 120)}`);
    if (cl.includes("remote-debugging-port")) hasDebugFlag = true;
  }

  // Step 2: Check debug port
  console.log(`\n[2] Checking debug port ${DEBUG_PORT}...`);
  const portCheck = await checkDebugPort();
  if (!portCheck.open) {
    console.log(`  ❌ Port ${DEBUG_PORT} is not open (${portCheck.error || portCheck.status})`);
    if (!hasDebugFlag) {
      console.log(`\n  Doubao was NOT started with --remote-debugging-port.`);
      console.log(`\n  To enable:`);
      console.log(`    1. Close Doubao completely (system tray too)`);
      console.log(`    2. Start it with:`);
      console.log(`       "D:\\02-software-install\\doubao-zijie\\Doubao\\app\\Doubao.exe" --remote-debugging-port=${DEBUG_PORT}`);
      console.log(`    3. Re-run this probe: node scripts/probe-doubao-cdp.mjs`);
      console.log(`\n  Note: If Doubao auto-starts on boot, modify the shortcut/registry to add the flag.`);
    }
    process.exit(1);
  }
  console.log(`  ✅ Port ${DEBUG_PORT} is OPEN`);
  console.log(`  Browser: ${portCheck.info.Browser || "unknown"}`);
  console.log(`  WS: ${portCheck.info.webSocketDebuggerUrl || "unknown"}`);

  // Step 3: List targets
  console.log(`\n[3] Listing CDP targets...`);
  const targets = await listTargets();
  console.log(`  Found ${targets.length} target(s):`);
  for (const t of targets) {
    console.log(`    type=${t.type} title=${(t.title || "").substring(0, 60)}`);
    console.log(`      url=${(t.url || "").substring(0, 100)}`);
  }

  // Prefer Doubao chat pages, then any page
  const pageTarget =
    targets.find((t) => (t.type === "page" || t.type === "webview") && (t.url || "").startsWith("doubao://") && /chat/i.test(t.url)) ||
    targets.find((t) => (t.type === "page" || t.type === "webview") && (t.url || "").startsWith("doubao://")) ||
    targets.find((t) => t.type === "page" || t.type === "webview");
  if (!pageTarget) {
    console.log("  ❌ No page/webview target found");
    process.exit(1);
  }
  console.log(`  → Selected target: ${pageTarget.title} (${pageTarget.url})`);

  const wsUrl = pageTarget.webSocketDebuggerUrl;
  if (!wsUrl) {
    console.log("  ❌ No WebSocket URL in target");
    process.exit(1);
  }

  // Step 4+5: Connect and capture
  console.log(`\n[4] Capturing network events for ${CAPTURE_SECONDS}s...`);
  console.log(`    ⚠️ Send a message in Doubao now to trigger LLM calls!\n`);

  let result;
  try {
    result = await captureCDP(wsUrl, CAPTURE_SECONDS);
  } catch (e) {
    console.log(`  ❌ CDP capture failed: ${e.message}`);
    process.exit(1);
  }

  // Step 6: Analyze
  const { events, urls } = result;
  console.log(`\n[6] Analysis (${CAPTURE_SECONDS}s):`);
  console.log(`  Total events: ${events.length}`);
  const reqs = events.filter((e) => e.type === "request");
  const resps = events.filter((e) => e.type === "response");
  const fails = events.filter((e) => e.type === "failed");
  console.log(`  Requests: ${reqs.length} | Responses: ${resps.length} | Failed: ${fails.length}`);

  const llmReqs = reqs.filter((e) => e.isLLM);
  const llmResps = resps.filter((e) => e.isLLM);
  console.log(`  LLM-related: ${llmReqs.length} req / ${llmResps.length} resp`);

  // Unique domains
  const domains = new Set();
  for (const u of urls) {
    try { domains.add(new URL(u).hostname); } catch {}
  }
  console.log(`\n  Domains contacted:`);
  for (const d of domains) console.log(`    ${d}`);

  // Content types seen
  const cts = new Set();
  for (const e of resps) { if (e.contentType) cts.add(e.contentType); }
  if (cts.size) {
    console.log(`\n  Content types:`);
    for (const ct of cts) console.log(`    ${ct}`);
  }

  // Step 7: Verdict
  console.log(`\n[7] Verdict:`);
  if (reqs.length > 0) {
    console.log(`  ✅ CDP connectivity works — captured ${reqs.length} requests`);
    console.log(`  ${llmReqs.length > 0 ? "✅" : "⚠️ "} LLM endpoints ${llmReqs.length > 0 ? `detected (${llmReqs.length})` : "not clearly identified by URL pattern"}`);
    console.log(`\n  Metrics extractable via CDP:`);
    console.log(`    timestamps   : ✅ Network.requestWillBeSent.timestamp`);
    console.log(`    retry/failure: ✅ Network.loadingFailed (${fails.length} seen)`);
    console.log(`    model        : ${llmReqs.length > 0 ? "✅ from request headers/postData" : "❓ depends on endpoint visibility"}`);
    console.log(`    token usage  : ${llmResps.length > 0 ? "✅ Network.getResponseBody on LLM responses" : "❓ need LLM response capture"}`);
    console.log(`    TTFT         : ${llmResps.length > 0 ? "✅ via Network.streamDataReceived (first chunk)" : "❓ need streaming capture"}`);
    console.log(`\n  Architecture if feasible:`);
    console.log(`    doubao-cdp-collector (Node script)`);
    console.log(`      ├── WebSocket → CDP Network.enable / Network.streamDataReceived`);
    console.log(`      ├── Filter LLM URLs → getResponseBody → parse usage`);
    console.log(`      ├── Record timestamps → TTFT / turn_e2e`);
    console.log(`      └── Write JSONL → observatory collector-reader consumes`);
    if (llmReqs.length === 0) {
      console.log(`\n  ⚠️ No LLM URLs matched — may need to adjust URL patterns or`);
      console.log(`     capture response bodies to identify LLM traffic.`);
    }
  } else {
    console.log(`  ⚠️ No requests captured — Doubao may be idle.`);
    console.log(`     Send a message in Doubao and re-run.`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
