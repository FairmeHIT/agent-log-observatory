import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import url from "node:url";
import {
  readAttempts,
  readAllAttempts,
  filterByTimeWindow,
  listAttemptFiles,
  hasCollectorData,
  computeTtftFromAttempts,
  computeRetryFromAttempts,
  computeHumanConfirmFromAttempts,
} from "../lib/collector-reader.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, "fixtures", "collector-sample");

// 在所有测试前设置环境变量，覆盖 collector 根路径
process.env.AGENT_LOG_COLLECTOR_ROOT = FIXTURE_ROOT;

test("listAttemptFiles 找到 opencode fixture 文件", async () => {
  const files = await listAttemptFiles("opencode");
  assert.ok(files.length >= 1, "应至少有 1 个 jsonl 文件");
  assert.ok(files[0].endsWith("attempts-20261003.jsonl"));
});

test("listAttemptFiles 不存在的 Agent 返回空数组", async () => {
  const files = await listAttemptFiles("nonexistent-agent");
  assert.deepEqual(files, []);
});

test("hasCollectorData 有数据时返回 true", async () => {
  assert.equal(await hasCollectorData("opencode"), true);
});

test("hasCollectorData 无数据时返回 false", async () => {
  assert.equal(await hasCollectorData("nonexistent-agent"), false);
});

test("readAttempts 按 sessionId 过滤记录", async () => {
  const attempts = await readAttempts("opencode", "ses_test001");
  assert.equal(attempts.length, 3, "ses_test001 应有 3 条 attempt");
  assert.ok(attempts.every((a) => a.session_id === "ses_test001"));
});

test("readAttempts 不同 session 不串数据", async () => {
  const attempts = await readAttempts("opencode", "ses_test002");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].session_id, "ses_test002");
});

test("readAttempts 空 sessionId 返回空数组", async () => {
  const attempts = await readAttempts("opencode", "");
  assert.deepEqual(attempts, []);
});

test("readAttempts 不存在的 session 返回空数组", async () => {
  const attempts = await readAttempts("opencode", "ses_nonexistent");
  assert.deepEqual(attempts, []);
});

test("readAttempts 不存在的 Agent 返回空数组", async () => {
  const attempts = await readAttempts("nonexistent-agent", "ses_test001");
  assert.deepEqual(attempts, []);
});

test("computeTtftFromAttempts monotonic_ns 高精度数据正常计算均值", async () => {
  const attempts = await readAttempts("opencode", "ses_test001");
  const m = computeTtftFromAttempts(attempts, "ses_test001");
  assert.equal(m.metric, "llm_attempt_ttft_ms");
  assert.equal(m.state, "captured");
  assert.equal(m.unit, "ms");
  // 三条 attempt 的 TTFT：71, 50, 112 → 均值 77.67 → round 78
  assert.equal(m.value, 78);
  assert.equal(m.coverage.eligible, 3);
  assert.equal(m.coverage.observed, 3);
  assert.equal(m.coverage.finished, 3);
  assert.equal(m.coverage.collisions, 0);
});

test("computeTtftFromAttempts epoch_ms 碰撞数据触发 timestamp_collision", async () => {
  const attempts = await readAttempts("opencode", "ses_test002");
  // ses_test002 的 delta=1ms，epoch_ms 精度 → 低于物理下限 5ms
  const m = computeTtftFromAttempts(attempts, "ses_test002");
  assert.equal(m.state, "not-captured");
  assert.equal(m.missing_reason, "timestamp_collision");
  assert.equal(m.coverage.collisions, 1);
  assert.equal(m.value, null);
});

test("computeTtftFromAttempts 空数组回退 not_instrumented", () => {
  const m = computeTtftFromAttempts([], "ses_empty");
  assert.equal(m.state, "not-captured");
  assert.equal(m.missing_reason, "not_instrumented");
  assert.equal(m.value, null);
});

test("computeRetryFromAttempts 正确计数重试", async () => {
  const attempts = await readAttempts("opencode", "ses_test001");
  const m = computeRetryFromAttempts(attempts, "ses_test001");
  assert.equal(m.metric, "llm_retry_count");
  assert.equal(m.state, "captured");
  // att_001_1 的 is_retry=true → 1 次重试
  assert.equal(m.value, 1);
});

test("computeRetryFromAttempts 空数组回退 not_instrumented", () => {
  const m = computeRetryFromAttempts([], "ses_empty");
  assert.equal(m.state, "not-captured");
  assert.equal(m.missing_reason, "not_instrumented");
});

test("computeHumanConfirmFromAttempts 检测到人工确认", async () => {
  const attempts = await readAttempts("opencode", "ses_test002");
  const m = computeHumanConfirmFromAttempts(attempts, "ses_test002");
  assert.equal(m.metric, "human_confirm_count");
  assert.equal(m.state, "captured");
  assert.equal(m.value, 1);
});

test("computeHumanConfirmFromAttempts 无确认数据回退", async () => {
  const attempts = await readAttempts("opencode", "ses_test001");
  const m = computeHumanConfirmFromAttempts(attempts, "ses_test001");
  assert.equal(m.state, "not-captured");
  assert.equal(m.missing_reason, "not_instrumented");
});

test("computeTtftFromAttempts 缺 first_output_at 标记 missing_first_chunk", () => {
  const attempts = [
    { attempt_id: "a1", requested_at: 1000, first_output_at: null, first_output_source: null, timestamp_basis: "monotonic_ns" },
  ];
  const m = computeTtftFromAttempts(attempts, "ses_x");
  assert.equal(m.state, "not-captured");
  assert.equal(m.missing_reason, "missing_first_chunk");
});

// ── readAllAttempts + filterByTimeWindow（mobilework MITM proxy 用例） ──

test("readAllAttempts 读取 mobilework 全部记录（session_id=null 不过滤）", async () => {
  const all = await readAllAttempts("mobilework");
  assert.ok(all.length >= 5, "mobilework fixture 应有 5 条 attempt");
  // 全部 session_id 为 null（MITM proxy 无法提取）
  assert.ok(all.every((a) => a.session_id === null), "session_id 应为 null");
});

test("readAllAttempts 不存在的 Agent 返回空数组", async () => {
  const all = await readAllAttempts("nonexistent-mw");
  assert.deepEqual(all, []);
});

test("readAllAttempts + filterByTimeWindow 按 session 时间窗匹配", async () => {
  // 模拟 session ses_f13bc4534ffeWakCAtnbIQ6O3T 的时间范围：
  // time_created ≈ 1790476590000, time_updated ≈ 1790476620000
  const since = 1790476590000;
  const until = 1790476620000;
  const all = await readAllAttempts("mobilework", { since, until });
  // 应匹配前 3 条（requested_at: 1790476590831, 1790476610052, 1790476615010）
  assert.equal(all.length, 3, "时间窗内应有 3 条 attempt");
  const filtered = filterByTimeWindow(all, since, until);
  assert.equal(filtered.length, 3);
  assert.ok(filtered.every((a) => a.requested_at >= since && a.requested_at <= until));
});

test("readAllAttempts + filterByTimeWindow 不同 session 不串数据", async () => {
  // 模拟另一个 session（时间范围在 1790670260000 ~ 1790670610000）
  const since = 1790670260000;
  const until = 1790670610000;
  const all = await readAllAttempts("mobilework", { since, until });
  // 应匹配后 2 条（requested_at: 1790670269219, 1790670281775）
  assert.equal(all.length, 2, "时间窗内应有 2 条 attempt");
});

test("computeTtftFromAttempts 对 mobilework proxy 数据计算真实 TTFT", async () => {
  // MITM proxy 的 TTFT = first_output_at - requested_at
  // 前 3 条 delta: 4309, 337, 220 → 均值 1622 → round 1622
  const since = 1790476590000;
  const until = 1790476620000;
  const all = await readAllAttempts("mobilework", { since, until });
  const matched = filterByTimeWindow(all, since, until);
  const m = computeTtftFromAttempts(matched, "ses_mw_test");
  assert.equal(m.state, "captured");
  assert.equal(m.coverage.collisions, 0, "MITM proxy 数据无碰撞");
  // delta: 4309, 337, 220 → 均值 = (4309+337+220)/3 = 1622
  assert.equal(m.value, 1622);
  assert.equal(m.evidence_grade, "derived");
});

test("computeTtftFromAttempts 对 mobilework proxy 数据不触发碰撞检测", async () => {
  // MITM proxy 的 delta 均 > 5ms 物理下限（最小 220ms）
  const all = await readAllAttempts("mobilework");
  const m = computeTtftFromAttempts(all, "ses_mw_all");
  assert.equal(m.state, "captured");
  assert.equal(m.coverage.collisions, 0);
});
