#!/usr/bin/env node
/**
 * probe-doubao-sse-usage.mjs — 通过 CDP 发一条测试消息，抓 /chat/completion 的完整 SSE 流，
 * 逐事件类型检查是否含 usage/token 字段（重点验证 FULL_MSG_NOTIFY）。
 * 同时抓所有 JSON 响应体中的 usage（quota/统计类接口）。
 */
import http from "node:http";

const DEBUG_PORT = 9223;

function httpGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: DEBUG_PORT, path: p, timeout: 3000 }, (res) => {
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
    targets.find((t) => t.type === "page" && (t.url || "").startsWith("doubao://"))
  );
}

const USAGE_RE = /"usage"|prompt_tokens|completion_tokens|input_tokens|output_tokens|cached_tokens|total_tokens|token_count|token_usage|"tokens"/i;

async function main() {
  const target = await findChatTarget();
  if (!target) { console.error("No Doubao chat target"); process.exit(1); }
  console.log(`Target: ${target.title}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const sseBodies = new Map();   // requestId -> full SSE text
  const jsonBodies = [];         // { url, text }
  const respMeta = new Map();    // requestId -> {url, ct}

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error(`WS error: ${e.message || e.type}`));
  });
  console.log("Connected.");

  ws.onmessage = async (raw) => {
    try {
      const msg = JSON.parse(raw.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === "Network.responseReceived") {
        const url = msg.params?.response?.url || "";
        const ct = msg.params?.response?.headers?.["content-type"] || "";
        respMeta.set(msg.params.requestId, { url, ct });
      }
      if (msg.method === "Network.loadingFinished") {
        const meta = respMeta.get(msg.params.requestId);
        if (!meta) return;
        const { url, ct } = meta;
        // 抓 SSE 流 + 所有 JSON 响应
        if (ct.includes("text/event-stream") || ct.includes("json")) {
          try {
            const body = await send("Network.getResponseBody", { requestId: msg.params.requestId });
            const text = (body.result?.body || "") + (body.result?.base64Encoded ? "" : "");
            if (ct.includes("event-stream")) {
              sseBodies.set(msg.params.requestId, { url, text });
              console.log(`  [SSE] ${url.substring(0, 100)} len=${text.length}`);
            } else if (USAGE_RE.test(text)) {
              jsonBodies.push({ url, text });
              console.log(`  [JSON+usage] ${url.substring(0, 100)}`);
            }
          } catch (e) {
            console.log(`  [body-err] ${meta.url.substring(0, 80)}: ${e.message}`);
          }
        }
      }
    } catch {}
  };

  const send = (method, params = {}) => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 15000);
    });
  };

  await send("Network.enable");
  console.log("Network.enable OK");

  // 找输入框并发消息
  const typeResult = await send("Runtime.evaluate", {
    expression: `(() => {
      const tas = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')];
      const visible = tas.find(t => t.offsetParent !== null && t.offsetHeight > 10);
      if (!visible) return JSON.stringify({ ok: false, reason: 'no visible input' });
      visible.focus();
      if (visible.tagName === 'TEXTAREA' || visible.tagName === 'INPUT') {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(visible, '请用一句话介绍你自己');
        visible.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        visible.textContent = '请用一句话介绍你自己';
        visible.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return JSON.stringify({ ok: true, tag: visible.tagName });
    })()`,
    returnByValue: true,
  });
  console.log("Type:", typeResult.result?.value);

  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  console.log("Sent. Capturing 25s...");

  await new Promise((r) => setTimeout(r, 25000));

  // ---- 分析 SSE ----
  console.log("\n=== SSE streams captured:", sseBodies.size, "===");
  for (const [rid, { url, text }] of sseBodies) {
    console.log(`\n--- ${url.substring(0, 100)} ---`);
    // 按事件类型统计
    const events = {};
    const samples = {};
    for (const line of text.split("\n")) {
      if (line.startsWith("event:")) {
        const t = line.slice(6).trim();
        events[t] = (events[t] || 0) + 1;
        if (!samples[t]) samples[t] = "";
      } else if (line.startsWith("data:") && Object.keys(events).length) {
        const lastEv = Object.keys(events).pop();
        if ((samples[lastEv] || "").length < 600) samples[lastEv] += line.substring(5).trim().substring(0, 600);
      }
    }
    for (const [t, n] of Object.entries(events)) {
      const s = samples[t] || "";
      const hasUsage = USAGE_RE.test(s);
      console.log(`  event=${t} count=${n} usage_like=${hasUsage}`);
      if (hasUsage || t === "FULL_MSG_NOTIFY" || t === "SSE_REPLY_END") {
        console.log(`    sample: ${s.substring(0, 500)}`);
      }
    }
    // 全文搜索
    console.log(`  FULL TEXT usage-like match: ${USAGE_RE.test(text)}`);
    const m = text.match(USAGE_RE);
    if (m) {
      const idx = text.indexOf(m[0]);
      console.log(`    context: ...${text.substring(Math.max(0, idx - 200), idx + 300)}...`);
    }
  }

  console.log("\n=== JSON responses with usage-like content:", jsonBodies.length, "===");
  for (const { url, text } of jsonBodies.slice(0, 5)) {
    console.log(`  ${url.substring(0, 120)}`);
    const m = text.match(USAGE_RE);
    if (m) {
      const idx = text.indexOf(m[0]);
      console.log(`    context: ...${text.substring(Math.max(0, idx - 150), idx + 350)}...`);
    }
  }

  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
