import { percentile } from "./metrics.mjs";

export function aggregateSessions(sessions) {
  return sessions.map((s) => ({
    agent_object: s.agent_object,
    session_id: s.session_id,
    title: s.title,
    started_at: s.started_at,
    ended_at: s.ended_at,
    duration_ms: s.duration_ms,
    status: s.source_status,
    llm_call_count: s.llm_call_count,
    tool_call_count: s.tool_call_count,
    step_count: s.step_count,
    tokens: s.tokens,
    data_completeness: s.data_completeness,
  }));
}

export function compareMetricAcrossAgents(agentResults, metricName) {
  const entries = [];
  for (const [agent, results] of Object.entries(agentResults)) {
    const values = results
      .filter((r) => r.metric === metricName && r.value != null && r.state === "captured")
      .map((r) => r.value);
    const p50 = percentile(values, 50);
    const p95 = percentile(values, 95);
    entries.push({
      agent_object: agent,
      sample_count: values.length,
      p50: p50.value,
      p95: p95.value,
      comparable: p50.comparable,
      not_captured: results.filter((r) => r.metric === metricName && r.state === "not-captured").length,
    });
  }
  return entries;
}

export function summarizeFailures(sessions) {
  const summary = { gateway: 0, tool: 0, model: 0, dependency: 0, agent: 0 };
  for (const s of sessions) {
    if (!s.failure_attribution) continue;
    for (const key of Object.keys(summary)) {
      summary[key] += s.failure_attribution[key] || 0;
    }
  }
  return summary;
}
