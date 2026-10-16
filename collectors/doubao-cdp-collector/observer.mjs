// Explicit CDP observer: no prompts, DOM changes, request interception or bodies on disk.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { getCollectorRoot, runtimePath } from "../../lib/runtime-paths.mjs";
import { CaptureTracker, COLLECTOR_VERSION } from "./capture.mjs";

const port = Number(process.env.DOUBAO_CDP_PORT || 9223);
if (!Number.isInteger(port) || port<1 || port>65535) throw new Error("Invalid DOUBAO_CDP_PORT");
const outputDir = path.join(getCollectorRoot(),"doubao");
const lockPath = runtimePath("doubao-cdp-collector.lock");
const healthPath = path.join(outputDir,"health.json");
const epoch = randomUUID();
fs.mkdirSync(outputDir,{recursive:true});
fs.mkdirSync(path.dirname(lockPath),{recursive:true});
try {
  const fd = fs.openSync(lockPath,"wx");
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,epoch,collector_version:COLLECTOR_VERSION})); fs.closeSync(fd);
} catch {
  console.error("Doubao collector lock exists; verify its owner before removing a stale lock."); process.exit(1);
}

let stopped = false, eventCount = 0, writeErrors = 0, protocol = null;
const connections = new Map(); const pendingTargets = new Set();
function day() { return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()).replaceAll("-",""); }
function emit(record) {
  try { fs.appendFileSync(path.join(outputDir,`events-${day()}.jsonl`),JSON.stringify(record)+"\n"); eventCount++; }
  catch { writeErrors++; }
}
function health(status,reason=null) {
  if(stopped && status!=="stopped")return;
  if(status==="connected" && (writeErrors || !protocol?.streaming_supported)) { status="partial"; reason=writeErrors?"write_failed":"streaming_unsupported"; }
  const value = { collector_version:COLLECTOR_VERSION, status, reason, updated_at:Date.now(), capture_epoch:epoch,
    connected_targets:connections.size, event_count:eventCount, write_errors:writeErrors,
    browser_version:protocol?.browser_version ?? null, protocol_version:protocol?.protocol_version ?? null,
    streaming_supported:protocol?.streaming_supported ?? false };
  try { const tmp=healthPath+`.${process.pid}.tmp`; fs.writeFileSync(tmp,JSON.stringify(value)); fs.renameSync(tmp,healthPath); } catch { writeErrors++; }
}
function get(p) {
  return new Promise((resolve,reject)=>{
    const req=http.get({host:"127.0.0.1",port,path:p,timeout:3000},res=>{
      let body=""; res.on("data",c=>{body+=c;if(body.length>8*1024*1024)req.destroy(new Error("response_limit"));});
      res.on("end",()=>{try {if(res.statusCode!==200)throw Error("cdp_http_error");resolve(JSON.parse(body));}catch{reject(new Error("cdp_response_invalid"));}});
    }); req.on("error",()=>reject(new Error("cdp_unavailable"))); req.on("timeout",()=>req.destroy(new Error("cdp_timeout")));
  });
}
function safeTarget(t) {
  try { const url=new URL(t.url);return ["page","iframe","worker","service_worker"].includes(t.type) &&
    (url.protocol==="doubao:" || url.hostname==="www.doubao.com") && typeof t.webSocketDebuggerUrl==="string"; } catch {return false;}
}
function safeSocket(value) {
  const u=new URL(value); if(u.protocol!=="ws:" || !["127.0.0.1","localhost"].includes(u.hostname) || Number(u.port)!==port)throw Error("non_loopback_target");
  return u.href;
}
async function attach(target) {
  if(connections.has(target.id)||pendingTargets.has(target.id))return;
  pendingTargets.add(target.id);
  let ws,tracker; const pending=new Map(); let msgId=0;
  try {
    ws=new WebSocket(safeSocket(target.webSocketDebuggerUrl));
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("connect_timeout")),5000);ws.onopen=()=>{clearTimeout(timer);resolve();};ws.onerror=()=>{clearTimeout(timer);reject(new Error("connect_failed"));};});
    if(stopped){ws.close();return;}
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++msgId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error("command_timeout"));},5000);
      pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
    });
    tracker=new CaptureTracker({epoch,targetId:target.id,emit,send:async(method,params)=>{
      if(method==="Network.streamResourceContent"&&!protocol.streaming_supported)throw Error("unsupported");return send(method,params);
    }});
    ws.onmessage=raw=>{
      let msg;try{msg=JSON.parse(raw.data);}catch{return;}
      if(msg.id!=null){const p=pending.get(msg.id);if(!p)return;clearTimeout(p.timer);pending.delete(msg.id);if(msg.error)p.reject(new Error("cdp_command_rejected"));else p.resolve(msg.result||{});return;}
      if(msg.method)tracker.handle(msg.method,msg.params||{}).catch(()=>health("partial","event_parse_failed"));
    };
    ws.onclose=()=>{tracker.close();connections.delete(target.id);for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("disconnected"));}pending.clear();health(connections.size?"partial":"disconnected","target_closed");};
    ws.onerror=()=>health("partial","socket_error");
    await send("Network.enable");connections.set(target.id,{ws,tracker});health("connected");
  } catch {try{ws?.close();}catch{} health(connections.size?"partial":"disconnected","attach_failed");}
  finally {pendingTargets.delete(target.id);}
}
let polling=false;
async function poll() {
  if(stopped||polling)return;polling=true;
  try {
    const version=await get("/json/version");const definitions=await get("/json/protocol");
    const network=definitions.domains?.find(d=>d.domain==="Network");
    protocol={browser_version:typeof version.Browser==="string"?version.Browser.slice(0,100):null,
      protocol_version:typeof version["Protocol-Version"]==="string"?version["Protocol-Version"]:null,
      streaming_supported:!!network?.commands?.some(c=>c.name==="streamResourceContent")};
    const targets=(await get("/json/list")).filter(safeTarget);
    await Promise.allSettled(targets.map(attach));
    health(connections.size?"connected":"disconnected",connections.size?null:"no_supported_target");
  } catch {health(connections.size?"partial":"disconnected","cdp_unavailable");}
  finally {polling=false;}
}
function stop() {
  if(stopped)return;stopped=true;clearInterval(timer);
  for(const {ws,tracker} of connections.values()){tracker.close();ws.close();}connections.clear();health("stopped");
  try{if(JSON.parse(fs.readFileSync(lockPath,"utf8")).epoch===epoch)fs.unlinkSync(lockPath);}catch{}
  setTimeout(()=>process.exit(0),100).unref();
}
process.on("SIGINT",stop);process.on("SIGTERM",stop);
const timer=setInterval(poll,5000);health("disconnected","starting");await poll();
