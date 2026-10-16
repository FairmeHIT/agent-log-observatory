import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readSessionSnapshot } from '../lib/session-snapshot.mjs';
import { analyzeSession, prepareChartData, aggregateToolUsage } from '../lib/chart-data.mjs';
import { aggregateForCompare } from '../lib/compare-metrics.mjs';
import { computeCallRecordMetrics, computeCacheHitRate } from '../lib/metrics.mjs';
import { parseMobileworkCalls } from '../adapters/mobilework-adapter.mjs';
import { TeleAgentAdapter } from '../adapters/teleagent-adapter.mjs';

const detail=(id='s')=>({session:{session_id:id},metrics:[],usage:[],calls:{llm_calls:[],tool_calls:[]},failures:{source_available:true,diagnostics:[]}});
const input=(sessions,source_id='tester-1',time=1)=>({source_id,data:{export_metadata:{exported_at_epoch_ms:time},agents:{mobilework:{sessions}}}});

test('live snapshot supplies the same calls/usage to metric extraction and exposes read failures',async()=>{
  const calls={llm_calls:[{llm_call_id:'c',status:'running',input:'private'}],tool_calls:[]},usage=[{input:10}];
  const adapter={extractCalls:async()=>calls,extractUsage:async()=>usage,
    extractFailures:async()=>{throw new Error('private file path');},
    extractMetrics:async(s,opts)=>{assert.equal(opts.calls,calls);assert.equal(opts.usage,usage);return [];}};
  const snapshot=await readSessionSnapshot(adapter,'s');
  assert.equal(snapshot.capture.sections.failures,'read-error');assert.equal(snapshot.failures.source_available,false);
  assert.equal(snapshot.calls.llm_calls[0].input,undefined);
  assert.equal(snapshot.metrics.find(m=>m.metric==='llm_unresolved_record_count').value,1);
  assert.equal((await readSessionSnapshot({},'s')).metrics.find(m=>m.metric==='llm_record_count').value,null);
});

test('record terminals are scoped, deduplicated, conflict-aware and never turn unknown into success',()=>{
  const metrics=computeCallRecordMetrics({llm_calls:[],tool_calls:[
    {call_id:'same',agent_id:'a',status:'running'},{call_id:'same',agent_id:'a',status:'ok'},
    {call_id:'same',agent_id:'b',status:'error'},{call_id:'conflict',status:'ok'},{call_id:'conflict',status:'error'},
    {call_id:'cancelled',status:'cancelled'},
  ]},'s');
  const get=n=>metrics.find(m=>m.metric===n);
  assert.equal(get('tool_record_count').value,4);assert.equal(get('tool_unresolved_record_count').value,1);
  assert.equal(get('tool_observed_success_rate').value,0.5);assert.equal(get('tool_terminal_coverage').value,0.75);
  assert.equal(get('tool_observed_success_rate').state,'partial');
});

test('same message interleaved stream types close their own segments; retry is not a successful request',()=>{
  const event=(type,seq,extra={})=>({type:`session.next.${type}.1`,seq,data:JSON.stringify({timestamp:1000+seq,assistantMessageID:'msg',...extra})});
  const calls=parseMobileworkCalls([
    event('text.started',1),event('reasoning.started',2),event('reasoning.ended',3),event('text.ended',4),
    event('retried',5),event('tool.called',6,{callID:'tool',toolName:'powershell'}),event('tool.failed',7,{callID:'tool'}),
  ],'s');
  assert.equal(calls.llm_calls.length,2);assert.equal(calls.retry_event_count,1);
  assert.equal(calls.llm_calls[0].generation_ended_at,1004);assert.equal(calls.llm_calls[1].generation_ended_at,1003);
  assert.ok(calls.llm_calls.every(c=>c.status==='ok'&&c.first_output_at==null));
  assert.equal(calls.tool_calls[0].tool_name,'powershell');assert.equal(calls.tool_calls[0].status,'error');
});

test('TeleAgent native part SQL extracts real tool names/status/times and requires step-finish',async()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE part(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
  const insert=(id,data)=>db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(id,'s',100+Number(id),JSON.stringify(data));
  insert('1',{type:'step-start'});insert('2',{type:'reasoning',time:{end:120}});
  insert('3',{type:'tool',tool:'powershell',callID:'native',state:{status:'error',time:{start:110,end:115}}});
  insert('4',{type:'tool',tool:'read',callID:'pending',state:{status:'running'}});
  const adapter=new TeleAgentAdapter();adapter._dbQuery=async sql=>db.prepare(sql).all();
  try {
    let calls=await adapter.extractCalls('s');assert.equal(calls.llm_calls[0].status,'running');
    assert.equal(calls.tool_calls[0].tool_name,'powershell');assert.equal(calls.tool_calls[0].call_id,'native');
    assert.equal(calls.tool_calls[0].status,'error');assert.equal(calls.tool_calls[0].ended_at,115);
    assert.equal(calls.tool_calls[1].ended_at,null);assert.equal(calls.tool_calls[1].status,'unknown');
    insert('5',{type:'step-finish'});calls=await adapter.extractCalls('s');assert.equal(calls.llm_calls[0].status,'ok');
    assert.equal(calls.llm_calls[0].first_output_at,null);
  } finally {db.close();}
});

test('unknown cache semantics and absent usages remain null; session totals never add to attempts',()=>{
  const d=detail();d.usage=[{usage_record_id:'session',scope:'session',input:100,output:5,cache_read:80,input_includes_cache:true},
    {usage_record_id:'attempt',scope:'llm_attempt',input:100,output:5,cache_read:80,input_includes_cache:true}];
  let a=analyzeSession(d);assert.equal(a.tokens.total,105);assert.equal(a.tokens.uncached_input,20);
  d.usage[0].input_includes_cache='unknown';a=analyzeSession(d);assert.equal(a.tokens.total,null);
  assert.equal(computeCacheHitRate(d.usage).missing_reason,'semantic_unknown');
  assert.equal(analyzeSession(detail()).tokens.input,null);
  assert.equal(analyzeSession(detail()).task_success,null);assert.equal(analyzeSession(detail()).execution_completion,null);
});

test('aggregateToolUsage dedupes records, buckets unknown names and sorts by usage',()=>{
  const d=detail('s1');d.calls.tool_calls=[
    {call_id:'a',agent_id:'one',tool_name:'bash',status:'ok'},
    {call_id:'a',agent_id:'one',tool_name:'bash',status:'ok'},          // duplicate terminal → one record
    {call_id:'b',agent_id:'one',tool_name:'bash',status:'error'},
    {call_id:'x',agent_id:'one',tool_name:'edit',status:'ok'},
    {call_id:'x',agent_id:'one',tool_name:'edit',status:'error'},       // conflicting terminals → unknown, counted once
    {call_id:'p',agent_id:'one',tool_name:'read',status:'running'},     // unresolved → unknown bucket
    {call_id:'n',agent_id:'one'},                                        // missing name → explicit bucket
  ];
  const expected=aggregateToolUsage([{session_id:'s1',detail:d}]);
  assert.deepEqual(expected,[
    {tool_name:'bash',total:2,ok:1,error:1,cancelled:0,unknown:0},
    {tool_name:'edit',total:1,ok:0,error:0,cancelled:0,unknown:1},
    {tool_name:'read',total:1,ok:0,error:0,cancelled:0,unknown:1},
    {tool_name:'(unknown)',total:1,ok:0,error:0,cancelled:0,unknown:1},
  ]);
  assert.deepEqual(prepareChartData([input([d])]).chart5b_tool_ecosystem.mobilework,expected);
});

test('source namespaces prevent tester collisions; later repeated export replaces whole snapshot',()=>{
  const first=detail();first.calls.llm_calls=[{llm_call_id:'c',status:'running'}];
  const later=detail();later.calls.llm_calls=[{llm_call_id:'c',status:'ok'}];
  const result=prepareChartData([input([first]),input([later],'tester-1',2),input([first],'tester-2')]);
  assert.equal(result.statistics.unique_sessions,2);assert.equal(result.statistics.duplicate_snapshots,1);
  assert.equal(result.chart1_task_success.mobilework.task_success_rate.value,null);
  assert.equal(result.chart5a_calls_success.mobilework.observed_activity_proxy.n,2);
});

test('stability requires exactly k explicitly bound independent outcomes, excludes extra and duplicate trials',()=>{
  const rows=Array.from({length:5},(_,i)=>detail(`s${i+1}`));
  const bindings=rows.map((d,i)=>({source_id:'tester-1',agent:'mobilework',session_id:d.session.session_id,
    task_id:'task',batch_id:'batch',trial_id:`trial-${i+1}`,trial_index:i+1,
    outcome:{passed:i<4,verifier:'independent-file-state',evidence_ref:`receipt-${i}`}}));
  let r=prepareChartData([input(rows)],{bindings});let stability=r.chart4_stability_sr_pass.mobilework;
  assert.equal(stability.eligible_groups,1);assert.equal(stability.sr.mean,0.8);
  assert.equal(stability.pass_at_k.value,1);assert.equal(stability.pass_pow_k.value,0);
  assert.equal(r.chart3_tokens_success.mobilework.verified_success.n,4);
  bindings[4].trial_index=4;r=prepareChartData([input(rows)],{bindings});assert.equal(r.chart4_stability_sr_pass.mobilework.eligible_groups,0);
  assert.throws(()=>prepareChartData([input(rows)],{bindings:[{...bindings[0],outcome:{passed:true}}]}),/outcome requires/);
});

test('comparison retains partial coverage, rejects mixed units and pools known-outcome denominators',()=>{
  const session=(metrics)=>({metrics});
  const results=aggregateForCompare([
    session({credits:{value:1,state:'captured',unit:'credits'},success_rate:{value:1,state:'captured',numerator:1,denominator:1}}),
    session({credits:{value:2,state:'captured',unit:'USD'},success_rate:{value:0,state:'captured',numerator:0,denominator:9}}),
    session({success_rate:{value:0.5,state:'partial',numerator:1,denominator:2}}),
  ]);
  assert.equal(results.metrics.credits.sum,null);assert.equal(results.metrics.success_rate.avg,0.1);
  assert.equal(results.metrics.success_rate.sum,null);assert.equal(results.metrics.success_rate.partial,1);
});
