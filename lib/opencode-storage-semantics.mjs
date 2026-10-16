// opencode 引擎存储级 token 口径（Mobilework 内嵌 opencode 与独立 opencode 共用同一存储结构）。
// 证据源：opencode packages/opencode/src/session/session.ts getUsage()
//   - tokens.input  = inputTokens - cacheReadInputTokens - cacheWriteInputTokens → input 不含 cache
//   - tokens.output = outputTokens - reasoningTokens → output 不含 reasoning
//   - cache read/write 是独立加性分项（AI SDK v6 归一化 inputTokens 已包含 cache tokens）
//   - totalTokens 不落库（session 表无 tokens_total 列），总量只能由分项按上述包含关系归一。
// lib/token-metrics.mjs usageTotal() 在该口径下算出 input+output+cache_read(+cache_write)+reasoning。
import {normalizeUsageRecord} from './normalizer.mjs';

export const OPENCODE_STORAGE_TOKEN_SEMANTICS = Object.freeze({
  input_includes_cache: false,
  output_includes_reasoning: false,
  cache_write_accounting: 'exclusive',
});

export function openencodeStorageUsageRecord(fields) {
  // 证明后的语义标志放在展开之后，防止调用方字段意外覆盖
  return normalizeUsageRecord({...fields, ...OPENCODE_STORAGE_TOKEN_SEMANTICS});
}
