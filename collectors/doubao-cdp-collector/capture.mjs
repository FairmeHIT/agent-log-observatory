// Pure parsers/state machine. Text is held only in the incremental parser;
// emitted records contain allowlisted metadata, counts and observation times.
import { createHash, randomUUID } from "node:crypto";

export const EVENT_SCHEMA = "doubao-collector-event-0.1.0";
export const COLLECTOR_VERSION = "0.3.0";
export const safeId = value => typeof value === "string" && /^[\w.:/-]{1,200}$/.test(value) ? value : null;
const number = value => Number.isFinite(value) ? value : null;
const code = value => typeof value === "string" && /^[\w.-]{1,80}$/.test(value) ? value : null;
const hash = value => createHash("sha256").update(value).digest("hex").slice(0,32);

export function isCompletionUrl(value) {
  try { const u = new URL(value); return u.protocol === "https:" && u.hostname === "www.doubao.com" && u.pathname === "/chat/completion"; } catch { return false; }
}

export function extractRequestMeta(postData) {
  let body; try { body = JSON.parse(postData || "{}"); } catch { return {}; }
  const config = body.option?.model_config;
  return {
    conversation_id: safeId(body.conversation_id ?? body.conversationId ?? body.client_meta?.conversation_id),
    message_id: safeId(body.message_id ?? body.client_meta?.message_id),
    // This explicitly named field is optional. conversation_id is not a file session ID.
    trajectory_session_id: safeId(body.trajectory_session_id),
    agent_id: safeId(body.agent_id), sandbox_id: safeId(body.option?.general_task_param?.sandbox_id ?? body.general_task_param?.sandbox_id),
    requested_model: code(config?.model_item_key ?? body.model),
    configured_context_window: number(Number(config?.model_extra_params?.total_window_size)) || null,
  };
}

export class SseParser {
  constructor(onEvent, { maxEventBytes = 1024 * 1024 } = {}) {
    this.onEvent = onEvent; this.maxEventBytes = maxEventBytes;
    this.decoder = new TextDecoder(); this.buffer = ""; this.event = ""; this.data = []; this.id = null;
    this.bytes = 0; this.dropping = false; this.errors = 0; this.texts = new Map(); this.seenIds = new Set();
  }
  push(bytes, at, delayed = false) {
    this.buffer += typeof bytes === "string" ? bytes : this.decoder.decode(bytes, { stream: true });
    let match;
    while ((match = /\r\n|\r|\n/.exec(this.buffer))) {
      // A CR at the end may be the first half of CRLF.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0,match.index); this.buffer = this.buffer.slice(match.index+match[0].length);
      this.line(line, at, delayed);
    }
    if (Buffer.byteLength(this.buffer) > this.maxEventBytes) { this.buffer = ""; this.dropping = true; this.errors++; }
  }
  finish(at) {
    this.push(this.decoder.decode(), at);
    // SSE requires a blank line to dispatch. EOF does not complete a partial event.
    if (this.buffer.trim() || this.data.length) this.errors++;
    this.buffer = ""; this.data=[]; this.texts.clear(); this.seenIds.clear();
  }
  line(line, at, delayed) {
    if (!line) {
      if (!this.dropping && this.data.length) this.dispatch(at,delayed);
      this.event = ""; this.data = []; this.id = null; this.bytes = 0; this.dropping = false; return;
    }
    if (line.startsWith(":")) return;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > this.maxEventBytes) { if (!this.dropping) this.errors++; this.dropping = true; this.data = []; return; }
    if (this.dropping) return;
    const colon = line.indexOf(":"); const field = colon < 0 ? line : line.slice(0,colon);
    let value = colon < 0 ? "" : line.slice(colon+1); if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    if (field === "data") this.data.push(value);
    if (field === "id") this.id = safeId(value);
  }
  dispatch(at, delayed) {
    let data; try { data = JSON.parse(this.data.join("\n")); } catch { this.errors++; return; }
    const meta = { occurred_at: delayed ? null : at, received_at: at, timestamp_basis: delayed ? "receipt" : "cdp_monotonic", delayed,
      native_event_id: this.id, message_id: safeId(data.message_id ?? data.msg_id ?? data.content?.message_id),
      conversation_id: safeId(data.conversation_id), trajectory_session_id: safeId(data.trajectory_session_id), agent_id: safeId(data.agent_id) };
    const key = meta.message_id || "response";
    const eventKey = this.id ? `${this.event}:${this.id}:${hash(this.data.join("\n"))}` : null;
    if(eventKey && this.seenIds.has(eventKey))return;
    if(eventKey){this.seenIds.add(eventKey);if(this.seenIds.size>10000)this.seenIds.delete(this.seenIds.values().next().value);}
    let text = null, snapshot = false;
    if (this.event === "CHUNK_DELTA" && typeof data.text === "string") text = data.text;
    if (this.event === "STREAM_MSG_NOTIFY") { text = blockText(data.content?.content_block); snapshot = true; }
    if (this.event === "STREAM_CHUNK" && Array.isArray(data.patch_op)) {
      // Only the documented content block patch is supported. Unknown patches are not text.
      const texts = data.patch_op.filter(p => p.patch_object === 1).map(p => blockText(p.patch_value?.content_block)).filter(t => t != null);
      if (texts.length) { text = texts.join(""); snapshot = true; }
    }
    if (text != null && text.length) {
      const old = this.texts.get(key) || ""; const next = snapshot ? text : old + text;
      const retainedBytes=[...this.texts].reduce((sum,[message,value])=>sum+(message===key?0:Buffer.byteLength(value)),0);
      if(retainedBytes+Buffer.byteLength(next)>this.maxEventBytes || (!this.texts.has(key) && this.texts.size>=100)){this.errors++;return;}
      if (next !== old) {
        this.texts.set(key,next);
        this.onEvent({ ...meta, native_event_id: null, event_type: "stream.text", text_chars: Array.from(next).length, text_revision: snapshot && !next.startsWith(old) });
      }
    }
    if (this.event === "SSE_REPLY_END" && data.end_type === 3) this.onEvent({ ...meta, event_type: "reply.end", status: "ok" });
    // ACK/heartbeat/FULL_MSG_NOTIFY are deliberately not model output or task completion.
  }
}

function blockText(blocks) {
  if (!Array.isArray(blocks)) return null;
  const texts = blocks.map(b=>b?.content?.text_block?.text).filter(t=>typeof t === "string");
  return texts.length ? texts.join("") : null;
}

export function parseWsNotification(payload, { direction = "received", at = null } = {}) {
  let decoded;
  try { decoded = JSON.parse(payload); } catch {
    try { const raw = Buffer.from(payload,"base64").toString("utf8"); decoded = JSON.parse(raw.slice(raw.indexOf("{"),raw.lastIndexOf("}")+1)); } catch { return null; }
  }
  const ext = decoded?.cmd?.ext ?? decoded?.ext; if (!ext || typeof ext !== "object") return null;
  const rawType = code(ext.event_type ?? ext.type);
  let type = null;
  if (direction === "received" && (rawType === "tool.call" || (decoded.cmd?.cmd_type === 10028 && ext.tool_call_id))) type = "tool.call";
  if (direction === "received" && rawType === "tool.result") type = "tool.result";
  if (direction === "received" && rawType === "human.request") type = "human.request";
  if (rawType === "human.decision" && ["allow","deny","modified"].includes(ext.decision)) type = "human.decision";
  if (direction === "received" && rawType === "task.status" && ["running","waiting","completed","failed","cancelled"].includes(ext.task_status)) type = "task.status";
  if (!type) return null;
  const result = { event_type: type, conversation_id: safeId(ext.conversation_id), trajectory_session_id: safeId(ext.trajectory_session_id),
    agent_id: safeId(ext.agent_id), sandbox_id: safeId(ext.sandbox_id), message_id: safeId(ext.message_id),
    tool_call_id: safeId(ext.tool_call_id), tool_name: code(ext.tool_name), approval_id: safeId(ext.approval_id),
    ask_human_type: code(ext.ask_human_type), decision: ["allow","deny","modified"].includes(ext.decision)?ext.decision:null, task_status: ["running","waiting","completed","failed","cancelled"].includes(ext.task_status)?ext.task_status:null,
    status: ["ok","error","running","cancelled"].includes(ext.status) ? ext.status : "unknown", exit_code: Number.isInteger(ext.exit_code) ? ext.exit_code : null,
    occurred_at: at, received_at: at, timestamp_basis: at==null?"receipt":"cdp_monotonic" };
  if (type === "tool.call" && result.ask_human_type && !result.approval_id) result.approval_id = result.tool_call_id;
  // Stable server identity prevents repeated WS notifications from adding executions.
  result.native_event_id = safeId(ext.event_id) || hash(JSON.stringify([type,result.conversation_id,result.agent_id,result.message_id,result.tool_call_id,result.approval_id,result.status,result.exit_code,result.decision,result.task_status]));
  return result;
}

export class CaptureTracker {
  constructor({ emit, send, epoch = randomUUID(), targetId = "page", now = Date.now }) {
    this.emit = emit; this.send = send; this.epoch = epoch; this.targetId = targetId; this.now = now;
    this.requests = new Map(); this.sequence = 0; this.seen = new Set(); this.clock = null;
  }
  time(timestamp) { return this.clock && Number.isFinite(timestamp) ? Math.round(this.clock.wall + (timestamp-this.clock.mono)*1000) : null; }
  output(record, req = null) {
    const native = record.native_event_id;
    const identity = native ? `${record.event_type}:${record.conversation_id ?? req?.conversation_id}:${native}` : null;
    if (identity && this.seen.has(identity)) return;
    if (identity) { this.seen.add(identity); if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value); }
    const merged = { ...req?.meta, ...record, received_at:record.received_at ?? this.now() };
    for (const key of ["conversation_id","trajectory_session_id","agent_id","message_id"]) if (merged[key] == null && req?.meta?.[key]) merged[key] = req.meta[key];
    this.emit({ schema_version: EVENT_SCHEMA, collector_version: COLLECTOR_VERSION, agent_object: "doubao", installation_id: "default",
      event_id: `${this.epoch}:${this.targetId}:${++this.sequence}`, source_seq: this.sequence, capture_epoch: this.epoch,
      request_id: req?.id ?? null, ...merged });
  }
  async handle(method, p) {
    if (method === "Network.requestWillBeSent") {
      if (!isCompletionUrl(p.request?.url) || this.requests.has(p.requestId)) return;
      if (!Number.isFinite(p.wallTime) || !Number.isFinite(p.timestamp)) return;
      if(this.requests.size>=100){
        const [oldId,old]=this.requests.entries().next().value;
        this.output({event_type:"capture.gap",reason:"pending_request_limit",occurred_at:null,received_at:this.now(),timestamp_basis:"receipt"},old);
        old.parser.finish(null);old.pendingChunks=[];this.requests.delete(oldId);
      }
      this.clock = { wall: p.wallTime*1000, mono: p.timestamp };
      const meta = extractRequestMeta(p.request.postData); const at = this.time(p.timestamp);
      const req = { id: `${this.epoch}:${this.targetId}:${p.requestId}`, meta, conversation_id: meta.conversation_id, http_status: null, parser: null, pendingChunks:[], streaming:null };
      req.parser = new SseParser(e=>this.output(e,req)); this.requests.set(p.requestId,req);
      this.output({ event_type: "client.request", occurred_at: at, received_at: this.now(), timestamp_basis: "cdp_monotonic" },req);
    } else if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
      const event = parseWsNotification(p.response?.payloadData, { direction: method.endsWith("Sent") ? "sent" : "received", at: this.time(p.timestamp) });
      if (event) this.output(event);
    } else {
      const req = this.requests.get(p.requestId); if (!req) return;
      const at = this.time(p.timestamp);
      if (method === "Network.responseReceived") {
        req.http_status = Number.isInteger(p.response?.status) ? p.response.status : null;
        this.output({ event_type: "client.headers", http_status: req.http_status, occurred_at: at, received_at: this.now(), timestamp_basis: "cdp_monotonic" },req);
        if (/text\/event-stream/i.test(p.response?.mimeType || Object.entries(p.response?.headers || {}).find(([k])=>k.toLowerCase()==="content-type")?.[1] || "")) {
          // Streaming support is probed by the caller. Commands never pause/replay the request.
          req.streaming=(async()=>{try { const response = await this.send("Network.streamResourceContent", { requestId: p.requestId });
            if(this.requests.get(p.requestId)!==req)return;
            if (response.bufferedData) req.parser.push(Buffer.from(response.bufferedData,"base64"), this.now(), true);
          } catch { if(this.requests.get(p.requestId)===req)this.output({ event_type: "capture.gap", reason: "streaming_unsupported", occurred_at: null, received_at: this.now(), timestamp_basis: "receipt" },req); }
          finally { if(this.requests.get(p.requestId)===req)for(const chunk of req.pendingChunks)req.parser.push(chunk.bytes,chunk.at,chunk.delayed);req.pendingChunks=[];req.streaming=null; }})();
          await req.streaming;
        }
      } else if (method === "Network.dataReceived" && p.data) {
        const chunk={bytes:Buffer.from(p.data,"base64"),at:at??this.now(),delayed:at==null};
        if(req.streaming){if(req.pendingChunks.reduce((s,c)=>s+c.bytes.length,0)+chunk.bytes.length>1024*1024){req.parser.errors++;return;}req.pendingChunks.push(chunk);}else req.parser.push(chunk.bytes,chunk.at,chunk.delayed);
      }
      else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        if(req.streaming)await req.streaming;
        if(this.requests.get(p.requestId)!==req)return;
        req.parser.finish(at); this.output({ event_type: "client.end", occurred_at: at, received_at: this.now(), timestamp_basis: "cdp_monotonic",
          status: method.endsWith("Failed") ? (p.canceled ? "cancelled" : "error") : req.http_status == null ? "unknown" : req.http_status>=200 && req.http_status<400 ? "ok" : "error",
          http_status: req.http_status, reason: method.endsWith("Failed") ? p.canceled ? "cancelled" : "network_error" : null,
          parse_errors: req.parser.errors },req); this.requests.delete(p.requestId);
      }
    }
  }
  close() {
    for (const req of this.requests.values()) {
      this.output({ event_type: "capture.gap", reason: "disconnected", received_at: this.now(), occurred_at: null, timestamp_basis: "receipt" },req);
      req.parser.finish(null); req.pendingChunks=[];
    }
    this.requests.clear(); this.seen.clear();
  }
}
