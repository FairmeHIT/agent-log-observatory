import { BaseAdapter } from "./base-adapter.mjs";
import { resolveAgentConfig } from "../lib/config.mjs";
import { getCollectorRoot } from "../lib/runtime-paths.mjs";
import { normalizeSession, normalizeEvent } from "../lib/normalizer.mjs";
import { makeDataCompleteness } from "../lib/evidence.mjs";
import { computeObservationMetrics, computeInfrastructureMetrics } from "../lib/metrics.mjs";
import { dirs, readTrajectory, readCollector, validateBindings, bindCollectorRecords, mergeCollectorTools, collectorEvents, readInfrastructure } from "./doubao-sources.mjs";
import path from "node:path";
import fs from "node:fs/promises";

const MISSING = ["tokens", "ttft", "retry", "model_routing", "step", "human_confirm", "turn_timing"];
const sourceRefs=sessionId=>({
  trajectory:{source_id:`doubao:trajectory:${sessionId}`,source_kind:"trajectory",locator:"agents/*/system/trajectory.jsonl",raw_type:"message",rule_version:"doubao-0.3.0"},
  collector:{source_id:"doubao:collector",source_kind:"cdp",locator:"events-YYYYMMDD.jsonl (explicitly bound records)",raw_type:"client-observation",rule_version:"doubao-0.3.0"},
  infrastructure:{source_id:"doubao:rpa-bridge",source_kind:"runner_bridge",locator:"runner-events.ndjson / bridge.log (scope-filtered)",rule_version:"doubao-0.3.0"},
});

export class DoubaoAdapter extends BaseAdapter {
  static agentObject = "doubao";
  static adapterVersion = "0.3.0";
  constructor(agentConfig = null) { super(agentConfig); this.agentConfig = agentConfig; }
  get cfg() { return this.agentConfig || resolveAgentConfig("doubao"); }
  get collectorDirectory() { return this.cfg.collectorDirectory || path.join(getCollectorRoot(),"doubao"); }

  async discover() {
    const cfg=this.cfg;
    const checks={trajectory:false,rpaTraces:false,bridgeLog:false,collectorEvents:false};
    for(const session of await dirs(cfg.sessionsRoot)) {
      for(const agent of await dirs(path.join(cfg.sessionsRoot,session,"agents"))) {
        try { await fs.access(path.join(cfg.sessionsRoot,session,"agents",agent,"system","trajectory.jsonl"));checks.trajectory=true;break; } catch {}
      }
      if(checks.trajectory)break;
    }
    try {await fs.access(path.join(cfg.rpaDevDir,"local-preview","production-traces"));checks.rpaTraces=true;}catch{}
    try {await fs.access(path.join(cfg.rpaDevDir,"local-preview","bridge.log"));checks.bridgeLog=true;}catch{}
    checks.collectorEvents=(await readCollector(this.collectorDirectory)).records.length>0;
    return {agent_object:"doubao",installation_id:"default",sources:checks,available:checks.trajectory||checks.rpaTraces||checks.bridgeLog,missing_reasons:[],adapter_version:DoubaoAdapter.adapterVersion,modes:["offline"]};
  }

  async facts(sessionId) {
    const bindings=validateBindings(this.cfg.conversationBindings);
    const [trajectory,collector,infrastructure]=await Promise.all([readTrajectory(this.cfg,sessionId),readCollector(this.collectorDirectory),readInfrastructure(this.cfg,sessionId)]);
    const records=bindCollectorRecords(collector.records,sessionId,bindings);
    const merged=mergeCollectorTools(trajectory,records,sessionId);
    const known=await dirs(this.cfg.sessionsRoot);
    const boundIds=new Set();for(const sid of known)for(const r of bindCollectorRecords(collector.records,sid,bindings))boundIds.add(r.event_id);
    return {trajectory,records,tools:merged.calls,infrastructure,collector:{...collector,trajectory_orphan_results:merged.trajectory_orphans,orphan_results:merged.collector_orphans,duplicate_calls:merged.duplicate_calls,duplicate_results:merged.duplicate_results,unbound_count:collector.available?collector.records.filter(r=>!boundIds.has(r.event_id)).length:null}};
  }

  async capabilities(context = {}) {
    const collector=await readCollector(this.collectorDirectory);
    const records=context.session_id ? bindCollectorRecords(collector.records,context.session_id,validateBindings(this.cfg.conversationBindings)) : collector.records;
    return {has_tokens:false,has_ttft:false,has_retry:false,has_model_routing:false,has_event_stream:true,has_step:false,has_tool_calls:true,
      has_human_confirm:records.some(r=>r.event_type==="human.decision"&&r.approval_id),
      has_client_first_text:records.some(r=>r.event_type==="stream.text"&&r.occurred_at!=null&&!r.delayed),
      collector_active:["connected","partial"].includes(collector.health?.status)&&collector.health?.connected_targets>0&&Date.now()-collector.health.updated_at<15000,
      missing_fields:[...MISSING],ttft_caveat:"Client first-text timing is separate from internal LLM TTFT"};
  }

  async extractSessions(options = {}) {
    const items=[];
    // Untimed sources cannot satisfy a filter on native occurrence time.
    if(options.since || options.until)return {items,nextCursor:null,asOf:Date.now(),coverage:{total:0}};
    for(const sessionId of await dirs(this.cfg.sessionsRoot)) {
      const source=await readTrajectory(this.cfg,sessionId);if(!source.stats.source_files)continue;
      items.push(normalizeSession({agent_object:"doubao",installation_id:"default",session_id:sessionId,
        started_at:null,ended_at:null,source_status:source.stats.parse_errors||source.stats.partial_lines||source.stats.limited?"partial":"ok",
        tool_call_count:source.tool_calls.length,event_counts:{"agent.input":source.stats.user_count,"llm.response":source.stats.assistant_count,"tool.call":source.tool_calls.length,"tool.result":source.stats.result_records},
        data_completeness:makeDataCompleteness(MISSING),coverage:{observed:source.stats.raw_records}}));
    }
    return {items:options.limit?items.slice(0,options.limit):items,nextCursor:null,asOf:Date.now(),coverage:{total:items.length}};
  }

  async extractEvents(sessionId) {
    const f=await this.facts(sessionId);
    const infra=f.infrastructure.events.map(r=>normalizeEvent({agent_object:"doubao",installation_id:"default",session_id:sessionId,event_id:r.event_id,event_category:"other",event_subtype:r.event_type,event_type_raw:r.event_type,occurred_at:r.occurred_at,timestamp_basis:r.timestamp_basis,binding_status:"bound",status:r.status,metadata:{source_kind:"rpa",rpa_run_id:r.rpa_run_id,method:r.method,duration_ms:r.duration_ms,queue_depth:r.queue_depth}}));
    return [...f.trajectory.events,...collectorEvents(f.records,sessionId,f.tools),...infra];
  }
  async extractCalls(sessionId) {
    const f=await this.facts(sessionId);return {llm_calls:f.trajectory.llm_calls,tool_calls:f.tools};
  }
  async extractUsage() { return []; }
  async extractExcerpt(sessionId) {
    // No prompt or response body leaves the adapter's normal read API.
    return {session_id:sessionId,agent_object:"doubao",first_user_message:null,last_assistant_message:null,last_assistant_model:null};
  }
  async extractTurns() { return []; }
  async extractFailures(sessionId) {
    const f=await this.facts(sessionId);
    const direct=f.tools.filter(c=>c.status==="error").map(c=>({category:"tool",entity:c.call_id,tool_name:c.tool_name,exit_code:c.exit_code,evidence_grade:"direct",rule:"explicit_tool_terminal"}));
    const complete=f.trajectory.stats.source_files>0&&!f.trajectory.stats.parse_errors&&!f.trajectory.stats.partial_lines&&!f.trajectory.stats.limited&&f.tools.every(c=>c.status!=="unknown");
    return {diagnostics:[...direct,...f.trajectory.candidates],summary:{gateway:null,tool:direct.length||complete?direct.length:null,model:null,dependency:null,agent:null},source_available:f.trajectory.stats.source_files>0};
  }
  async extractMetrics(sessionId) {
    const f=await this.facts(sessionId);
    return computeObservationMetrics({sessionId,trajectory:f.trajectory,tools:f.tools,records:f.records,collector:f.collector,infrastructure:f.infrastructure.events,sourceRefs:sourceRefs(sessionId)});
  }
  async extractTimeline(sessionId) {
    return (await this.extractEvents(sessionId)).map(e=>({event_id:e.event_id,timestamp:e.occurred_at??e.received_at,action:e.event_subtype||e.event_category,status:e.status,tool_name:e.tool_name,source_seq:e.source_seq,metadata:e.metadata}));
  }
  async extractInfrastructure() {
    const [infra,collector]=await Promise.all([readInfrastructure(this.cfg),readCollector(this.collectorDirectory)]);
    return {items:computeInfrastructureMetrics(infra.events,{source_refs:[sourceRefs(null).infrastructure]}),coverage:{observed:infra.events.length,parse_errors:infra.parse_errors},collector_health:collector.health};
  }
}
