// lib/collector-reader.mjs
// 共享读取层：读取 Agent 侧采集器落盘的 attempt 级时延记录，复用 metrics.mjs 的计算函数。
//
// 设计约束：
// - 只读：不修改采集器文件。
// - 回退：文件不存在/解析失败时返回空数组，适配器回退到 not-captured，不抛错。
// - 字段对齐 lib/metrics.mjs::computeTTftMs(attempt) 的输入（requested_at / first_output_at / first_output_source）。
//
// 详见 docs/collector-design.md

import path from "node:path";
import { getCollectorRoot } from "./runtime-paths.mjs";
import fs from "node:fs/promises";
import { computeTTftMs } from "./metrics.mjs";
import { makeMetricResult } from "./evidence.mjs";

// 根路径可被环境变量覆盖，便于测试与自定义部署。动态读取，确保运行时设置的环境变量生效。


export function _collectorRoot() {
  return getCollectorRoot();
}

// 物理下限：远程 LLM API 的真实 TTFT 不可能 < 5ms（网络 RTT + prefill）。
// 仅对 epoch_ms 精度生效；monotonic_ns 精度足够时跳过。
const TTFT_PHYSICAL_FLOOR_MS = 5;

/**
 * 列出某 Agent 采集器目录下的全部 attempts-*.jsonl 文件路径。
 * @param {string} agentObject
 * @returns {Promise<string[]>}
 */
export async function listAttemptFiles(agentObject) {
  const dir = path.join(getCollectorRoot(), agentObject);
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((n) => n.startsWith("attempts-") && n.endsWith(".jsonl"))
      .map((n) => path.join(dir, n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 读取某 session 的全部 attempt 记录（跨多日文件）。
 * @param {string} agentObject
 * @param {string} sessionId
 * @param {object} [options]
 * @param {number} [options.limitDays] 只读最近 N 天文件（默认 30）
 * @returns {Promise<Array>} attempt 记录数组，可能为空
 */
export async function readAttempts(agentObject, sessionId, options = {}) {
  if (!agentObject || !sessionId) return [];
  const limitDays = options.limitDays ?? 30;
  const files = await listAttemptFiles(agentObject);
  if (files.length === 0) return [];
  // 只取最近 limitDays 天的文件
  const recent = files.slice(-limitDays);
  const out = [];
  let parseErrors = 0;
  for (const f of recent) {
    let content;
    try {
      content = await fs.readFile(f, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);
        if (rec.session_id === sessionId) out.push(rec);
      } catch {
        parseErrors++;
      }
    }
  }
  // 把 parseErrors 挂到数组上，供调用方记录 coverage（非破坏性）
  Object.defineProperty(out, "parseErrors", { value: parseErrors, enumerable: false });
  return out;
}

/**
 * 检测某 Agent 采集器目录是否已有数据（用于 capabilities.has_ttft 动态化）。
 * @param {string} agentObject
 * @returns {Promise<boolean>}
 */
export async function hasCollectorData(agentObject) {
  const files = await listAttemptFiles(agentObject);
  return files.length > 0;
}

/**
 * 读取某 Agent 全部 attempt 记录（不做 session_id 过滤），可选按时间范围过滤。
 * 用于 MITM 代理等无法从 HTTP 请求提取 session_id 的采集器——
 * 适配器用 session 的 [time_created, time_updated] 时间窗匹配 attempts。
 *
 * @param {string} agentObject
 * @param {object} [options]
 * @param {number} [options.since] 只读 requested_at >= since（epoch ms）
 * @param {number} [options.until] 只读 requested_at <= until（epoch ms）
 * @param {number} [options.limitDays] 只读最近 N 天文件（默认 30）
 * @returns {Promise<Array>} attempt 记录数组，可能为空
 */
export async function readAllAttempts(agentObject, options = {}) {
  if (!agentObject) return [];
  const limitDays = options.limitDays ?? 30;
  const files = await listAttemptFiles(agentObject);
  if (files.length === 0) return [];
  const recent = files.slice(-limitDays);
  const out = [];
  let parseErrors = 0;
  for (const f of recent) {
    let content;
    try {
      content = await fs.readFile(f, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);
        // 时间窗过滤（基于 requested_at）
        if (options.since != null && rec.requested_at != null && rec.requested_at < options.since) continue;
        if (options.until != null && rec.requested_at != null && rec.requested_at > options.until) continue;
        out.push(rec);
      } catch {
        parseErrors++;
      }
    }
  }
  Object.defineProperty(out, "parseErrors", { value: parseErrors, enumerable: false });
  return out;
}

/**
 * 从 attempts 中筛选 requested_at 落在 [since, until] 时间窗内的记录。
 * 适配器调用：用 session.time_created / time_updated 作为时间窗。
 *
 * @param {Array} attempts - readAllAttempts 的输出
 * @param {number} since - epoch ms（session.time_created）
 * @param {number} until - epoch ms（session.time_updated）
 * @returns {Array} 过滤后的 attempts
 */
export function filterByTimeWindow(attempts, since, until) {
  if (!Array.isArray(attempts)) return [];
  return attempts.filter((a) => {
    const t = a.requested_at;
    if (t == null) return false;
    if (since != null && t < since) return false;
    if (until != null && t > until) return false;
    return true;
  });
}

/**
 * 从 attempts 计算 TTFT 均值（复用 computeTTftMs）。
 *
 * 返回一个 session 级 MetricResult（对齐现有适配器 extractMetrics 的输出形态），
 * 内部逐 attempt 调用 computeTTftMs，过滤掉碰撞值，求均值。
 *
 * @param {Array} attempts
 * @param {string} sessionId
 * @returns {object} MetricResult
 */
export function computeTtftFromAttempts(attempts, sessionId) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return makeMetricResult("llm_attempt_ttft_ms", null, {
      unit: "ms", scope: "session", scope_id: sessionId,
      state: "not-captured", missing_reason: "not_instrumented",
      evidence_grade: "unknown",
    });
  }

  const eligible = [];
  let observed = 0;
  let collisions = 0;
  let missingFirstChunk = 0;

  for (const a of attempts) {
    // 复用 metrics.mjs 的单 attempt 计算
    const m = computeTTftMs({
      attempt_id: a.attempt_id,
      requested_at: a.requested_at,
      first_output_at: a.first_output_at,
      first_output_source: a.first_output_source,
    });
    if (m.state === "captured" && m.value != null) {
      // 碰撞防护：仅 epoch_ms 精度生效
      const isHighPrecision = a.timestamp_basis === "monotonic_ns";
      if (!isHighPrecision && m.value < TTFT_PHYSICAL_FLOOR_MS) {
        collisions++;
        continue;
      }
      eligible.push(m.value);
      observed++;
    } else if (m.missing_reason === "missing_first_chunk") {
      missingFirstChunk++;
    }
  }

  if (eligible.length === 0) {
    // 全部碰撞 or 全部缺首 chunk
    const reason = observed === 0 && collisions === 0
      ? "missing_first_chunk"
      : "timestamp_collision";
    return makeMetricResult("llm_attempt_ttft_ms", null, {
      unit: "ms", scope: "session", scope_id: sessionId,
      state: "not-captured", missing_reason: reason,
      evidence_grade: "unknown",
      coverage: { eligible: attempts.length, observed, finished: 0, collisions },
    });
  }

  const value = Math.round(eligible.reduce((s, v) => s + v, 0) / eligible.length);
  // evidence_grade：只要有任意一条是 native，整体记为 derived（均值是推导量）；
  // 若全部 native，仍记 derived（聚合语义），但 semantic_profile 标注。
  const anyNative = attempts.some((a) => a.first_output_source === "native");
  return makeMetricResult("llm_attempt_ttft_ms", value, {
    unit: "ms", scope: "session", scope_id: sessionId,
    state: "captured",
    evidence_grade: "derived",
    missing_reason: null,
    semantic_profile: "mean_attempt_ttft_first_chunk",
    coverage: {
      eligible: attempts.length,
      observed,
      finished: eligible.length,
      collisions,
    },
    comparable: eligible.length >= 5,
    // 额外标记数据来源
    source_refs: anyNative ? [{ source_id: "collector", source_kind: "jsonl" }] : [],
  });
}

/**
 * 从 attempts 计算 LLM 重试次数。
 * 重试判定：is_retry === true 或 attempt_index > 0。
 * @param {Array} attempts
 * @param {string} sessionId
 * @returns {object} MetricResult
 */
export function computeRetryFromAttempts(attempts, sessionId) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return makeMetricResult("llm_retry_count", null, {
      scope: "session", scope_id: sessionId,
      state: "not-captured", missing_reason: "not_instrumented",
    });
  }
  // 按 llm_call_id 分组，每组内 attempt_index > 0 或 is_retry 的计为重试
  const byCall = new Map();
  for (const a of attempts) {
    const key = a.llm_call_id || a.attempt_id;
    if (!byCall.has(key)) byCall.set(key, []);
    byCall.get(key).push(a);
  }
  let retryCount = 0;
  for (const [, group] of byCall) {
    for (const a of group) {
      if (a.is_retry === true || (a.attempt_index ?? 0) > 0) retryCount++;
    }
  }
  return makeMetricResult("llm_retry_count", retryCount, {
    scope: "session", scope_id: sessionId,
    state: "captured",
    evidence_grade: "direct",
    coverage: {
      eligible: attempts.length,
      observed: attempts.length,
      finished: attempts.length,
    },
    comparable: true,
  });
}

/**
 * 从 attempts 计算人工确认次数。
 * 采集器若在 human_confirm 字段记录了 required+decision，则计数。
 * @param {Array} attempts
 * @param {string} sessionId
 * @returns {object} MetricResult
 */
export function computeHumanConfirmFromAttempts(attempts, sessionId) {
  const withConfirm = Array.isArray(attempts)
    ? attempts.filter((a) => a.human_confirm && a.human_confirm.required)
    : [];
  if (withConfirm.length === 0) {
    return makeMetricResult("human_confirm_count", null, {
      scope: "session", scope_id: sessionId,
      state: "not-captured", missing_reason: "not_instrumented",
    });
  }
  const count = withConfirm.filter((a) => a.human_confirm.decision != null).length;
  return makeMetricResult("human_confirm_count", count, {
    scope: "session", scope_id: sessionId,
    state: "captured",
    evidence_grade: "direct",
    coverage: {
      eligible: attempts.length,
      observed: withConfirm.length,
      finished: count,
    },
    comparable: true,
  });
}
