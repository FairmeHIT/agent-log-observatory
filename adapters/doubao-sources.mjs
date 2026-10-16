import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeEvent } from "../lib/normalizer.mjs";

const hash = value => createHash("sha256").update(value).digest("hex").slice(0,32);
export const id = v => typeof v === "string" && v!=="." && v!==".." && /^[\w.:-]{1,200}$/.test(v) ? v : null;
const status = obj => Number.isInteger(obj.exit_code) ? (obj.exit_code===0 ? "ok" : "error") :
  ["ok","error","cancelled"].includes(obj.status) ? obj.status : typeof obj.success === "boolean" ? obj.success ? "ok" : "error" : "unknown";

export async function dirs(dir) { try { return (await fs.readdir(dir,{withFileTypes:true})).filter(d=>d.isDirectory()&&!d.isSymbolicLink()).map(d=>d.name).sort(); } catch { return []; } }
export async function readJsonl(file) {
  try {
    const stat = await fs.stat(file); if (stat.size>32*1024*1024) return {rows:[],available:true,parse_errors:0,partial_lines:0,limited:true,updated_at:stat.mtimeMs};
    const text=await fs.readFile(file,"utf8"); const lines=text.split("\n"), rows=[];let parse_errors=0,partial_lines=0;
    for(let i=0;i<lines.length;i++){if(!lines[i].trim())continue;try{const obj=JSON.parse(lines[i]);if(!obj||typeof obj!=="object"||Array.isArray(obj))throw Error();rows.push({obj,line:i});}catch{if(i===lines.length-1&&!text.endsWith("\n"))partial_lines++;else parse_errors++;}}
    return {rows,available:true,parse_errors,partial_lines,limited:false,updated_at:stat.mtimeMs};
  } catch { return {rows:[],available:false,parse_errors:0,partial_lines:0,limited:false,updated_at:null}; }
}

export async function readTrajectory(cfg,sessionId) {
  if(!id(sessionId))throw Error("invalid_session_id");
  const root=path.join(cfg.sessionsRoot,sessionId,"agents");const events=[],tools=new Map(),results=new Map(),llm=new Map();
  const stats={source_files:0,parse_errors:0,partial_lines:0,limited:false,raw_records:0,assistant_count:0,user_count:0,result_records:0,duplicate_calls:0,duplicate_results:0,updated_at:null,agent_count:0};
  const candidates=[];
  for(const agentId of await dirs(root)){
    const parsed=await readJsonl(path.join(root,agentId,"system","trajectory.jsonl"));if(!parsed.available)continue;
    stats.source_files++;stats.agent_count++;stats.parse_errors+=parsed.parse_errors;stats.partial_lines+=parsed.partial_lines;stats.limited ||= parsed.limited;
    stats.updated_at=Math.max(stats.updated_at??0,parsed.updated_at??0)||null;
    for(const {obj,line}of parsed.rows){
      stats.raw_records++;
      const base={agent_object:"doubao",installation_id:"default",session_id:sessionId,source_seq:line,occurred_at:null,timestamp_basis:"unknown",binding_status:"bound",metadata:{agent_id:agentId,source_kind:"trajectory"}};
      const messageId=`doubao:${hash(JSON.stringify([sessionId,agentId,line,obj.role,obj.id??null]))}`;
      const emit=(category,suffix,extra={})=>events.push(normalizeEvent({...base,event_id:`${messageId}:${suffix}`,message_id:messageId,event_category:category,event_type_raw:`trajectory.${obj.role}`,...extra}));
      if(obj.role==="user"){stats.user_count++;emit("agent.input","input");}
      if(obj.role==="assistant"){
        stats.assistant_count++;emit("llm.response","response");
        const nativeCall=id(obj.llm_call_id);if(nativeCall)llm.set(`${agentId}:${nativeCall}`,{llm_call_id:`doubao:${agentId}:${nativeCall}`,session_id:sessionId,status:"unknown",requested_model:null,routed_model:null,usage_record_ids:[]});
        for(const [i,tc] of (Array.isArray(obj.tool_calls)?obj.tool_calls:[]).entries()){
          const raw=id(tc.id),key=raw?`${agentId}:${raw}`:`${messageId}:${i}`;
          if(tools.has(key)){stats.duplicate_calls++;continue;}
          const call={call_id:`doubao:${hash(JSON.stringify([sessionId,key]))}`,native_call_id:raw,agent_id:agentId,session_id:sessionId,agent_object:"doubao",tool_name:typeof tc.function?.name==="string"?tc.function.name.slice(0,100):null,started_at:null,ended_at:null,status:"unknown",exit_code:null,llm_call_id:nativeCall?`doubao:${agentId}:${nativeCall}`:null,result_count:0};
          tools.set(key,call);emit("tool.call",`tool:${i}`,{call_id:call.call_id,tool_name:call.tool_name});
        }
      }
      if(obj.role==="tool"){
        stats.result_records++;
        const raw=id(obj.tool_call_id),key=raw?`${agentId}:${raw}`:`orphan:${messageId}`;
        if(results.has(key)){
          stats.duplicate_results++;
          const result=results.get(key);
          if(result.status!==status(obj)){result.status="unknown";result.exit_code=null;result.event.status="unknown";}
          continue;
        }
        const result={key,agent_id:agentId,native_call_id:raw,status:status(obj),exit_code:Number.isInteger(obj.exit_code)?obj.exit_code:null};results.set(key,result);
        emit("tool.result","result",{call_id:raw?`doubao:${hash(JSON.stringify([sessionId,key]))}`:null,status:result.status});
        result.event=events.at(-1);
        if(result.status==="unknown"&&typeof obj.content==="string"&&/\berror\b|exit code\s*:\s*[1-9]/i.test(obj.content))candidates.push({category:"tool",entity:raw,evidence_grade:"estimated",rule:"tool_text_error_candidate"});
      }
    }
  }
  let orphan=0;
  for(const [key,result]of results){const call=tools.get(key);if(!call){orphan++;continue;}call.result_count=1;call.status=result.status;call.exit_code=result.exit_code;}
  return {events,tool_calls:[...tools.values()],tool_results:[...results.values()].map(({event,...result})=>result),llm_calls:[...llm.values()],stats:{...stats,unique_results:results.size,orphan_results:orphan},candidates};
}

export function validateBindings(value) {
  if(value==null)return {};
  if(typeof value!=="object"||Array.isArray(value)||Object.entries(value).some(([k,v])=>!id(k)||!id(v)))throw Error("Invalid Doubao conversationBindings: expected session-directory ID to conversation ID map");
  return value;
}

export function bindCollectorRecords(records,sessionId,bindings) {
  const configured=bindings[sessionId];const owners=configured?Object.values(bindings).filter(v=>v===configured).length:0;
  // Exact directory ID must be explicitly supplied in its own namespace.
  return records.filter(r=>r.trajectory_session_id===sessionId ||
    (r.trajectory_session_id==null && owners===1 && r.conversation_id===configured));
}

export async function readCollector(root) {
  let names;try{names=await fs.readdir(root);}catch{return {records:[],health:null,available:false,parse_errors:0,limited:false};}
  const records=[],seen=new Set();let parse_errors=0,limited=names.filter(n=>/^events-\d{8}\.jsonl$/.test(n)).length>30;
  for(const name of names.filter(n=>/^events-\d{8}\.jsonl$/.test(n)).sort().slice(-30)){
    const parsed=await readJsonl(path.join(root,name));parse_errors+=parsed.parse_errors+parsed.partial_lines;limited ||= parsed.limited;
    for(const {obj}of parsed.rows){if(obj.schema_version!=="doubao-collector-event-0.1.0"||typeof obj.event_id!=="string"||typeof obj.event_type!=="string")continue;if(seen.has(obj.event_id))continue;seen.add(obj.event_id);records.push(obj);}
  }
  let health=null;try{health=JSON.parse(await fs.readFile(path.join(root,"health.json"),"utf8"));}catch{}
  return {records,health,available:names.some(n=>/^events-\d{8}\.jsonl$/.test(n)),parse_errors,limited};
}

export function mergeCollectorTools(trajectory,records,sessionId) {
  const calls=trajectory.tool_calls.map(c=>({...c}));const unique=new Map();
  let duplicateCalls=0,duplicateResults=0;
  for(const r of records.filter(r=>["tool.call","tool.result"].includes(r.event_type)&&id(r.tool_call_id))){
    const key=`${r.agent_id??""}:${r.tool_call_id}`;
    if(!unique.has(key))unique.set(key,{call:null,result:null});const pair=unique.get(key),kind=r.event_type==="tool.call"?"call":"result";
    if(pair[kind]){if(kind==="call")duplicateCalls++;else duplicateResults++;}
    if(kind==="result"&&pair.result&&status(pair.result)!==status(r)){pair.conflict=true;}
    pair[kind]=r;
  }
  let orphan=0,reconciled=0;
  for(const pair of unique.values()){
    const r=pair.call??pair.result;
    const matching=calls.filter(c=>c.native_call_id===r.tool_call_id&&(!r.agent_id||c.agent_id===r.agent_id));
    if(matching.length>1)continue; // Ambiguous agent namespace: no inferred merge.
    let call=matching[0];
    if(!call&&pair.call){call={call_id:`doubao:${hash(JSON.stringify([sessionId,r.agent_id,r.tool_call_id]))}`,native_call_id:r.tool_call_id,agent_id:r.agent_id,session_id:sessionId,agent_object:"doubao",tool_name:r.tool_name??null,status:"unknown",exit_code:null,started_at:null,ended_at:null,llm_call_id:null,result_count:0};calls.push(call);}
    const nativeResults=(trajectory.tool_results??[]).filter(t=>t.native_call_id===r.tool_call_id&&(!r.agent_id||t.agent_id===r.agent_id));
    const nativeResult=nativeResults.length===1?nativeResults[0]:null;
    if(!call){if(!nativeResult)orphan++;continue;}
    if(nativeResult&&!trajectory.tool_calls.some(t=>t.call_id===call.call_id)){
      reconciled++;call.result_count=1;call.status=nativeResult.status;call.exit_code=nativeResult.exit_code;
    }
    if(pair.call)call.started_at=pair.call.occurred_at??null;
    if(pair.result){call.result_count=1;call.ended_at=pair.result.occurred_at??null;const observed=status(pair.result);
      if(pair.conflict || call.status!=="unknown"&&observed!=="unknown"&&call.status!==observed){call.status="unknown";call.exit_code=null;}
      else if(call.status==="unknown"){call.status=observed;call.exit_code=pair.result.exit_code??null;}
    }
  }
  return {calls,collector_orphans:orphan,trajectory_orphans:Math.max(0,trajectory.stats.orphan_results-reconciled),duplicate_calls:duplicateCalls,duplicate_results:duplicateResults};
}

export function collectorEvents(records,sessionId,tools=[]) {
  return records.map(r=>{const matches=tools.filter(c=>c.native_call_id===r.tool_call_id&&(!r.agent_id||c.agent_id===r.agent_id));return normalizeEvent({agent_object:"doubao",installation_id:"default",session_id:sessionId,binding_status:"bound",
    event_id:r.event_id,source_seq:r.source_seq,call_id:matches.length===1?matches[0].call_id:null,message_id:r.message_id??null,
    event_category:r.event_type==="tool.call"?"tool.call":r.event_type==="tool.result"?"tool.result":"other",
    event_subtype:r.event_type,event_type_raw:`cdp.${r.event_type}`,occurred_at:r.occurred_at??null,received_at:r.received_at??null,
    timestamp_basis:r.timestamp_basis,status:r.status??"unknown",tool_name:r.tool_name??null,
    metadata:{agent_id:r.agent_id??null,source_kind:"cdp",request_id:r.request_id??null,conversation_id:r.conversation_id??null,approval_id:r.approval_id??null,decision:r.decision??null,text_chars:r.text_chars??null,reason:r.reason??null,task_status:r.task_status??null}});});
}

// Global RPA/bridge diagnostics remain installation-scoped. They are never copied
// into every session. Only explicit session IDs or a session-owned trace path bind.
export async function readInfrastructure(cfg,sessionId=null) {
  const events=[];let available=0,parse_errors=0;
  const sources=[];const traces=path.join(cfg.rpaDevDir,"local-preview","production-traces");
  for(const run of (await dirs(traces)).slice(-100))sources.push({file:path.join(traces,run,"runner-events.ndjson"),run});
  sources.push({file:path.join(cfg.rpaDevDir,"local-preview","bridge.log"),run:null});
  const sessions=sessionId==null?await dirs(cfg.sessionsRoot):[sessionId];
  for(const owner of sessions){
    if(!id(owner))continue;
    const agents=path.join(cfg.sessionsRoot,owner,"agents");
    for(const agent of await dirs(agents)){
      const projects=path.join(agents,agent,"rpa-projects");
      for(const project of await dirs(projects)){
        const local=path.join(projects,project,".rpa-dev","traces");
        const runId=`${owner}:${agent}:${project}`;
        sources.push({file:path.join(local,"runner-events.ndjson"),run:runId,owner});
        for(const run of (await dirs(local)).slice(-100))sources.push({file:path.join(local,run,"runner-events.ndjson"),run:`${runId}:${run}`,owner});
      }
    }
  }
  for(const source of sources){const parsed=await readJsonl(source.file);if(parsed.available)available++;parse_errors+=parsed.parse_errors;
    for(const {obj,line}of parsed.rows){
      const explicit=id(obj.trajectory_session_id??obj.session_id);
      if(source.owner&&explicit&&explicit!==source.owner)continue;
      const nativeSession=explicit??source.owner??null;
      if(sessionId!=null&&nativeSession!==sessionId)continue;
      const at=Number.isFinite(obj.unix_ms)?obj.unix_ms:typeof obj.ts==="string"?Date.parse(obj.ts):null;
      if(!["runner_started","runner_completed","child_command_started","child_command_finished"].includes(obj.event)&&source.run)continue;
      const method=typeof obj.method==="string"&&/^[\w-]{1,60}$/.test(obj.method)?obj.method:null;
      events.push({event_id:`rpa:${hash(JSON.stringify([source.run??"bridge",line,obj.unix_ms,obj.event]))}`,event_type:source.run?`rpa.${obj.event}`:"bridge.event",occurred_at:Number.isFinite(at)?at:null,
        received_at:null,timestamp_basis:Number.isFinite(at)?"native":"unknown",session_id:nativeSession,rpa_run_id:source.run,
        method,duration_ms:Number.isFinite(obj.duration_ms)?obj.duration_ms:Number.isFinite(obj.elapsed_ms)?obj.elapsed_ms:null,
        execution_ms:Number.isFinite(obj.execution_ms)?obj.execution_ms:null,queue_depth:Number.isFinite(obj.queue_depth)?obj.queue_depth:null,
        exit_code:Number.isInteger(obj.exit_code)?obj.exit_code:null,status:typeof obj.ok==="boolean"?obj.ok?"ok":"error":status(obj)});
    }
  }
  return {events,available:available>0,parse_errors};
}
