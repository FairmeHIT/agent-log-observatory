export function deduplicateEvents(events) {
  const seen = new Map();
  const result = [];
  for (const ev of events) {
    const key = ev.event_id || `${ev.session_id}|${ev.occurred_at}|${ev.event_type_raw}|${ev.source_seq ?? ""}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    result.push(ev);
  }
  return result;
}

export function deduplicateUsageRecords(records) {
  const seen = new Set();
  const result = [];
  for (const r of records) {
    if (!r.usage_record_id) {
      result.push(r);
      continue;
    }
    if (seen.has(r.usage_record_id)) continue;
    seen.add(r.usage_record_id);
    result.push(r);
  }
  return result;
}

export function buildSessionTree(sessions) {
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const children = new Map();
  for (const s of sessions) {
    if (s.parent_session_id && byId.has(s.parent_session_id)) {
      const arr = children.get(s.parent_session_id) || [];
      arr.push(s.session_id);
      children.set(s.parent_session_id, arr);
    }
  }
  return { byId, children };
}

export function rootTreeSessionIds(sessions) {
  return sessions
    .filter((s) => !s.parent_session_id || !sessions.some((p) => p.session_id === s.parent_session_id))
    .map((s) => s.session_id);
}

export function collectTreeSessionIds(rootId, children) {
  const result = [rootId];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    const kids = children.get(id) || [];
    for (const k of kids) {
      if (!result.includes(k)) {
        result.push(k);
        stack.push(k);
      }
    }
  }
  return result;
}
