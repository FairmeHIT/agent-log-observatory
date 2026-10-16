import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');

test('Doubao HTTP endpoints preserve untimed sessions, null failures, tool identity and public evidence', {timeout:20000},async()=>{
  const sandbox=path.join(root,'runtime/tests/doubao-api',randomUUID());await fs.mkdir(sandbox,{recursive:true});
  const missing=path.join(sandbox,'missing');
  const keys={workbuddy:['installDir','dataDir','electronLogsDir','electronLogsDirAlt'],mobilework:['installDir','dataDir','dashboardDataDir'],teleagent:['installDir','dataDir','configDir','cacheDir','dbDir'],doubao:['installDir','userDataDir','sessionsRoot','rpaDevDir','chatsDir'],dsh:['installDir','dataDir','electronDataDir','sessionsDir','storagesDir'],codex:['installDir','dataDir','configPath'],opencode:['dataDir','configDir','appDir','cliDir']};
  const agents=Object.fromEntries(Object.entries(keys).map(([name,fields])=>[name,Object.fromEntries(fields.map(k=>[k,missing]))]));
  agents.doubao.sessionsRoot=path.join(root,'tests/fixtures/doubao-sample/sessions');
  agents.doubao.conversationBindings={};
  const reserved=net.createServer();reserved.listen(0,'127.0.0.1');await once(reserved,'listening');const port=reserved.address().port;await new Promise(resolve=>reserved.close(resolve));
  const config=path.join(sandbox,'config.json');await fs.writeFile(config,JSON.stringify({port,runtimeDirectory:sandbox,collectorRoot:path.join(sandbox,'collectors'),agents}));
  const serverPath=path.join(root,'server.mjs');
  const child=spawn(process.execPath,[serverPath],{cwd:root,env:{...process.env,AGENT_LOG_CONFIG:config,AGENT_LOG_RUNTIME_DIR:sandbox,AGENT_LOG_COLLECTOR_ROOT:path.join(sandbox,'collectors'),AGENT_LOG_OBSERVATORY_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});child.stdout.resume();
  const get=async(route)=>{const r=await fetch(`http://127.0.0.1:${port}${route}`,{signal:AbortSignal.timeout(2000)});assert.equal(r.status,200,route);return r.json();};
  try{
    let ready=false;for(let i=0;i<60;i++){try{await get('/api/sessions/doubao');ready=true;break;}catch{assert.equal(child.exitCode,null,errors);await delay(100);}}
    assert.ok(ready,'isolated server ready');
    const sessions=await get('/api/sessions/doubao');assert.equal(sessions.items.length,2);assert.equal(sessions.items[0].started_at,null);
    const prefix='/api/sessions/doubao/default/session-alpha';
    const metrics=await get(prefix+'/metrics?fresh=1');const m=Object.fromEntries(metrics.items.map(v=>[v.metric,v]));
    assert.equal(m.assistant_message_count.value,3);assert.equal(m.llm_call_count.value,null);assert.equal(m.llm_attempt_ttft_ms.value,null);
    assert.equal(m.tool_success_rate.value,.5);assert.ok(m.tool_call_count.source_refs[0].rule_version);
    const calls=await get(prefix+'/calls');assert.equal(calls.tool_calls.length,3);assert.equal(new Set(calls.tool_calls.map(c=>c.call_id)).size,3);
    const events=await get(prefix+'/events');assert.equal(events.items.filter(e=>e.event_category==='tool.call').length,3);
    const infra=await get('/api/agents/doubao/default/infrastructure');assert.ok(infra.items.every(v=>v.scope==='installation'));
    const compare=await get('/api/metrics/compare?agents=doubao');assert.equal(compare.agents.doubao.metrics.failures_model.value??compare.agents.doubao.metrics.failures_model.sum,null);
    const exported=await get('/api/export?agents=doubao');
    assert.equal(exported.export_metadata.capture_policy,'live-bounded-read-window');
    assert.equal(exported.agents.doubao.sessions.length,2);
    assert.equal(exported.agents.doubao.sessions[0].capture.sections.metrics,'read');
    assert.ok(exported.agents.doubao.sessions[0].metrics.some(m=>m.metric==='tool_record_count'));
    assert.equal(exported.chart_data.chart1_task_success.doubao.task_success_rate.value,null);
    const chart=await get('/api/chart-data?agents=doubao');assert.equal(chart.schema_version,'observatory-chart-data-1.0');
    const tools=await get('/api/tool-usage?agents=doubao&top=2');
    assert.equal(tools.read_only,true);assert.equal(tools.source,'live');
    const d=tools.agents.doubao;
    assert.deepEqual(d.tool_usage,[{tool_name:'PowerShell',total:3,ok:1,error:1,cancelled:0,unknown:1}]);
    assert.equal(d.distinct_tool_count,1);assert.equal(d.total_tool_calls,3);assert.equal(d.sessions_considered,2);assert.equal(d.possibly_truncated,false);
    const top1=await get('/api/tool-usage?agents=doubao&top=1');
    assert.equal(top1.agents.doubao.tool_usage.length,1);assert.equal(top1.agents.doubao.tools_truncated,0);
    assert.ok(tools.semantics.activity.includes('observed activity only'));
    const selected=await fetch(`http://127.0.0.1:${port}/api/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessions:[{agent:'doubao',session_id:'session-alpha'}]})});
    assert.equal(selected.status,200);assert.equal((await selected.json()).chart_data.statistics.selected_sessions,1);
    const json=JSON.stringify({metrics,calls,events,infra});assert.ok(!json.includes('SYNTHETIC_PRIVATE_ARGUMENT'));assert.ok(!json.includes('Synthetic fixture prompt'));
  }finally{
    // Only this exact child, launched with the verified workspace server path.
    assert.ok(child.spawnargs.includes(serverPath));
    if(child.exitCode===null){child.kill();await once(child,'exit');}
  }
});

test('Doubao detail rendering executes and escapes source-controlled tool/model text',async()=>{
  const html=await fs.readFile(path.join(root,'index.html'),'utf8');const script=html.match(/<script>([\s\S]*)<\/script>/)[1].replace(/\binit\(\);\s*$/,'');
  const main={innerHTML:''};const context=vm.createContext({document:{getElementById:()=>main,addEventListener:()=>{}},localStorage:{getItem:()=>null},URLSearchParams,console,window:{}});
  new vm.Script(script).runInContext(context);
  const hostile='<img src=x onerror=alert(1)>';
  context.fixture={hostile,metrics:[{metric:'assistant_message_count',value:3,state:'captured',evidence_grade:'direct',coverage:{eligible:3,observed:3}},{metric:'llm_attempt_ttft_ms',value:null,state:'not-captured',missing_reason:'missing_first_chunk'}]};
  vm.runInContext(`renderDetail('doubao','fixture',fixture.metrics,{llm_calls:[],tool_calls:[{call_id:'t',tool_name:fixture.hostile,status:'error'}]},[],{summary:{tool:1},diagnostics:[{category:'tool',tool_name:fixture.hostile}]},[],null);`,context);
  assert.ok(main.innerHTML.includes('助手消息'));assert.ok(main.innerHTML.includes('首文本延迟'));assert.ok(main.innerHTML.includes('not-captured'));
  assert.ok(!main.innerHTML.includes(hostile));assert.ok(main.innerHTML.includes('&lt;img'));
});
