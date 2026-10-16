import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DoubaoAdapter } from "../adapters/doubao-adapter.mjs";
import { SseParser, CaptureTracker, parseWsNotification, EVENT_SCHEMA } from "../collectors/doubao-cdp-collector/capture.mjs";
import { computeObservationMetrics } from "../lib/metrics.mjs";
import { readTrajectory, bindCollectorRecords, validateBindings, mergeCollectorTools, collectorEvents } from "../adapters/doubao-sources.mjs";
import { whitelistFilter, redact } from "../lib/redactor.mjs";

const fixture=path.join(import.meta.dirname,"fixtures/doubao-sample/sessions");
const sandbox=path.join(import.meta.dirname,"../runtime/tests/doubao",randomUUID());
await fs.mkdir(sandbox,{recursive:true});
const cfg={sessionsRoot:fixture,rpaDevDir:path.join(sandbox,"rpa"),collectorDirectory:path.join(sandbox,"collector"),conversationBindings:{}};
const map=ms=>Object.fromEntries(ms.map(m=>[m.metric,m]));
const eventSchema=JSON.parse(await fs.readFile(new URL('../schemas/doubao-collector-event.schema.json',import.meta.url)));
const metricSchema=JSON.parse(await fs.readFile(new URL('../schemas/metric-result.schema.json',import.meta.url)));
// These schemas use only the checked keywords below. This keeps validation
// offline without adding a production/test dependency for the fixture contract.
function assertSchema(value,schema,label='record') {
  for(const key of schema.required??[])assert.ok(Object.hasOwn(value,key),`${label}.${key} required`);
  for(const [key,item]of Object.entries(value)){
    const field=schema.properties?.[key];
    if(!field){assert.notEqual(schema.additionalProperties,false,`${label}.${key} disallowed`);continue;}
    if(field.const!==undefined)assert.equal(item,field.const,`${label}.${key}`);
    if(field.enum)assert.ok(field.enum.includes(item),`${label}.${key} enum`);
    if(field.type){const types=[field.type].flat();assert.ok(types.some(t=>t==='null'?item===null:t==='array'?Array.isArray(item):t==='integer'?Number.isInteger(item):t==='object'?item!==null&&typeof item==='object'&&!Array.isArray(item):typeof item===t),`${label}.${key} type`);}
    if(field.minimum!==undefined)assert.ok(item>=field.minimum,`${label}.${key} minimum`);
    if(field.properties&&item!==null)assertSchema(item,field,`${label}.${key}`);
  }
}

test("multi-tool messages retain all events; identities distinguish agents and calls/results",async()=>{
  const adapter=new DoubaoAdapter(cfg),events=await adapter.extractEvents("session-alpha");
  assert.equal(events.filter(e=>e.event_category==="llm.response").length,3);
  assert.equal(events.filter(e=>e.event_category==="tool.call").length,3);
  assert.equal(new Set(events.map(e=>e.event_id)).size,events.length);
  const calls=await adapter.extractCalls("session-alpha");assert.equal(calls.tool_calls.length,3);
  assert.equal(new Set(calls.tool_calls.map(c=>c.call_id)).size,3);
  const metrics=map(await adapter.extractMetrics("session-alpha"));
  assert.equal(metrics.assistant_message_count.value,3);assert.equal(metrics.tool_call_count.value,3);
  assert.equal(metrics.tool_result_count.value,3);assert.equal(metrics.tool_unresolved_count.value,1);
  assert.equal(metrics.tool_orphan_result_count.value,1);assert.equal(metrics.tool_duplicate_call_count.value,1);
  assert.equal(metrics.tool_duplicate_result_count.value,1);assert.equal(metrics.tool_success_rate.value,0.5);
  assert.equal(metrics.tool_success_rate.state,"partial");assert.equal(metrics.tool_terminal_coverage.value,2/3);
  for(const name of ["llm_call_count","success_rate","human_confirm_count","step_count","turn_e2e_ms","session_lifespan_ms","token_total","context_window","max_context","llm_retry_count","llm_attempt_ttft_ms"])assert.equal(metrics[name].value,null,name);
  assert.equal((await adapter.extractSessions()).items[0].started_at,null);
  const serialized=JSON.stringify(redact(whitelistFilter({items:events,calls,metrics:await adapter.extractMetrics("session-alpha")})));
  assert.ok(!serialized.includes("SYNTHETIC_PRIVATE_ARGUMENT"));assert.ok(!serialized.includes("Synthetic fixture prompt"));
  assert.equal((await adapter.extractExcerpt("session-alpha")).first_user_message,null);
  for(const metric of await adapter.extractMetrics("session-alpha"))assertSchema(metric,metricSchema);
  assert.equal(redact(whitelistFilter(calls)).tool_calls.length,3);
});

test("overlapping sessions cannot borrow CDP records or legacy response-header TTFT",()=>{
  const records=[{event_id:"1",conversation_id:"conv-alpha"},{event_id:"2",conversation_id:"conv-beta"},{event_id:"3",trajectory_session_id:"session-beta"}];
  assert.deepEqual(bindCollectorRecords(records,"session-alpha",{}),[]);
  assert.deepEqual(bindCollectorRecords(records,"session-alpha",{ "session-alpha":"conv-alpha" }),[records[0]]);
  assert.deepEqual(bindCollectorRecords(records,"session-alpha",{"session-alpha":"conv-alpha","session-beta":"conv-alpha"}),[]);
  assert.deepEqual(bindCollectorRecords(records,"session-beta",{}),[records[2]]);
  assert.throws(()=>validateBindings({"../outside":"conv-alpha"}),/Invalid/);
  assert.throws(()=>validateBindings({"..":"conv-alpha"}),/Invalid/);
});

test("bad records and partial tail retain valid observations with partial coverage",async()=>{
  const sessionsRoot=path.join(sandbox,"broken");const dir=path.join(sessionsRoot,"s/agents/a/system");await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,"trajectory.jsonl"),'not-json\n{"role":"assistant"}\n{"role":');
  const adapter=new DoubaoAdapter({...cfg,sessionsRoot});const m=map(await adapter.extractMetrics("s"));
  assert.equal(m.assistant_message_count.value,1);assert.equal(m.assistant_message_count.state,"partial");
  assert.equal(m.source_parse_error_count.value,1);assert.equal(m.source_partial_line_count.value,1);
  assert.equal((await adapter.extractSessions()).items[0].source_status,"partial");
});

test("SSE survives UTF-8, CRLF, multiline data and ignores ACK/heartbeat/user echo",()=>{
  const events=[];const parser=new SseParser(e=>events.push(e));
  const bytes=Buffer.from('event: SSE_HEARTBEAT\r\ndata: {}\r\n\r\nevent: FULL_MSG_NOTIFY\ndata: {"text":"PRIVATE_ECHO"}\n\nevent: CHUNK_DELTA\r\ndata: {\r\ndata: "text":"你好"}\r\n\r\n');
  for(let i=0;i<bytes.length;i++)parser.push(bytes.subarray(i,i+1),1000+i);
  assert.equal(events.length,1);assert.equal(events[0].event_type,"stream.text");assert.equal(events[0].text_chars,2);
  assert.ok(!JSON.stringify(events).includes("你好"));assert.equal(parser.errors,0);
  parser.push('event: SSE_REPLY_END\ndata: {"end_type":3}\n\n',2000);assert.equal(events.at(-1).event_type,"reply.end");
  parser.finish(2100);assert.equal(parser.errors,0);
});

test("SSE snapshots and repeated event IDs do not inflate text output; EOF is not a semantic end",()=>{
  const events=[],parser=new SseParser(e=>events.push(e));
  parser.push('event: STREAM_MSG_NOTIFY\ndata: {"content":{"content_block":[{"content":{"text_block":{"text":"你"}}}]}}\n\n',100);
  const delta='id: d1\nevent: CHUNK_DELTA\ndata: {"text":"好"}\n\n';parser.push(delta,200);parser.push(delta,300);
  parser.push('event: STREAM_CHUNK\ndata: {"patch_op":[{"patch_object":1,"patch_value":{"content_block":[{"content":{"text_block":{"text":"你好"}}}]}}]}\n\n',400);
  assert.deepEqual(events.map(e=>e.text_chars),[1,2]);
  parser.push('event: CHUNK_DELTA\ndata: {"text":"partial',500);parser.finish(600);
  assert.equal(parser.errors,1);assert.ok(events.every(e=>e.event_type!=="reply.end"));
});

test("buffered SSE has no fabricated first-text time; live updates and WS survive HTTP end",async()=>{
  const emitted=[];const tracker=new CaptureTracker({emit:r=>emitted.push(r),epoch:"fixture",targetId:"page",now:()=>1300,send:async()=>({bufferedData:Buffer.from('event: CHUNK_DELTA\ndata: {"text":"PRIVATE_BUFFER"}\n\n').toString('base64')})});
  await tracker.handle("Network.requestWillBeSent",{requestId:"req",wallTime:1,timestamp:10,request:{url:"https://www.doubao.com/chat/completion",postData:JSON.stringify({conversation_id:"conv-alpha",prompt:"DO_NOT_PERSIST",authorization:"SYNTHETIC_SECRET"})}});
  await tracker.handle("Network.responseReceived",{requestId:"req",timestamp:10.1,response:{status:200,mimeType:"text/event-stream"}});
  await tracker.handle("Network.dataReceived",{requestId:"req",timestamp:10.2,data:Buffer.from('event: CHUNK_DELTA\ndata: {"text":"PRIVATE_LIVE"}\n\n').toString('base64')});
  await tracker.handle("Network.loadingFinished",{requestId:"req",timestamp:10.3});
  const ws={cmd:{cmd_type:10028,ext:{conversation_id:"conv-alpha",agent_id:"a",tool_call_id:"late-tool",tool_name:"PowerShell"}}};
  await tracker.handle("Network.webSocketFrameReceived",{timestamp:10.4,response:{payloadData:Buffer.from(JSON.stringify(ws)).toString('base64')}});
  await tracker.handle("Network.webSocketFrameReceived",{timestamp:10.5,response:{payloadData:Buffer.from(JSON.stringify(ws)).toString('base64')}});
  assert.equal(emitted.filter(e=>e.event_type==="tool.call").length,1);
  assert.equal(emitted.find(e=>e.event_type==="stream.text").occurred_at,null);
  assert.ok(!JSON.stringify(emitted).includes("PRIVATE_"));assert.ok(!JSON.stringify(emitted).includes("DO_NOT_PERSIST"));assert.ok(!JSON.stringify(emitted).includes("SYNTHETIC_SECRET"));
  const trajectory=await readTrajectory(cfg,"session-alpha");const m=map(computeObservationMetrics({sessionId:"s",trajectory,tools:trajectory.tool_calls,records:emitted}));
  assert.equal(m.client_headers_ms.value,100);assert.equal(m.client_first_text_ms.value,null);assert.equal(m.client_stream_ms.value,300);
  assert.equal(m.llm_attempt_ttft_ms.value,null);assert.equal(m.llm_retry_count.value,null);
  assert.ok(emitted.every(e=>e.schema_version===EVENT_SCHEMA));
  for(const record of emitted)assertSchema(record,eventSchema);
});

test("early live chunks wait for buffered prefix; unsupported streaming and disconnect become gaps",async()=>{
  const emitted=[];let resolve;const ack=new Promise(r=>resolve=r);
  const tracker=new CaptureTracker({emit:r=>emitted.push(r),epoch:"race",send:()=>ack,now:()=>1100});
  await tracker.handle("Network.requestWillBeSent",{requestId:"r",timestamp:1,wallTime:1,request:{url:"https://www.doubao.com/chat/completion"}});
  const headers=tracker.handle("Network.responseReceived",{requestId:"r",timestamp:1.1,response:{status:200,mimeType:"text/event-stream"}});
  await tracker.handle("Network.dataReceived",{requestId:"r",timestamp:1.2,data:Buffer.from('event: CHUNK_DELTA\ndata: {"text":"B"}\n\n').toString('base64')});
  resolve({bufferedData:Buffer.from('event: CHUNK_DELTA\ndata: {"text":"A"}\n\n').toString('base64')});await headers;
  assert.deepEqual(emitted.filter(e=>e.event_type==="stream.text").map(e=>e.text_chars),[1,2]);
  tracker.close();assert.equal(emitted.at(-1).reason,"disconnected");
  const unsupported=new CaptureTracker({emit:r=>emitted.push(r),send:async()=>{throw Error("unsupported");}});
  await unsupported.handle("Network.requestWillBeSent",{requestId:"r",timestamp:1,wallTime:1,request:{url:"https://www.doubao.com/chat/completion"}});
  await unsupported.handle("Network.responseReceived",{requestId:"r",timestamp:1.1,response:{status:200,mimeType:"text/event-stream"}});
  assert.equal(emitted.at(-1).reason,"streaming_unsupported");
});

test("explicit human request/decision pairs produce wait timing; arbitrary messages do not",async()=>{
  const records=[{event_type:"human.request",approval_id:"p",conversation_id:"conv",agent_id:"a",occurred_at:1000},{event_type:"human.decision",approval_id:"p",conversation_id:"conv",agent_id:"a",decision:"allow",occurred_at:2500},{event_type:"human.decision",approval_id:"other",conversation_id:"conv",agent_id:"a",decision:"allow",occurred_at:3000}];
  const trajectory=await readTrajectory(cfg,"session-alpha");const m=map(computeObservationMetrics({sessionId:"s",trajectory,tools:trajectory.tool_calls,records}));
  assert.equal(m.human_request_count.value,1);assert.equal(m.human_confirm_count.value,1);assert.equal(m.human_wait_ms.value,1500);
  const noTime=records.map(r=>({...r,occurred_at:null}));assert.equal(map(computeObservationMetrics({sessionId:'s',trajectory,tools:trajectory.tool_calls,records:noTime})).human_wait_ms.value,null);
  assert.equal(parseWsNotification(JSON.stringify({ext:{event_type:"human.decision",decision:"random",approval_id:"p"}})),null);
});

test("legacy attempt files cannot enable tokens/TTFT/retry and invalid binding errors are explicit",async()=>{
  await fs.mkdir(cfg.collectorDirectory,{recursive:true});await fs.writeFile(path.join(cfg.collectorDirectory,"attempts-20261013.jsonl"),'{"session_id":"session-alpha","first_output_source":"derived","first_output_at":1200,"requested_at":1000}\n');
  const adapter=new DoubaoAdapter(cfg);const c=await adapter.capabilities();
  assert.equal(c.has_tokens,false);assert.equal(c.has_ttft,false);assert.equal(c.has_retry,false);assert.equal(c.has_human_confirm,false);
  await assert.rejects(new DoubaoAdapter({...cfg,conversationBindings:"bad"}).extractMetrics("session-alpha"),/Invalid/);
});

test("RPA errors remain installation scoped until explicitly session-bound",async()=>{
  const dir=path.join(cfg.rpaDevDir,"local-preview/production-traces/run-fixture");await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,"runner-events.ndjson"),'{"event":"runner_completed","duration_ms":99,"exit_code":2,"unix_ms":1000}\n{"session_id":"session-alpha","event":"child_command_finished","duration_ms":12,"exit_code":0,"unix_ms":1100}\n');
  const adapter=new DoubaoAdapter(cfg);const alpha=map(await adapter.extractMetrics("session-alpha")),beta=map(await adapter.extractMetrics("session-beta"));
  assert.equal(alpha.rpa_run_count.value,null);assert.equal(alpha.rpa_command_ms.value,12);assert.equal(beta.rpa_command_ms.value,null);
  const installation=map((await adapter.extractInfrastructure()).items);assert.equal(installation.rpa_run_count.value,1);assert.equal(installation.rpa_run_ms.value,99);
});

test("collector identities merge uniquely, late/orphan returns persist and conflicting results remain unknown",async()=>{
  const trajectory=await readTrajectory(cfg,"session-alpha");
  const records=[{event_id:'cdp-a',event_type:'tool.call',tool_call_id:'shared-id',agent_id:'agent-one',occurred_at:1000},
    {event_id:'cdp-b',event_type:'tool.result',tool_call_id:'shared-id',agent_id:'agent-one',exit_code:2,occurred_at:1200},
    {event_id:'cdp-c',event_type:'tool.result',tool_call_id:'orphan-cdp',agent_id:'agent-one',status:'ok',occurred_at:1300}];
  const merged=mergeCollectorTools(trajectory,records,'session-alpha');
  assert.equal(merged.calls.length,3);assert.equal(merged.collector_orphans,1);
  const call=merged.calls.find(c=>c.agent_id==='agent-one'&&c.native_call_id==='shared-id');assert.equal(call.status,'unknown');
  const events=collectorEvents(records,'session-alpha',merged.calls);assert.equal(events[0].call_id,call.call_id);assert.equal(events[1].call_id,call.call_id);
  const reconciliation=mergeCollectorTools(trajectory,[{event_id:'late',event_type:'tool.call',tool_call_id:'orphan-id',agent_id:'agent-one'}],'session-alpha');
  assert.equal(reconciliation.calls.length,4);assert.equal(reconciliation.trajectory_orphans,0);assert.equal(reconciliation.calls.at(-1).result_count,1);
});

test("session-owned RPA paths bind without borrowing another session or requiring global IDs",async()=>{
  const sessionsRoot=path.join(sandbox,'owned');const dir=path.join(sessionsRoot,'owned-a/agents/one/rpa-projects/project/.rpa-dev/traces/run-one');
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'runner-events.ndjson'),'{"event":"runner_completed","duration_ms":31,"unix_ms":3000}\n{"event":"runner_completed","duration_ms":999,"session_id":"other","unix_ms":3100}\n');
  const adapter=new DoubaoAdapter({...cfg,sessionsRoot});
  assert.equal(map(await adapter.extractMetrics('owned-a')).rpa_run_ms.value,31);
  assert.equal(map(await adapter.extractMetrics('other')).rpa_run_ms.value,null);
});

test("untimed trajectory is listed without a date filter and cannot satisfy a native-time range",async()=>{
  const adapter=new DoubaoAdapter(cfg);assert.equal((await adapter.extractSessions()).items.length,2);
  assert.equal((await adapter.extractSessions({since:1000})).items.length,0);
});
