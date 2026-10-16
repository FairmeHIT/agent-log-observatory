import { computeCallRecordMetrics, uniqueCallRecords, percentile } from './metrics.mjs';
import {usageTotal} from './token-metrics.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v) && v>=0;
const valueOf = (metrics, name) => metrics.find(m=>m.metric===name)?.value ?? null;
const ratio = (numerator,denominator,reason='zero_denominator') => ({
  value:denominator?numerator/denominator:null, numerator, denominator,
  missing_reason:denominator?null:reason,
});
const distribution = values => {
  const known = values.filter(finite);
  return {n:known.length,missing:values.length-known.length,
    p50:percentile(known,50).value,p95:percentile(known,95).value,
    mean:known.length?known.reduce((a,b)=>a+b,0)/known.length:null};
};

function tokenFacts(detail) {
  // Session totals and attempt usage are alternative scopes, never additive.
  const rows = detail.usage || [];
  const sessionRows = rows.filter(r=>r.scope==='session');
  const candidates = sessionRows.length ? sessionRows : rows;
  const unique = new Map();
  for (const [i,r] of candidates.entries()) unique.set(r.usage_record_id ?? `row-${i}`,r);
  const usage = [...unique.values()];
  const sum = field => usage.length && usage.every(r=>finite(r[field]))
    ? usage.reduce((a,r)=>a+r[field],0) : null;
  const input=sum('input'),output=sum('output'),cache=sum('cache_read');
  const semantics = new Set(usage.map(r=>r.input_includes_cache));
  const includesCache = semantics.size===1 && typeof [...semantics][0]==='boolean' ? [...semantics][0] : 'unknown';
  const reported=sum('reported_total');
  // Total only when inclusion semantics are known; do not add reasoning twice.
  const totals=usage.map(usageTotal);
  const total=totals.length&&totals.every(finite)?totals.reduce((a,b)=>a+b,0):null;
  return {input,output,cache_read:cache,reasoning:sum('reasoning'),total,
    uncached_input:finite(input)&&finite(cache)&&includesCache===true&&input>=cache?input-cache:includesCache===false?input:null,
    input_includes_cache:includesCache,reported_total:reported,
    total_missing_reason:total==null?(usage.length?'semantic_unknown':'not_instrumented'):null,
    usage_count:usage.length};
}

export function analyzeSession(detail) {
  const metrics=detail.metrics || [];
  const recordMetrics=computeCallRecordMetrics(detail.calls,detail.session?.session_id);
  const count=name=>valueOf(recordMetrics,name);
  const llm=count('llm_record_count'),tools=count('tool_record_count');
  const tokens=tokenFacts(detail);
  const diagnostics=(detail.failures?.diagnostics || []).filter(d=>!d.scope || d.scope==='session');
  const counts = {
    model_retry:diagnostics.filter(d=>/retried|retry/i.test(d.event_type || d.rule || '')).length,
    step_error:diagnostics.filter(d=>/step.failed/.test(d.event_type || '')).length,
    tool_diagnostic_error:diagnostics.filter(d=>d.category==='tool').length,
    tool_error:count('tool_observed_error_count'),llm_error:count('llm_observed_error_count'),
    llm_unresolved:count('llm_unresolved_record_count'),tool_unresolved:count('tool_unresolved_record_count'),
  };
  const signals = [llm,tools,tokens.input,tokens.output,tokens.cache_read,valueOf(metrics,'assistant_message_count')];
  const active=signals.some(v=>finite(v)&&v>0);
  const activity=active?'observed':'not-observed'; // Empty capture is not proven execution failure.
  const issues=[];
  for (const [name,records] of [['llm_call_count',llm],['tool_call_count',tools]]) {
    const metric=metrics.find(m=>m.metric===name);
    if(finite(metric?.value)&&finite(records)&&metric.value!==records) issues.push({code:'metric_record_disagreement',metric:name,metric_value:metric.value,record_value:records});
  }
  if ((detail.calls?.llm_calls || []).some(c=>c.requested_at!=null&&c.requested_at===c.first_output_at)) issues.push({code:'first_output_equals_request',missing_reason:'timestamp_collision'});
  const errorsKnown=finite(counts.tool_error)&&finite(counts.llm_error)&&detail.failures?.source_available!==false;
  return {activity,execution_completion:null,task_success:null,
    completion_missing_reason:'requires_explicit_terminal_evidence',
    task_success_missing_reason:'requires_independent_outcome',
    clean_observation:active&&errorsKnown&&counts.model_retry===0&&counts.step_error===0&&counts.tool_error===0&&counts.llm_error===0&&counts.llm_unresolved===0&&counts.tool_unresolved===0,
    record_metrics:recordMetrics,tokens,counts,issues};
}

// Per-tool usage stats over unique adapter tool records (chart5b semantics).
// Deduplication and conflict handling come from uniqueCallRecords; unknown
// tool names get an explicit '(unknown)' bucket instead of being dropped.
export function aggregateToolUsage(rows) {
  const tools=new Map();
  for(const row of rows){
    for(const c of uniqueCallRecords(row.detail.calls?.tool_calls,'call_id',row.session_id)) {
      const name=c.tool_name || '(unknown)';
      const stat=tools.get(name)||{tool_name:name,total:0,ok:0,error:0,cancelled:0,unknown:0};
      stat.total++;stat[['ok','error','cancelled'].includes(c.status)?c.status:'unknown']++;tools.set(name,stat);
    }
  }
  return [...tools.values()].sort((a,b)=>b.total-a.total);
}

// Exports from two testers must keep separate namespaces even if native IDs collide.
// Same-source repeated exports choose one whole snapshot (latest export), not
// sums/maxima of arrays that may have different scopes or adapter versions.
export function prepareChartData(inputs, {bindings=[],k=5}={}) {
  if(!Number.isInteger(k)||k<1)throw new Error('k must be a positive integer');
  if(!Array.isArray(bindings))throw new Error('bindings must be an array');
  const snapshots=new Map();let raw=0,duplicates=0;
  for(const input of inputs) {
    if(!input.source_id)throw new Error('source_id is required');
    for(const [agent,block] of Object.entries(input.data.agents || {})) {
      for(const detail of block.sessions || []) {
        raw++;
        const sid=detail.session?.session_id;if(!sid)throw new Error('session_id is required');
        const installation=detail.session.installation_id ?? 'default';
        const key=JSON.stringify([input.source_id,agent,installation,sid]);
        const row={key,source_id:input.source_id,agent,installation_id:installation,session_id:sid,
          export_at:input.data.export_metadata?.exported_at_epoch_ms ?? 0,detail};
        const prior=snapshots.get(key);
        if(prior){duplicates++;if(prior.export_at>row.export_at)continue;}
        snapshots.set(key,row);
      }
    }
  }
  const bindingMap=new Map();
  for(const b of bindings){
    const fields=['source_id','agent','installation_id','session_id','include','task_id','batch_id','trial_id','trial_index','outcome'];
    if(!b||typeof b!=='object'||Object.keys(b).some(key=>!fields.includes(key)))throw new Error('invalid binding fields');
    for(const field of ['source_id','agent','session_id'])if(typeof b[field]!=='string'||!b[field].length)throw new Error('binding identity is required');
    for(const field of ['installation_id','task_id','batch_id','trial_id'])if(b[field]!=null&&(typeof b[field]!=='string'||!b[field].length))throw new Error('binding IDs must be nonempty strings');
    if(b.include!=null&&typeof b.include!=='boolean')throw new Error('include must be boolean');
    if(b.trial_index!=null&&(!Number.isInteger(b.trial_index)||b.trial_index<1))throw new Error('trial_index must be a positive integer');
    const key=JSON.stringify([b.source_id,b.agent,b.installation_id ?? 'default',b.session_id]);
    if(bindingMap.has(key))throw new Error('duplicate session binding');
    if(!snapshots.has(key))throw new Error('binding does not match an input session');
    if(b.outcome && (typeof b.outcome.passed!=='boolean'||!b.outcome.verifier||!b.outcome.evidence_ref))throw new Error('outcome requires passed, verifier and evidence_ref');
    if(b.outcome && (typeof b.outcome.verifier!=='string'||typeof b.outcome.evidence_ref!=='string'||Object.keys(b.outcome).some(key=>!['passed','verifier','evidence_ref'].includes(key))))throw new Error('invalid outcome fields');
    bindingMap.set(key,b);
  }
  const sessions=[...snapshots.values()].map(row=>{
    const binding=bindingMap.get(row.key);
    const analysis=analyzeSession(row.detail);
    if(binding?.outcome){analysis.task_success=binding.outcome.passed;analysis.task_success_missing_reason=null;}
    return {...row,analysis,binding};
  });
  const selected=sessions.filter(r=>r.binding?.include!==false);
  const output={schema_version:'observatory-chart-data-1.0',k,
    semantics:{activity:'observed activity only; not execution completion or business success',
      calls:'unique adapter records; stream segments / assistant rows / steps are not uniform LLM attempts',
      rates:'known ok/error terminals; unresolved and cancelled reported separately',
      stability:'explicit task/batch/trial bindings, exactly k distinct indices and independent outcomes',
      errors:'observed diagnostic categories; not proven root causes; overlapping incidences are not a partition'},
    statistics:{raw_sessions:raw,unique_sessions:sessions.length,duplicate_snapshots:duplicates,selected_sessions:selected.length},
    chart1_task_success:{},chart2_error_attribution:{},chart3_tokens_success:{},
    chart4_stability_sr_pass:{},chart5a_calls_success:{},chart5b_tool_ecosystem:{},
    session_evidence:[]};
  for(const agent of new Set(selected.map(r=>r.agent))) {
    const rows=selected.filter(r=>r.agent===agent);
    const outcomes=rows.filter(r=>r.binding?.outcome);
    const success=outcomes.filter(r=>r.binding.outcome.passed);
    const active=rows.filter(r=>r.analysis.activity==='observed');
    output.chart1_task_success[agent]={n:rows.length,verified:outcomes.length,unknown:rows.length-outcomes.length,
      task_success_rate:ratio(success.length,outcomes.length,'requires_independent_outcome'),
      observed_activity_rate:ratio(active.length,rows.length),activity_not_observed:rows.length-active.length};
    output.chart2_error_attribution[agent]={n:rows.length,categories:{}};
    for(const cat of ['model_retry','step_error','tool_diagnostic_error','tool_error','llm_error','llm_unresolved','tool_unresolved']) {
      const eligible=rows.filter(r=>finite(r.analysis.counts[cat]) && (!['model_retry','step_error','tool_diagnostic_error'].includes(cat)||r.detail.failures?.source_available!==false));
      const affected=eligible.filter(r=>r.analysis.counts[cat]>0).length;
      output.chart2_error_attribution[agent].categories[cat]={events:eligible.reduce((a,r)=>a+r.analysis.counts[cat],0),
        affected_sessions:affected,unknown_sessions:rows.length-eligible.length,
        incidence:ratio(affected,eligible.length)};
    }
    function tokenSummary(cohort) {
      const summary={n:cohort.length,metrics:{},semantic_profiles:{}};
      for(const field of ['input','output','cache_read','reasoning','total','uncached_input']) summary.metrics[field]=distribution(cohort.map(r=>r.analysis.tokens[field]));
      for(const row of cohort){const profile=String(row.analysis.tokens.input_includes_cache);summary.semantic_profiles[profile]=(summary.semantic_profiles[profile]||0)+1;}
      return summary;
    }
    function callSummary(cohort) {
      const summary={n:cohort.length,metrics:{},rates:{},retry_rate:{value:null,missing_reason:'requires_attempt_identity'}};
      for(const kind of ['llm','tool']) {
        const metric=name=>cohort.map(r=>valueOf(r.analysis.record_metrics,name));
        summary.metrics[`${kind}_record_count`]=distribution(metric(`${kind}_record_count`));
        const count=name=>{const v=metric(name).filter(finite);return v.length?v.reduce((a,b)=>a+b,0):null;};
        const ok=count(`${kind}_observed_ok_count`),err=count(`${kind}_observed_error_count`),cancel=count(`${kind}_observed_cancelled_count`),total=count(`${kind}_record_count`);
        summary.rates[kind]={known_outcome_rate:ratio(ok,ok==null||err==null?0:ok+err),
          error_rate:ratio(err,ok==null||err==null?0:ok+err),
          terminal_coverage:ratio(ok==null?null:ok+err+cancel,total),
          unresolved:count(`${kind}_unresolved_record_count`),cancelled:cancel,
          observed_sessions:metric(`${kind}_record_count`).filter(finite).length,eligible_sessions:cohort.length};
      }
      return summary;
    }
    output.chart3_tokens_success[agent]={verified_success:tokenSummary(success),observed_activity_proxy:tokenSummary(active)};
    output.chart5a_calls_success[agent]={verified_success:callSummary(success),observed_activity_proxy:callSummary(active)};
    output.chart5b_tool_ecosystem[agent]=aggregateToolUsage(rows);
    const groups=new Map();let unbound=0;
    for(const row of rows){
      const b=row.binding;
      if(!b?.task_id||!b?.batch_id||!b?.trial_id||!Number.isInteger(b.trial_index)){unbound++;continue;}
      const key=JSON.stringify([row.source_id,row.installation_id,b.batch_id,b.task_id]);
      const group=groups.get(key)||[];group.push(row);groups.set(key,group);
    }
    const perTask=[];
    for(const [key,group] of groups) {
      const indices=new Set(group.map(r=>r.binding.trial_index));
      const trialIds=new Set(group.map(r=>r.binding.trial_id));
      const complete=group.length===k&&indices.size===k&&trialIds.size===k&&[...indices].every(i=>i>=1&&i<=k)&&group.every(r=>r.binding.outcome);
      const passed=group.filter(r=>r.binding.outcome?.passed).length;
      perTask.push({identity:JSON.parse(key),n:group.length,eligible:complete,
        missing_reason:complete?null:'requires_exact_k_distinct_bound_verified_trials',
        sr:complete?passed/k:null,pass_at_k:complete?Number(passed>0):null,pass_pow_k:complete?Number(passed===k):null});
    }
    const eligible=perTask.filter(g=>g.eligible);
    output.chart4_stability_sr_pass[agent]={unbound_sessions:unbound,eligible_groups:eligible.length,excluded_groups:perTask.length-eligible.length,per_task:perTask,
      sr:distribution(eligible.map(g=>g.sr)),pass_at_k:ratio(eligible.filter(g=>g.pass_at_k).length,eligible.length,'requires_bound_verified_trials'),
      pass_pow_k:ratio(eligible.filter(g=>g.pass_pow_k).length,eligible.length,'requires_bound_verified_trials')};
  }
  output.session_evidence=sessions.map(r=>({source_id:r.source_id,agent:r.agent,installation_id:r.installation_id,session_id:r.session_id,
    included:r.binding?.include!==false,...r.analysis}));
  return output;
}
