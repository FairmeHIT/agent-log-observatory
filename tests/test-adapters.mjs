import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { WorkBuddyAdapter } from "../adapters/workbuddy-adapter.mjs";
import { TeleAgentAdapter } from "../adapters/teleagent-adapter.mjs";
import { DoubaoAdapter } from "../adapters/doubao-adapter.mjs";
import { OpencodeAdapter } from "../adapters/opencode-adapter.mjs";
import { CodexAdapter, parseRolloutUsage, normalizeWinPath } from "../adapters/codex-adapter.mjs";
import { normalizeEvent } from "../lib/normalizer.mjs";
import { parseGoLogLine } from "../lib/log-parser.mjs";
import {
  computeTtftFromAttempts,
  computeRetryFromAttempts,
} from "../lib/collector-reader.mjs";

const fixtureDir = path.join(import.meta.dirname, "fixtures");

describe("WorkBuddy Adapter", () => {
  test("discover returns correct structure", async () => {
    const a = new WorkBuddyAdapter();
    const r = await a.discover();
    assert.equal(r.agent_object, "workbuddy");
    assert.ok(r.sources, "sources must exist");
    assert.equal(typeof r.available, "boolean");
    assert.equal(r.adapter_version, "0.2.0");
    assert.ok(Array.isArray(r.modes));
  });

  test("capabilities returns correct fields", async () => {
    const a = new WorkBuddyAdapter();
    const c = await a.capabilities();
    assert.equal(c.has_tokens, true);
    // has_ttft 动态化：取决于 trace generation spans 是否存在
    assert.equal(typeof c.has_ttft, "boolean");
    assert.equal(typeof c.trace_active, "boolean");
    assert.equal(c.has_human_confirm, false);
    assert.ok(Array.isArray(c.missing_fields));
  });

  test("fixture .jsonl parsing produces correct events", () => {
    const jsonlPath = path.join(fixtureDir, "workbuddy-sample", "fixture-session-001.jsonl");
    const content = fs.readFileSync(jsonlPath, "utf8");
    const events = [];
    let seq = 0;
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const obj = JSON.parse(t);
      const pd = obj.providerData || {};
      const ts = obj.timestamp;
      switch (obj.type) {
        case "message":
          if (obj.role === "user") {
            events.push(normalizeEvent({ event_category: "agent.input", event_type_raw: "message.user", occurred_at: null, source_seq: seq, session_id: "fixture", agent_object: "workbuddy" }));
          }
          if (obj.role === "assistant") {
            events.push(normalizeEvent({ event_category: "llm.response", event_type_raw: "message.assistant", session_id: "fixture", agent_object: "workbuddy", routed_model: pd.model }));
          }
          break;
        case "function_call":
          events.push(normalizeEvent({ event_category: "tool.call", event_type_raw: "function_call", session_id: "fixture", agent_object: "workbuddy", tool_name: obj.name, call_id: obj.callId, routed_model: pd.model }));
          break;
        case "function_call_result":
          events.push(normalizeEvent({ event_category: "tool.result", event_type_raw: "function_call_result", session_id: "fixture", agent_object: "workbuddy", tool_name: obj.name, call_id: obj.callId, status: obj.status }));
          break;
      }
      seq++;
    }
    assert.ok(events.length >= 6, "should have at least 6 events");
    assert.ok(events.some(e => e.event_category === "agent.input"));
    assert.ok(events.some(e => e.event_category === "tool.call"));
    assert.ok(events.some(e => e.event_category === "tool.result"));
    assert.ok(events.some(e => e.event_category === "llm.response"));
  });

  test("fixture rawUsage fields are correct", () => {
    const jsonlPath = path.join(fixtureDir, "workbuddy-sample", "fixture-session-001.jsonl");
    const content = fs.readFileSync(jsonlPath, "utf8");
    let foundCost = false;
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const obj = JSON.parse(t);
      const raw = obj?.providerData?.rawUsage;
      if (raw) {
        assert.ok(raw.prompt_tokens != null, "prompt_tokens must exist");
        assert.ok(raw.completion_tokens != null, "completion_tokens must exist");
        assert.ok(raw.prompt_cache_hit_tokens != null, "prompt_cache_hit_tokens must exist");
        assert.ok(raw.credit != null, "credit must exist");
        foundCost = true;
      }
    }
    assert.ok(foundCost, "at least one rawUsage entry must exist");
  });

  test("trace generation spans produce captured TTFT", async () => {
    const a = new WorkBuddyAdapter();
    // 用 fixture dataDir 覆盖，指向 workbuddy-sample（含 traces/ 子目录）
    const fixtureDataDir = path.join(fixtureDir, "workbuddy-sample");
    const origDataDir = process.env.AGENT_LOG_WORKBUDDY_DATADIR;
    process.env.AGENT_LOG_WORKBUDDY_DATADIR = fixtureDataDir;
    try {
      const genSpans = await a._readGenerationSpans("fixture-session-001");
      assert.ok(genSpans.length >= 3, "should find at least 3 generation spans");
      const attempts = a._generationSpansToAttempts(genSpans, "fixture-session-001");
      assert.equal(attempts.length, genSpans.length);
      // 验证 attempt 字段
      assert.ok(attempts[0].requested_at != null);
      assert.ok(attempts[0].first_output_at != null);
      assert.equal(attempts[0].first_output_source, "derived");
      assert.equal(attempts[0].timestamp_basis, "epoch_ms");
      // computeTtftFromAttempts 计算 TTFT 均值
      const ttft = computeTtftFromAttempts(attempts, "fixture-session-001");
      assert.equal(ttft.state, "captured");
      assert.equal(ttft.metric, "llm_attempt_ttft_ms");
      // 3 个 span：3000ms, 3500ms, 3000ms → 均值 3166ms
      assert.equal(ttft.value, 3167);
      assert.equal(ttft.coverage.eligible, 3);
      assert.equal(ttft.coverage.collisions, 0);
    } finally {
      if (origDataDir) process.env.AGENT_LOG_WORKBUDDY_DATADIR = origDataDir;
      else delete process.env.AGENT_LOG_WORKBUDDY_DATADIR;
    }
  });

  test("trace capabilities reflect fixture data", async () => {
    const a = new WorkBuddyAdapter();
    const fixtureDataDir = path.join(fixtureDir, "workbuddy-sample");
    const origDataDir = process.env.AGENT_LOG_WORKBUDDY_DATADIR;
    process.env.AGENT_LOG_WORKBUDDY_DATADIR = fixtureDataDir;
    try {
      const c = await a.capabilities();
      assert.equal(c.has_ttft, true, "fixture traces should enable has_ttft");
      assert.equal(c.trace_active, true);
      assert.ok(!c.missing_fields.includes("ttft"));
    } finally {
      if (origDataDir) process.env.AGENT_LOG_WORKBUDDY_DATADIR = origDataDir;
      else delete process.env.AGENT_LOG_WORKBUDDY_DATADIR;
    }
  });
});

describe("TeleAgent Adapter", () => {
  test("discover returns correct structure", async () => {
    const a = new TeleAgentAdapter();
    const r = await a.discover();
    assert.equal(r.agent_object, "teleagent");
    assert.ok(r.sources);
    assert.equal(typeof r.available, "boolean");
  });

  test("capabilities returns correct fields", async () => {
    const a = new TeleAgentAdapter();
    const c = await a.capabilities();
    assert.equal(c.has_tokens, true);
    assert.equal(c.has_human_confirm, true);
  });

  test("fixture Go log parsing extracts cost lines", () => {
    const logPath = path.join(fixtureDir, "teleagent-sample", "super-agent-server-fixture.log");
    const content = fs.readFileSync(logPath, "utf8");
    let costCount = 0, permCount = 0, errorCount = 0, modelCount = 0, pruneCount = 0;
    for (const line of content.split("\n")) {
      const parsed = parseGoLogLine(line, "teleagent");
      if (!parsed) continue;
      if (parsed.tag === "cost") costCount++;
      if (parsed.tag === "perm") permCount++;
      if (parsed.tag === "error") errorCount++;
      if (parsed.tag === "resolveModel") modelCount++;
      if (parsed.tag === "prune") pruneCount++;
    }
    assert.equal(costCount, 2);
    assert.equal(permCount, 1);
    assert.equal(errorCount, 1);
    assert.equal(modelCount, 1);
    assert.equal(pruneCount, 1);
  });

  test("fixture cost line extracts correct token values", () => {
    const logPath = path.join(fixtureDir, "teleagent-sample", "super-agent-server-fixture.log");
    const content = fs.readFileSync(logPath, "utf8");
    for (const line of content.split("\n")) {
      const parsed = parseGoLogLine(line, "teleagent");
      if (parsed?.tag === "cost") {
        assert.ok(parsed.tokens_in != null);
        assert.ok(parsed.tokens_out != null);
        assert.ok(parsed.tokens_cache_read != null);
        assert.equal(parsed.provider, "NewApi");
        return;
      }
    }
    assert.fail("no cost line found");
  });
});

describe("Doubao Adapter", () => {
  test("discover returns correct structure", async () => {
    const a = new DoubaoAdapter();
    const r = await a.discover();
    assert.equal(r.agent_object, "doubao");
    assert.ok(r.sources);
  });

  test("capabilities returns correct fields", async () => {
    const a = new DoubaoAdapter();
    const c = await a.capabilities();
    // Capabilities are dynamic: when collector data exists, has_tokens/has_ttft become true
    assert.equal(typeof c.has_tokens, "boolean");
    assert.equal(typeof c.has_ttft, "boolean");
    assert.equal(c.has_human_confirm, true);
    assert.equal(typeof c.collector_active, "boolean");
  });

  test("fixture trajectory has correct structure", () => {
    const trajPath = path.join(fixtureDir, "doubao-sample", "trajectory.jsonl");
    const content = fs.readFileSync(trajPath, "utf8");
    let userCount = 0, assistantCount = 0, toolCount = 0, toolCallsCount = 0;
    let humanConfirms = 0;
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const obj = JSON.parse(t);
      if (obj.role === "user") {
        userCount++;
        if (/^(确认|完成|是|是的)$/.test((obj.content||"").trim())) humanConfirms++;
      }
      if (obj.role === "assistant") {
        assistantCount++;
        if (obj.tool_calls) toolCallsCount += obj.tool_calls.length;
      }
      if (obj.role === "tool") toolCount++;
    }
    assert.ok(userCount >= 3);
    assert.ok(assistantCount >= 3);
    assert.ok(toolCount >= 3);
    assert.ok(toolCallsCount >= 3);
    assert.ok(humanConfirms >= 1, "should detect at least 1 human confirm");
  });
});

describe("Opencode Adapter + Collector integration", () => {
  test("capabilities reflects collector presence", async () => {
    const a = new OpencodeAdapter();
    const c = await a.capabilities();
    // 采集器无数据时 has_ttft=false；有数据时=true（取决于测试环境）
    assert.equal(typeof c.has_ttft, "boolean");
    assert.equal(typeof c.collector_active, "boolean");
  });

  test("collector attempts produce captured TTFT and retry", () => {
    // 用 collector-reader 直接验证 opencode fixture 的 attempt 数据
    const fixtureRoot = path.join(fixtureDir, "collector-sample");
    const origRoot = process.env.AGENT_LOG_COLLECTOR_ROOT;
    process.env.AGENT_LOG_COLLECTOR_ROOT = fixtureRoot;
    try {
      // readAttempts 是 async，但这里用同步 fixture 校验计算函数
      const fsSync = fs.readFileSync(
        path.join(fixtureRoot, "opencode", "attempts-20261003.jsonl"),
        "utf8"
      );
      const attempts = fsSync
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((a) => a.session_id === "ses_test001");
      const ttft = computeTtftFromAttempts(attempts, "ses_test001");
      assert.equal(ttft.state, "captured");
      assert.equal(ttft.value, 78);
      const retry = computeRetryFromAttempts(attempts, "ses_test001");
      assert.equal(retry.state, "captured");
      assert.equal(retry.value, 1);
    } finally {
      if (origRoot) process.env.AGENT_LOG_COLLECTOR_ROOT = origRoot;
      else delete process.env.AGENT_LOG_COLLECTOR_ROOT;
    }
  });
});

describe("Codex Adapter", () => {
  test("capabilities no longer claim cache fields missing", async () => {
    const a = new CodexAdapter();
    const c = await a.capabilities();
    assert.equal(c.has_tokens, true);
    assert.ok(Array.isArray(c.missing_fields));
    // rollout token_usage_record 提供 cache 分项后，missing_fields 不再声明 cache_read/cache_write
    assert.ok(!c.missing_fields.includes("cache_read"));
    assert.ok(!c.missing_fields.includes("cache_write"));
    assert.ok(c.missing_fields.includes("credits"));
    assert.ok(c.missing_fields.includes("retry"));
  });

  test("parseRolloutUsage extracts per-call token breakdown", () => {
    const content = fs.readFileSync(
      path.join(fixtureDir, "codex-sample", "rollout-usage.jsonl"),
      "utf8"
    );
    const r = parseRolloutUsage(content, "fixture-thread-001");
    assert.ok(r, "fixture must contain usage records");
    assert.equal(r.records.length, 2, "two token_usage_record lines (broken line skipped)");
    // 每条 usage 是单次调用值；turn_token_usage 累计值不得被使用
    const sum = (key) => r.records.reduce((s, x) => s + (x[key] ?? 0), 0);
    assert.equal(sum("input"), 21152 + 24037);
    assert.equal(sum("output"), 112 + 151);
    assert.equal(sum("reasoning"), 10 + 20);
    assert.equal(sum("cache_read"), 3712 + 18944);
    assert.equal(sum("reported_total"), 21264 + 24188);
    // 语义标记：input 含 cache、output 含 reasoning（total == input + output）
    for (const rec of r.records) {
      assert.equal(rec.input_includes_cache, true);
      assert.equal(rec.output_includes_reasoning, true);
      assert.equal(rec.reported_total, rec.input + rec.output);
    }
    // 运行时 context window 来自 event_msg/token_count
    assert.equal(r.contextWindow, 121600);
    // 峰值输入
    assert.equal(r.maxInput, 24037);
    // scope 归属
    assert.equal(r.records[0].scope, "session");
    assert.equal(r.records[0].scope_id, "fixture-thread-001");
  });

  test("parseRolloutUsage returns null without usage records", () => {
    const content = '{"timestamp":"x","type":"session_meta","payload":{}}\n';
    assert.equal(parseRolloutUsage(content, "any"), null);
    assert.equal(parseRolloutUsage("", "any"), null);
  });

  test("normalizeWinPath strips Windows extended-length prefixes", () => {
    assert.equal(normalizeWinPath("\\\\?\\C:\\Users\\x\\rollout.jsonl"), "C:\\Users\\x\\rollout.jsonl");
    assert.equal(normalizeWinPath("\\\\?\\UNC\\wsl.localhost\\Ubuntu\\a.jsonl"), "\\\\wsl.localhost\\Ubuntu\\a.jsonl");
    assert.equal(normalizeWinPath("C:\\plain\\path.jsonl"), "C:\\plain\\path.jsonl");
    assert.equal(normalizeWinPath("\\\\server\\share\\a.jsonl"), "\\\\server\\share\\a.jsonl");
    assert.equal(normalizeWinPath(null), null);
    assert.equal(normalizeWinPath(""), null);
  });
});
