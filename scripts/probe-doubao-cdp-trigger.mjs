#!/usr/bin/env node
/**
 * probe-doubao-cdp-trigger.mjs — 通过 CDP 在豆包聊天页发消息，触发 LLM 调用
 * 然后抓取网络事件，验证 token/TTFT 是否可提取。
 */
import http from "node:http";

const DEBUG_PORT = 9223;

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

async function findChatTarget() {
  const r = await httpGet("/json/list");
  const targets = JSON.parse(r.body);
  return (
    targets.find((t) => t.type === "page" && (t.url || "").includes("doubao-chat")) ||
    targets.find((t) => t.type === "page" && (t.url || "").includes("doubao://") && /chat/i.test(t.url)) ||
    targets.find((t) => t.type === "page" && (t.url || "").startsWith("doubao://"))
  );
}

async function main() {
  const target = await findChatTarget();
  if (!target) { console.error("No Doubao chat target found"); process.exit(1); }
  console.log(`Target: ${target.title} (${target.url})`);
  console.log(`WS: ${target.webSocketDebuggerUrl}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const events = [];

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`WS error: ${e.message || e.type}`));
  });
  console.log("Connected.");

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
        events.push({ type: "req", url, method: msg.params?.request?.method, ts: msg.params?.timestamp });
        console.log(`  [REQ] ${msg.params?.request?.method} ${url.substring(0, 140)}`);
      }
      if (msg.method === "Network.responseReceived") {
        const url = msg.params?.response?.url || "";
        const status = msg.params?.response?.status;
        const ct = msg.params?.response?.headers?.["content-type"] || "";
        events.push({ type: "resp", url, status, ct, ts: msg.params?.timestamp, requestId: msg.params?.requestId });
        console.log(`  [RES] ${status} ct=${ct.substring(0,40)} ${url.substring(0, 140)}`);
      }
      if (msg.method === "Network.loadingFinished") {
        events.push({ type: "finished", requestId: msg.params?.requestId, ts: msg.params?.timestamp });
      }
      if (msg.method === "Network.loadingFailed") {
        events.push({ type: "failed", requestId: msg.params?.requestId, error: msg.params?.errorText, ts: msg.params?.timestamp });
        console.log(`  [FAIL] ${msg.params?.errorText}`);
      }
    } catch {}
  };

  const send = (method, params = {}) => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 10000);
    });
  };

  // Enable Network
  await send("Network.enable");
  console.log("Network.enable OK");

  // Also enable Runtime for evaluating JS
  await send("Runtime.enable");
  console.log("Runtime.enable OK");

  // Step 1: Inspect the page to find the chat input
  console.log("\n--- Inspecting page for chat input ---");
  const inspect = await send("Runtime.evaluate", {
    expression: `(() => {
      const selectors = [
        'textarea[data-testid="chat-input"]',
        'textarea[placeholder*="输入"]',
        'textarea[placeholder*="消息"]',
        'textarea[placeholder*="问"]',
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]',
        'div[class*="input"] textarea',
        'div[class*="editor"]',
      ];
      const found = [];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          found.push({ sel, tag: el.tagName, cls: (el.className||'').substring(0,60), ph: el.placeholder||'', visible: el.offsetParent !== null });
        }
      }
      // Also check for any visible textareas
      const tas = document.querySelectorAll('textarea');
      for (const ta of tas) {
        found.push({ sel: 'textarea', tag: 'TEXTAREA', cls: (ta.className||'').substring(0,60), ph: ta.placeholder||'', visible: ta.offsetParent !== null });
      }
      return JSON.stringify(found.slice(0, 10));
    })()`,
    returnByValue: true,
  });
  console.log("Input candidates:", inspect.result?.value || "none");

  // Step 2: Try to find and type into the input
  const typeResult = await send("Runtime.evaluate", {
    expression: `(() => {
      // Try to find a visible input
      const tas = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')];
      const visible = tas.find(t => t.offsetParent !== null && t.offsetHeight > 10);
      if (!visible) return JSON.stringify({ ok: false, reason: 'no visible input' });
      visible.focus();
      // Set value directly
      if (visible.tagName === 'TEXTAREA' || visible.tagName === 'INPUT') {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(visible, '请用一句话介绍你自己');
        visible.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        visible.textContent = '请用一句话介绍你自己';
        visible.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return JSON.stringify({ ok: true, tag: visible.tagName, cls: (visible.className||'').substring(0,80) });
    })()`,
    returnByValue: true,
  });
  console.log("Type result:", typeResult.result?.value);

  // Step 3: Press Enter to send
  console.log("\nSending message (Enter key)...");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

  // Step 4: Capture for 20 seconds
  console.log("Capturing responses for 20s...");
  await new Promise((r) => setTimeout(r, 20000));

  // Analyze
  console.log("\n--- Analysis ---");
  console.log(`Total events: ${events.length}`);
  const reqs = events.filter((e) => e.type === "req");
  const resps = events.filter((e) => e.type === "resp");
  console.log(`Requests: ${reqs.length} | Responses: ${resps.length}`);

  // Show unique domains
  const domains = new Set();
  for (const e of [...reqs, ...resps]) {
    try { domains.add(new URL(e.url).hostname); } catch {}
  }
  console.log("Domains:", [...domains].join(", "));

  // Try to get response bodies for JSON responses (potential LLM responses)
  console.log("\n--- Fetching response bodies for JSON responses ---");
  const jsonResps = resps.filter((r) => (r.ct || "").includes("json"));
  for (const r of jsonResps.slice(0, 5)) {
    try {
      const body = await send("Network.getResponseBody", { requestId: r.requestId });
      const text = body.result?.body || "";
      console.log(`  ${r.url.substring(0, 80)}: ${text.substring(0, 300)}`);
      // Check for usage/token fields
      if (/usage|token|prompt_tokens|completion_tokens/i.test(text)) {
        console.log(`    ✅ TOKEN USAGE FOUND!`);
      }
    } catch (e) {
      console.log(`  ${r.url.substring(0, 80)}: body error - ${e.message}`);
    }
  }

  ws.close();
  console.log("\nDone.");
  process.exit(0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
