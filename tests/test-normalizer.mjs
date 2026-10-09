import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, normalizeSession, normalizeUsageRecord } from "../lib/normalizer.mjs";
import { makeMetricResult, makeDataCompleteness, SCHEMA_VERSION } from "../lib/evidence.mjs";
import { percentile, computeTTftMs, computeSuccessRate, computeRetryRate, aggregateTokens, computeCacheHitRate, computeOutputTps } from "../lib/metrics.mjs";
import { deduplicateEvents, deduplicateUsageRecords, buildSessionTree, rootTreeSessionIds } from "../lib/correlator.mjs";
import { parseGoLogLine, parseElectronLogLine } from "../lib/log-parser.mjs";

describe("Normalizer", () => {
  test("normalizeEvent fills defaults", () => {
    const ev = normalizeEvent({ agent_object: "workbuddy", session_id: "s1", event_category: "tool.call" });
    assert.equal(ev.agent_object, "workbuddy");
    assert.equal(ev.event_category, "tool.call");
    assert.equal(ev.status, "unknown");
    assert.equal(ev.schema_version, SCHEMA_VERSION);
  });

  test("normalizeEvent preserves provided values", () => {
    const ev = normalizeEvent({ agent_object: "teleagent", session_id: "s1", event_category: "llm.request", occurred_at: "2026-09-29T10:00:00.000+08:00", routed_model: "NewApi/chat-flash", tool_name: "powershell" });
    assert.equal(ev.routed_model, "NewApi/chat-flash");
    assert.equal(ev.occurred_at, "2026-09-29T10:00:00.000+08:00");
  });

  test("normalizeSession fills defaults", () => {
    const s = normalizeSession({ agent_object: "mobilework", session_id: "s1" });
    assert.equal(s.agent_object, "mobilework");
    assert.equal(s.event_counts["llm.request"], 0);
    assert.equal(s.failure_attribution.gateway, 0);
  });

  test("normalizeUsageRecord preserves token fields", () => {
    const u = normalizeUsageRecord({ usage_record_id: "u1", input: 100, output: 50, cache_read: 80, credits: 0.5 });
    assert.equal(u.input, 100);
    assert.equal(u.output, 50);
    assert.equal(u.cache_read, 80);
    assert.equal(u.credits, 0.5);
    assert.equal(u.input_includes_cache, "unknown");
  });
});

describe("Evidence", () => {
  test("makeMetricResult captured", () => {
    const m = makeMetricResult("test", 42, { unit: "ms", state: "captured" });
    assert.equal(m.value, 42);
    assert.equal(m.state, "captured");
    assert.equal(m.unit, "ms");
  });

  test("makeMetricResult not-captured default", () => {
    const m = makeMetricResult("test", null, {});
    assert.equal(m.value, null);
    assert.equal(m.state, "not-captured");
  });

  test("makeDataCompleteness marks missing fields", () => {
    const d = makeDataCompleteness(["ttft", "retry"]);
    assert.equal(d.has_ttft, false);
    assert.equal(d.has_retry, false);
    assert.equal(d.has_tokens, true);
    assert.ok(d.missing_fields.includes("ttft"));
  });
});

describe("Metrics", () => {
  test("percentile handles empty", () => {
    const m = percentile([], 50);
    assert.equal(m.value, null);
    assert.equal(m.state, "not-captured");
  });

  test("percentile basic P50", () => {
    const m = percentile([1, 2, 3, 4, 5], 50);
    assert.equal(m.value, 3);
    assert.equal(m.state, "captured");
  });

  test("percentile P95 with 5 samples", () => {
    const m = percentile([10, 20, 30, 40, 50], 95);
    assert.equal(m.value, 50);
  });

  test("percentile insufficient_sample flag", () => {
    const m = percentile([1, 2], 50);
    assert.equal(m.missing_reason, "insufficient_sample");
  });

  test("computeTTftMs missing start", () => {
    const m = computeTTftMs({ attempt_id: "a1" });
    assert.equal(m.value, null);
    assert.equal(m.state, "not-captured");
    assert.equal(m.missing_reason, "missing_start");
  });

  test("computeTTftMs missing first chunk", () => {
    const m = computeTTftMs({ attempt_id: "a1", requested_at: 1000 });
    assert.equal(m.value, null);
    assert.equal(m.missing_reason, "missing_first_chunk");
  });

  test("computeTTftMs captured", () => {
    const m = computeTTftMs({ attempt_id: "a1", requested_at: 1000, first_output_at: 1500 });
    assert.equal(m.value, 500);
    assert.equal(m.state, "captured");
  });

  test("computeSuccessRate zero denominator", () => {
    const m = computeSuccessRate(0, 0);
    assert.equal(m.value, null);
    assert.equal(m.state, "not-captured");
  });

  test("computeSuccessRate all ok", () => {
    const m = computeSuccessRate(10, 0);
    assert.equal(m.value, 1);
  });

  test("computeRetryRate basic", () => {
    const m = computeRetryRate(2, 10);
    assert.equal(m.value, 0.2);
  });

  test("aggregateTokens sums correctly", () => {
    const records = [
      { input: 100, output: 50, cache_read: 80, credits: 0.5 },
      { input: 200, output: 60, cache_read: 90, credits: 0.3 },
    ];
    const r = aggregateTokens(records);
    assert.equal(r.input, 300);
    assert.equal(r.output, 110);
    assert.equal(r.cache_read, 170);
    assert.equal(r.credits, 0.8);
  });

  test("computeCacheHitRate basic (input includes cache)", () => {
    const records = [{ input: 100, cache_read: 80, input_includes_cache: true }, { input: 200, cache_read: 100, input_includes_cache: true }];
    const m = computeCacheHitRate(records);
    assert.equal(m.value, (80 + 100) / (100 + 200));
  });

  test("computeCacheHitRate basic (input excludes cache)", () => {
    const records = [{ input: 100, cache_read: 80, input_includes_cache: false }, { input: 200, cache_read: 100, input_includes_cache: false }];
    const m = computeCacheHitRate(records);
    assert.equal(m.value, (80 + 100) / ((100 + 80) + (200 + 100)));
  });

  test("computeOutputTps basic", () => {
    const m = computeOutputTps(1000, 5000);
    assert.equal(m.value, 200);
    assert.equal(m.unit, "tok/s");
  });

  test("computeOutputTps zero duration", () => {
    const m = computeOutputTps(1000, 0);
    assert.equal(m.value, null);
    assert.equal(m.state, "not-captured");
  });
});

describe("Correlator", () => {
  test("deduplicateEvents by event_id", () => {
    const events = [
      { event_id: "e1", session_id: "s1" },
      { event_id: "e1", session_id: "s1" },
      { event_id: "e2", session_id: "s1" },
    ];
    const r = deduplicateEvents(events);
    assert.equal(r.length, 2);
  });

  test("deduplicateUsageRecords by usage_record_id", () => {
    const records = [
      { usage_record_id: "u1", input: 100 },
      { usage_record_id: "u1", input: 100 },
      { usage_record_id: "u2", input: 200 },
      { input: 300 },
    ];
    const r = deduplicateUsageRecords(records);
    assert.equal(r.length, 3);
  });

  test("buildSessionTree builds parent-child", () => {
    const sessions = [
      { session_id: "root", parent_session_id: null },
      { session_id: "child1", parent_session_id: "root" },
      { session_id: "child2", parent_session_id: "root" },
    ];
    const { byId, children } = buildSessionTree(sessions);
    assert.ok(byId.has("root"));
    assert.equal(children.get("root").length, 2);
  });

  test("rootTreeSessionIds finds roots", () => {
    const sessions = [
      { session_id: "root", parent_session_id: null },
      { session_id: "child", parent_session_id: "root" },
      { session_id: "orphan", parent_session_id: "missing" },
    ];
    const roots = rootTreeSessionIds(sessions);
    assert.ok(roots.includes("root"));
    assert.ok(roots.includes("orphan"));
    assert.ok(!roots.includes("child"));
  });
});

describe("Log Parser", () => {
  test("parseGoLogLine extracts cost", () => {
    const line = '2026/09/28 15:39:56.047138 processor.go:744: [Info] [request_id:req-001] [cost] provider=NewApi tokens(in=25804 out=449 cacheRead=0) cost=$0.000000';
    const r = parseGoLogLine(line, "teleagent");
    assert.ok(r);
    assert.equal(r.tag, "cost");
    assert.equal(r.tokens_in, 25804);
    assert.equal(r.tokens_out, 449);
    assert.equal(r.tokens_cache_read, 0);
    assert.equal(r.provider, "NewApi");
  });

  test("parseGoLogLine extracts perm", () => {
    const line = '2026/09/28 15:39:54.792813 processor.go:1453: [Info] [request_id:req-001] [perm] tool=powershell action=allow by=powershell:*';
    const r = parseGoLogLine(line, "teleagent");
    assert.equal(r.tag, "perm");
    assert.equal(r.tool_name, "powershell");
    assert.equal(r.action, "allow");
    assert.equal(r.permission_by, "powershell:*");
  });

  test("parseGoLogLine extracts tool_instruction_review", () => {
    const line = '2026/09/28 15:39:55.572706 tool_instruction_review.go:208: [Info] [request_id:req-001] [tool_instruction_review] decision, toolID=powershell, result=1, action=allow, reason=no issues, approvalID=, durationMs=778';
    const r = parseGoLogLine(line, "teleagent");
    assert.equal(r.tag, "tool_instruction_review");
    assert.equal(r.tool_id, "powershell");
    assert.equal(r.result, 1);
    assert.equal(r.duration_ms, 778);
  });

  test("parseGoLogLine extracts resolveModel", () => {
    const line = '2026/09/28 15:39:43.395154 service.go:145: [Info] [request_id:req-001] resolveModel, return direct model: NewApi/chat-flash';
    const r = parseGoLogLine(line, "teleagent");
    assert.equal(r.tag, "resolveModel");
    assert.equal(r.model, "NewApi/chat-flash");
  });

  test("parseGoLogLine extracts session start", () => {
    const line = '2026/09/28 15:39:43.385939 service.go:1207: [Info] [request_id:req-001] Service Prompt start, session id:ses_test_001';
    const r = parseGoLogLine(line, "teleagent");
    assert.equal(r.tag, "session_start");
    assert.equal(r.session_id, "ses_test_001");
  });

  test("parseGoLogLine extracts prune", () => {
    const line = '2026/09/28 15:41:15.906758 compaction.go:694: [Info] [request_id:req-001] [prune] total=8212 pruned=0 candidates=0';
    const r = parseGoLogLine(line, "teleagent");
    assert.equal(r.tag, "prune");
    assert.equal(r.prune_total, 8212);
  });

  test("parseGoLogLine returns null for invalid", () => {
    const r = parseGoLogLine("not a log line", "teleagent");
    assert.equal(r, null);
  });

  test("parseElectronLogLine extracts error", () => {
    const line = '{"timestamp":"2026-09-29T08:57:08.162Z","level":"error","scope":"main","message":["test error"]}';
    const r = parseElectronLogLine(line, "workbuddy");
    assert.ok(r);
    assert.equal(r.level, "error");
    assert.equal(r.tag, "error");
    assert.equal(r.message, "test error");
  });
});
