import { computeCallRecordMetrics } from './metrics.mjs';
import { whitelistFilter } from './redactor.mjs';

const CALL_FIELDS = new Set(['llm_call_id','call_id','session_id','agent_object','agent_id',
  'message_id','attempt_id','step_id','requested_model','routed_model','provider',
  'requested_at','first_output_at','first_output_source','generation_ended_at',
  'started_at','ended_at','status','tool_name','exit_code','usage_record_ids',
  'result_count','native_call_id','record_grain','stream_kind']);
function publicCalls(calls) {
  if(calls==null)return null;
  const project=row=>Object.fromEntries(Object.entries(row).filter(([key])=>CALL_FIELDS.has(key)));
  return {
    llm_calls:Array.isArray(calls.llm_calls)?calls.llm_calls.map(project):null,
    tool_calls:Array.isArray(calls.tool_calls)?calls.tool_calls.map(project):null,
    trace_duration_ms:calls.trace_duration_ms ?? null,
    retry_event_count:calls.retry_event_count ?? null,
  };
}

// Read each section live; do not splice cached metrics into newer call records.
// This is a bounded read window, not an atomic transaction on external sources.
export async function readSessionSnapshot(adapter, sessionId) {
  const started = Date.now();
  const sectionStates = {};
  async function read(section, method, fallback, options = {}) {
    if (typeof adapter[method] !== 'function') {
      sectionStates[section] = 'not-supported';
      return fallback;
    }
    try {
      const value = await adapter[method](sessionId, options);
      sectionStates[section] = 'read';
      return value ?? fallback;
    } catch {
      sectionStates[section] = 'read-error';
      return fallback;
    }
  }
  const [calls, usage, events, failures, timeline] = await Promise.all([
    read('calls', 'extractCalls', null), read('usage', 'extractUsage', []),
    read('events', 'extractEvents', []),
    read('failures', 'extractFailures', {source_available:false, diagnostics:[], summary:{}}),
    read('timeline', 'extractTimeline', []),
  ]);
  const metrics = await read('metrics', 'extractMetrics', [], {calls, usage, failures});
  const recordMetrics = computeCallRecordMetrics(calls, sessionId);
  const names = new Set(recordMetrics.map(m => m.metric));
  return {
    session: null,
    metrics: [...metrics.filter(m => !names.has(m.metric)), ...recordMetrics],
    events: whitelistFilter(events), usage: whitelistFilter(usage),
    calls: publicCalls(calls),
    failures: whitelistFilter(failures), timeline,
    capture: {source:'live', consistency:'bounded-read-window',
      started_at_epoch_ms:started, ended_at_epoch_ms:Date.now(), sections:sectionStates},
    observation_completeness:{
      captured_metrics:metrics.filter(m=>m.state==='captured'&&m.value!=null).length,
      partial_metrics:metrics.filter(m=>m.state==='partial').length,
      missing_metrics:metrics.filter(m=>m.value==null).map(m=>({metric:m.metric,missing_reason:m.missing_reason})),
    },
  };
}
