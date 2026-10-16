import test from 'node:test';
import assert from 'node:assert/strict';
import {computeTokenMetrics} from '../lib/token-metrics.mjs';
import {computeTTftMs,computeTurnE2eMs,computeSessionTurnE2eAvg} from '../lib/metrics.mjs';
import {makeMetricResult} from '../lib/evidence.mjs';
import {CodexAdapter,codexToolStatus} from '../adapters/codex-adapter.mjs';
import {openencodeStorageUsageRecord} from '../lib/opencode-storage-semantics.mjs';
import {normalizeUsageRecord} from '../lib/normalizer.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {WorkBuddyAdapter} from '../adapters/workbuddy-adapter.mjs';
const field=(rows,name)=>computeTokenMetrics(rows,'s').find(m=>m.metric===name);
const usage={usage_record_id:'one',scope:'session',scope_id:'s',input:100,output:20,cache_read:80,reasoning:5,input_includes_cache:true,output_includes_reasoning:true};

test('WorkBuddy verifies archived sessions from native transcript IDs after client cleanup; mismatched files cannot invent identity',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-native-identity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'projects','fixture'),{recursive:true});
 fs.writeFileSync(path.join(root,'projects/fixture/archived.jsonl'),JSON.stringify({type:'session-meta',sessionId:'archived',timestamp:1000})+'\n');
 fs.writeFileSync(path.join(root,'projects/fixture/foreign.jsonl'),JSON.stringify({type:'session-meta',sessionId:'other',timestamp:1000})+'\n');
 const adapter=new WorkBuddyAdapter();adapter._wbDataDir=()=>root;
 assert.equal((await adapter.extractSessions({session_id:'archived'})).items[0].session_id,'archived');
 assert.equal((await adapter.extractSessions({session_id:'foreign'})).items.length,0);
 assert.equal((await adapter.extractSessions({session_id:'missing'})).items.length,0);
 await assert.rejects(adapter.extractSessions({session_id:'../escape'}));
});

test('token totals preserve zero, reject unknown semantics, deduplicate and never mix summaries with attempts',()=>{
  assert.equal(field([usage],'token_total').value,120);
  assert.equal(field([{...usage,input_includes_cache:false}],'token_total').value,200);
  assert.equal(field([{...usage,output_includes_reasoning:false}],'token_total').value,125);
  assert.equal(field([{...usage,input_includes_cache:'unknown'}],'token_total').value,null);
  assert.equal(field([{...usage,input:0,output:0,reasoning:0,cache_read:0}],'token_total').value,0);
  assert.equal(field([],'token_input').value,null);
  assert.equal(field([usage,{...usage,scope:'llm_attempt',usage_record_id:'attempt'}],'token_total').value,120);
  assert.equal(field([usage,usage],'token_total').value,120);
  assert.equal(field([usage,{...usage,output:21}],'token_total').value,null);
  assert.equal(field([usage,{...usage,usage_record_id:'two',output:null}],'token_total').value,null);
  assert.equal(field([usage,{...usage,usage_record_id:'two',output:null}],'token_output').state,'partial');
  assert.equal(field([{...usage,scope_id:'foreign'}],'token_input').value,null);
});
test('opencode 存储口径（Mobilework 内嵌 opencode / 独立 opencode）归一出可证明的 token_total',()=>{
  const rec=openencodeStorageUsageRecord({session_id:'s',usage_record_id:'mw_session_1',scope:'session',scope_id:'s',
    input:1000,output:200,reasoning:50,cache_read:800,cache_write:20});
  assert.equal(rec.input_includes_cache,false);
  assert.equal(rec.output_includes_reasoning,false);
  assert.equal(rec.cache_write_accounting,'exclusive');
  // 证明后的口径不允许被调用方字段覆盖
  assert.equal(openencodeStorageUsageRecord({input_includes_cache:true}).input_includes_cache,false);
  // total = input + output + cache_read + cache_write + reasoning（= opencode totalTokens 语义）
  const total=field([rec],'token_total');
  assert.equal(total.state,'captured');
  assert.equal(total.value,2070);
  assert.equal(total.semantic_profile,'normalized_total_false_false_exclusive');
  assert.equal(field([rec],'token_input').semantic_profile,'source_input_false_false_exclusive');
  // cache_write=0 且 reasoning 缺失时不依赖对应标志也成立
  const noWrite=openencodeStorageUsageRecord({session_id:'s',usage_record_id:'mw_session_2',scope:'session',scope_id:'s',
    input:100,output:20,cache_read:5,cache_write:0,reasoning:null});
  assert.equal(field([noWrite],'token_total').value,125);
});
test('opencode 存储口径未接入（unknown 标志）时 token_total 保持 semantic_unknown 回归防护',()=>{
  const rec=normalizeUsageRecord({session_id:'s',usage_record_id:'legacy',scope:'session',scope_id:'s',
    input:1000,output:200,cache_read:800});
  const total=field([rec],'token_total');
  assert.equal(total.value,null);
  assert.equal(total.missing_reason,'semantic_unknown');
});
test('invalid clocks never emit negative/NaN durations; partial means retain coverage',()=>{
  assert.equal(computeTTftMs({requested_at:0,first_output_at:100}).value,100);
  assert.equal(computeTTftMs({requested_at:100,first_output_at:90}).value,null);
  assert.equal(computeTurnE2eMs({submitted_at:100,execution_ended_at:90}).value,null);
  const mean=computeSessionTurnE2eAvg([{submitted_at:100,execution_ended_at:200},{submitted_at:100,execution_ended_at:'bad'}]);
  assert.equal(mean.value,100);assert.equal(mean.state,'partial');assert.equal(mean.coverage.eligible,2);
  for(const n of [-1,NaN,Infinity,'20'])assert.equal(makeMetricResult('token_total',n).value,null);
});
test('call usage keeps its own call ID and explicit owning Session; foreign ownership is rejected',()=>{
  const call={...usage,scope:'llm_call',scope_id:'message-one',session_id:'s'};
  assert.equal(field([call],'token_input').value,100);
  assert.equal(field([call],'token_total').value,120);
  assert.equal(field([{...call,session_id:'foreign'}],'token_total').value,null);
  assert.equal(field([{...usage,session_id:'s',scope_id:'foreign'}],'token_total').value,null);
});
test('Codex tool/turn lifecycle preserves unknown and cancelled; outcome metrics have distinct identities',async()=>{
  assert.equal(codexToolStatus(null),'unknown');assert.equal(codexToolStatus({status:'inProgress'}),'running');
  assert.equal(codexToolStatus({status:'completed',exitCode:2}),'error');assert.equal(codexToolStatus({status:'completed',exitCode:0}),'ok');
  const adapter=new CodexAdapter();adapter._readRolloutUsage=async()=>null;adapter._readConfig=async()=>({});
  adapter._query=async(file,sql)=>sql.includes('FROM thread_turns')?[{turn_id:'t',status:'interrupted',started_at:1}]:sql.includes('FROM threads')?[{created_at_ms:1000,updated_at_ms:2000,tokens_used:100}]:sql.includes('COUNT')?[{cnt:0}]:[];
  const calls=await adapter.extractCalls('s');assert.equal(calls.llm_calls[0].status,'cancelled');
  const metrics=await adapter.extractMetrics('s',{calls,usage:[{...usage,reported_total:120}],failures:{source_available:false}});
  assert.equal(new Set(metrics.map(m=>m.metric)).size,metrics.length);
  assert.equal(metrics.find(m=>m.metric==='max_context').value,null);
  assert.equal(metrics.find(m=>m.metric==='token_total').value,120);
});
