import { normalizeEvent } from "./normalizer.mjs";

export function parseGoLogLine(line, agentObject) {
  const match = line.match(
    /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+(\S+):\s+\[(\w+)\](?:\s+\[request_id:([^\]]+)\])?\s*(.*)$/
  );
  if (!match) return null;
  const [, tsStr, source, level, requestId, message] = match;
  const ts = new Date(tsStr.replace(/\//g, "-")).getTime();
  if (Number.isNaN(ts)) return null;

  const result = {
    timestamp: ts,
    level: level.toLowerCase(),
    source_file: source,
    request_id: requestId || null,
    raw_message: message,
    agent_object: agentObject,
  };

  const costMatch = message.match(/\[cost\]\s+provider=(\S+)\s+tokens\(in=(\d+)\s+out=(\d+)\s+cacheRead=(\d+)\)\s+cost=\$([\d.]+)/);
  if (costMatch) {
    result.tag = "cost";
    result.provider = costMatch[1];
    result.tokens_in = parseInt(costMatch[2], 10);
    result.tokens_out = parseInt(costMatch[3], 10);
    result.tokens_cache_read = parseInt(costMatch[4], 10);
    result.cost = parseFloat(costMatch[5]);
    return result;
  }

  const permMatch = message.match(/\[perm\]\s+tool=(\S+)\s+action=(\S+)\s+by=(\S+)/);
  if (permMatch) {
    result.tag = "perm";
    result.tool_name = permMatch[1];
    result.action = permMatch[2];
    result.permission_by = permMatch[3];
    return result;
  }

  const reviewMatch = message.match(/\[tool_instruction_review\]\s+(\w+),\s+toolID=([^,]+),\s+result=(\d+),\s+action=([^,\s]+)(?:,\s+reason=([^,]*))?(?:,\s+approvalID=([^,]*))?(?:,\s+durationMs=(\d+))?/);
  if (reviewMatch) {
    result.tag = "tool_instruction_review";
    result.review_phase = reviewMatch[1];
    result.tool_id = reviewMatch[2];
    result.result = parseInt(reviewMatch[3], 10);
    result.action = reviewMatch[4];
    result.reason = reviewMatch[5] || null;
    result.approval_id = reviewMatch[6] || null;
    result.duration_ms = reviewMatch[7] ? parseInt(reviewMatch[7], 10) : null;
    return result;
  }

  const pruneMatch = message.match(/\[prune\]\s+total=(\d+)\s+pruned=(\d+)\s+candidates=(\d+)/);
  if (pruneMatch) {
    result.tag = "prune";
    result.prune_total = parseInt(pruneMatch[1], 10);
    result.prune_pruned = parseInt(pruneMatch[2], 10);
    result.prune_candidates = parseInt(pruneMatch[3], 10);
    return result;
  }

  const modelMatch = message.match(/resolveModel,\s+return\s+(?:direct\s+)?model:\s+(\S+)/);
  if (modelMatch) {
    result.tag = "resolveModel";
    result.model = modelMatch[1];
    return result;
  }

  const sessionMatch = message.match(/Service Prompt start,\s+session id:(\S+)/);
  if (sessionMatch) {
    result.tag = "session_start";
    result.session_id = sessionMatch[1];
    return result;
  }

  const httpMatch = message.match(/(receive|finish)\s+request\s+method=(\S+)\s+path=(\S+)(?:\s+status=(\d+))?(?:\s+latency=([\d.µ]+))?/);
  if (httpMatch) {
    result.tag = "http";
    result.http_phase = httpMatch[1];
    result.method = httpMatch[2];
    result.path = httpMatch[3];
    result.status = httpMatch[4] ? parseInt(httpMatch[4], 10) : null;
    result.latency_raw = httpMatch[5] || null;
    return result;
  }

  result.tag = level === "Error" ? "error" : "other";
  return result;
}

export function parseElectronLogLine(line, agentObject) {
  try {
    const obj = JSON.parse(line);
    if (!obj.timestamp) return null;
    return {
      timestamp: new Date(obj.timestamp).getTime(),
      level: (obj.level || "info").toLowerCase(),
      scope: obj.scope || null,
      message: Array.isArray(obj.message) ? obj.message.join(" ") : String(obj.message || ""),
      agent_object: agentObject,
      tag: obj.level === "error" ? "error" : "other",
    };
  } catch {
    return null;
  }
}

export function parseNdjsonFile(content, parseFn, agentObject) {
  const results = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseFn(trimmed, agentObject);
    if (parsed) results.push(parsed);
  }
  return results;
}
