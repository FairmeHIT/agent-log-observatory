import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, resolveAgentConfig, saveDbSettings } from "./lib/config.mjs";
import { redact, whitelistFilter } from "./lib/redactor.mjs";
import { beijingIso } from "./lib/time.mjs";
import { percentile } from "./lib/metrics.mjs";
import { runPowerShell, stripBom } from "./lib/powershell.mjs";
import { hasCollectorData } from "./lib/collector-reader.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import {
  getDB, upsertSession, upsertMetrics, insertResourceSnapshot,
  getDBResourceHistory, getDBStats, getKnownSessionIds, hasSessionMetrics, upsertSyncLog,
  cleanOldMetrics, getDBSyncLog, closeDB,
  getDBSessionItems, getDBSessionItem, getDBSessionMetrics,
  upsertEvents, getDBEvents, upsertUsage, getDBUsage, upsertTimeline, getDBTimeline,
  insertFileObservation, getFileObservations, getLastObservation,
} from "./lib/observatory-db.mjs";
import { WorkBuddyAdapter } from "./adapters/workbuddy-adapter.mjs";
import { MobileworkAdapter } from "./adapters/mobilework-adapter.mjs";
import { TeleAgentAdapter } from "./adapters/teleagent-adapter.mjs";
import { DoubaoAdapter } from "./adapters/doubao-adapter.mjs";
import { DshAdapter } from "./adapters/dsh-adapter.mjs";
import { CodexAdapter } from "./adapters/codex-adapter.mjs";
import { OpencodeAdapter } from "./adapters/opencode-adapter.mjs";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = config.runtimeDirectory;
const htmlPath = path.join(appDirectory, "index.html");
const adapters = {
  workbuddy: new WorkBuddyAdapter(),
  mobilework: new MobileworkAdapter(),
  teleagent: new TeleAgentAdapter(),
  doubao: new DoubaoAdapter(),
  dsh: new DshAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpencodeAdapter(),
};

let html = "";

async function ensureHtml() {
  if (!html) {
    try { html = await readFile(htmlPath, "utf8"); } catch { html = "<h1>Agent Log Observatory</h1><p>index.html not found</p>"; }
  }
  return html;
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(redact(data)));
}

function jsonFiltered(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(redact(whitelistFilter(data))));
}

const COMPARE_METRICS = [
  "turn_e2e_ms", "session_lifespan_ms", "llm_attempt_ttft_ms",
  "token_input", "token_output", "token_cache_read", "token_reasoning", "token_total",
  "credits",   "max_context", "context_window", "cache_hit_rate",
  "llm_call_count", "success_rate", "llm_retry_count",
  "tool_call_count", "human_confirm_count", "step_count", "compaction_count", "compaction_threshold",
  "event_count_agent_input", "event_count_llm_request", "event_count_llm_response",
  "event_count_tool_call", "event_count_tool_result",
  "failures_tool", "failures_model",
  "failures_dependency", "failures_agent",
];

function aggregateForCompare(sessionMetrics) {
  const result = {
    session_count: sessionMetrics.length,
    metrics: {},
  };
  for (const metricName of COMPARE_METRICS) {
    const values = [];
    let captured = 0, notCaptured = 0;
    for (const sm of sessionMetrics) {
      const m = sm.metrics[metricName];
      if (m && m.state === "captured" && m.value != null) {
        values.push(m.value);
        captured++;
      } else {
        notCaptured++;
      }
    }
    const sum = values.reduce((s, v) => s + v, 0);
    const avg = values.length > 0 ? sum / values.length : null;
    const p50 = percentile(values, 50);
    const p95 = percentile(values, 95);
    result.metrics[metricName] = {
      captured, not_captured: notCaptured,
      sum: values.length > 0 ? sum : null,
      avg: avg != null ? Math.round(avg * 1000) / 1000 : null,
      p50: p50.value, p95: p95.value,
      p50_comparable: p50.comparable, p95_comparable: p95.comparable,
      unit: sessionMetrics[0]?.metrics[metricName]?.unit || null,
    };
  }
  return result;
}

const AGENT_RESOURCE_DIRS = {
  workbuddy: [config.agents.workbuddy.dataDir],
  mobilework: [config.agents.mobilework.dataDir, config.agents.mobilework.dashboardDataDir],
  teleagent: [config.agents.teleagent.dataDir, config.agents.teleagent.configDir, config.agents.teleagent.cacheDir],
  doubao: [config.agents.doubao.userDataDir, config.agents.doubao.sessionsRoot, config.agents.doubao.rpaDevDir],
  dsh: [config.agents.dsh.dataDir, config.agents.dsh.electronDataDir],
  codex: [config.agents.codex.dataDir],
  opencode: [config.agents.opencode.dataDir, config.agents.opencode.configDir],
};

const AGENT_MATCH_DIRS = {
  workbuddy: [config.agents.workbuddy.installDir, config.agents.workbuddy.dataDir, config.agents.workbuddy.electronLogsDir].filter(Boolean),
  mobilework: [config.agents.mobilework.installDir, config.agents.mobilework.dataDir, config.agents.mobilework.dashboardDataDir].filter(Boolean),
  teleagent: [config.agents.teleagent.installDir, config.agents.teleagent.dataDir, config.agents.teleagent.configDir, config.agents.teleagent.cacheDir].filter(Boolean),
  doubao: [config.agents.doubao.installDir, config.agents.doubao.userDataDir, config.agents.doubao.sessionsRoot, config.agents.doubao.rpaDevDir, config.agents.doubao.chatsDir].filter(Boolean),
  dsh: [config.agents.dsh.installDir, config.agents.dsh.dataDir, config.agents.dsh.electronDataDir].filter(Boolean),
  codex: [config.agents.codex.installDir, config.agents.codex.dataDir].filter(Boolean),
  opencode: [config.agents.opencode.dataDir, config.agents.opencode.configDir, config.agents.opencode.appDir, config.agents.opencode.cliDir].filter(Boolean),
};

function matchAgentByPath(exePath) {
  if (!exePath) return null;
  const lower = exePath.toLowerCase();
  for (const [agent, dirs] of Object.entries(AGENT_MATCH_DIRS)) {
    for (const dir of dirs) {
      if (dir && lower.includes(dir.toLowerCase())) return agent;
    }
  }
  return null;
}

async function collectResources() {
  const result = {};
  for (const [agent] of Object.entries(AGENT_RESOURCE_DIRS)) {
    result[agent] = { process_count: 0, memory_mb: null, cpu_time_s: null, avg_cpu_pct: null, uptime_s: null, disk_mb: null, running: false, processes: [] };
  }
  try {
    // Get-Process (the .NET path) works under the sandbox token, whereas
    // Get-CimInstance Win32_Process (WMI) returns Access denied (0x80041003).
    // Output is redirected to a file instead of a captured pipe.
    // StartTime may throw for elevated processes — wrapped in try/catch.
    const ps = [
      "Get-Process -ErrorAction SilentlyContinue |",
      "ForEach-Object { $st=$null; try { $st=$_.StartTime } catch {}; [PSCustomObject]@{ Id=$_.Id; Name=$_.ProcessName; Path=$_.Path; Mem=$_.WorkingSet64; Cpu=$_.UserProcessorTime.TotalSeconds; ST=$st } } |",
      `ConvertTo-Json -Depth 2 | Out-File -LiteralPath $env:OBS_PS_OUT -Encoding utf8`,
    ].join(" ");
    const run = await runPowerShell(`$ErrorActionPreference='SilentlyContinue'; ${ps}`, { timeoutMs: 60000 });
    let procs = [];
    try { procs = JSON.parse(stripBom(run.stdout)); } catch { procs = []; }
    if (!Array.isArray(procs)) procs = procs ? [procs] : [];
    const now = Date.now();
    for (const p of procs) {
      const agent = matchAgentByPath(p.Path);
      if (!agent) continue;
      const r = result[agent];
      r.process_count++;
      r.memory_mb = (r.memory_mb || 0) + (Number(p.Mem) || 0) / (1024 * 1024);
      r.cpu_time_s = (r.cpu_time_s || 0) + (Number(p.Cpu) || 0);
      // Per-process avg CPU% = cpu_time / uptime * 100 (100% = one full core)
      // PowerShell serializes DateTime as /Date(epochMs)/ — extract with regex
      const stMatch = p.ST ? String(p.ST).match(/\/Date\((\d+)\)\//) : null;
      const stMs = stMatch ? Number(stMatch[1]) : (p.ST ? Date.parse(p.ST) : NaN);
      const upS = stMs ? (now - stMs) / 1000 : NaN;
      if (upS > 0) {
        const pct = (Number(p.Cpu) || 0) / upS * 100;
        r.avg_cpu_pct = (r.avg_cpu_pct || 0) + pct; // sum across processes
        // Track longest-running process for agent uptime
        if (!r.uptime_s || upS > r.uptime_s) r.uptime_s = upS;
      }
      r.processes.push({
        pid: p.Id,
        name: p.Name,
        memory_mb: Math.round((Number(p.Mem) || 0) / (1024 * 1024) * 10) / 10,
        cpu_time_s: Math.round((Number(p.Cpu) || 0) * 100) / 100,
        avg_cpu_pct: upS > 0 ? Math.round((Number(p.Cpu) || 0) / upS * 100 * 100) / 100 : null,
        exe: p.Path,
      });
    }
    for (const r of Object.values(result)) {
      if (r.memory_mb != null) r.memory_mb = Math.round(r.memory_mb * 10) / 10;
      if (r.cpu_time_s != null) r.cpu_time_s = Math.round(r.cpu_time_s * 100) / 100;
      if (r.avg_cpu_pct != null) r.avg_cpu_pct = Math.round(r.avg_cpu_pct * 100) / 100;
      if (r.uptime_s != null) r.uptime_s = Math.round(r.uptime_s);
      r.running = r.process_count > 0;
    }
    if (!procs.length && run.stderr.trim()) result._process_error = run.stderr.trim().slice(0, 300);
  } catch (e) {
    result._process_error = e.message;
  }
  for (const [agent, dirs] of Object.entries(AGENT_RESOURCE_DIRS)) {
    let totalBytes = 0;
    let measured = false;
    for (const dir of dirs) {
      if (!dir) continue;
      try {
        const ps = `Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum | Select-Object -ExpandProperty Sum | Out-File -LiteralPath $env:OBS_PS_OUT -Encoding utf8`;
        const run = await runPowerShell(`$ErrorActionPreference='SilentlyContinue'; ${ps}`, { timeoutMs: 120000 });
        const n = Number(stripBom(run.stdout).trim());
        if (!Number.isNaN(n)) { totalBytes += n; measured = true; }
      } catch {}
    }
    result[agent].disk_mb = measured ? Math.round(totalBytes / (1024 * 1024) * 10) / 10 : null;
  }
  return result;
}

// ============================================================================
// Resource history — background sampling + /api/resources/history
// 60s 间隔后台采样，写入 runtime/resource-snapshots.jsonl，保留 7 天
// ============================================================================

const SNAPSHOT_INTERVAL_MS = 60_000;
const SNAPSHOT_FILE = path.join(runtimeDirectory, "resource-snapshots.jsonl");
const SNAPSHOT_RETENTION_POINTS = 7 * 24 * 60; // 7 days × 60 per hour

async function sampleResources() {
  try {
    const data = await collectResources();
    const ts = Date.now();
    for (const [name, a] of Object.entries(data)) {
      if (name.startsWith("_")) continue;
      const snap = {
        mem: a.memory_mb, cpu: a.cpu_time_s, disk: a.disk_mb,
        proc: a.process_count, avg_cpu: a.avg_cpu_pct,
      };
      // Write to DB (primary) and JSONL (fallback during migration)
      try { insertResourceSnapshot(ts, name, snap); } catch {}
      await fs.appendFile(SNAPSHOT_FILE, JSON.stringify({ ts, [name]: snap }) + "\n", "utf8").catch(() => {});
    }
  } catch {}
}

async function readResourceHistory(sinceMs = 0) {
  try {
    const raw = await fs.readFile(SNAPSHOT_FILE, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const points = [];
    for (const line of lines) {
      try {
        const p = JSON.parse(line);
        if (p.ts >= sinceMs) points.push(p);
      } catch {}
    }
    // Trim to retention limit (rewrite file with retained data only)
    if (points.length > SNAPSHOT_RETENTION_POINTS) {
      const trimmed = points.slice(-SNAPSHOT_RETENTION_POINTS);
      await fs.writeFile(SNAPSHOT_FILE, trimmed.map(p => JSON.stringify(p)).join("\n") + "\n", "utf8");
      return trimmed;
    }
    return points;
  } catch {
    return [];
  }
}

// Start background sampling after 5s, then every 60s
setTimeout(sampleResources, 5000);
setInterval(sampleResources, SNAPSHOT_INTERVAL_MS);

// ---- Doubao trajectory file watcher (Plan A: file observation for turn_e2e/lifespan) ----
const DOUBAO_WATCH_INTERVAL_MS = 15000;
let watchedFiles = null; // filePath → last known line count (lazy-loaded from DB)

async function ensureWatchedFilesLoaded() {
  if (watchedFiles !== null) return;
  watchedFiles = new Map();
  try {
    const d = getDB();
    const rows = d.prepare("SELECT file_path, line_count FROM file_observations GROUP BY file_path HAVING observed_at = MAX(observed_at)").all();
    for (const r of rows) watchedFiles.set(r.file_path, r.line_count);
  } catch {}
}

async function watchDoubaoTrajectories() {
  try {
    await ensureWatchedFilesLoaded();
    const cfg = resolveAgentConfig("doubao");
    const sessions = await fs.readdir(cfg.sessionsRoot);
    const now = Date.now();
    for (const sessionId of sessions) {
      const agentsDir = path.join(cfg.sessionsRoot, sessionId, "agents");
      let agentIds = [];
      try { agentIds = await fs.readdir(agentsDir); } catch { continue; }
      for (const agentId of agentIds) {
        const trajPath = path.join(agentsDir, agentId, "system", "trajectory.jsonl");
        try { await fs.access(trajPath); } catch { continue; }
        // Count lines
        let lineCount = 0;
        try {
          const content = await fs.readFile(trajPath, "utf8");
          lineCount = content.split("\n").filter((l) => l.trim()).length;
        } catch { continue; }
        const key = trajPath;
        const lastCount = watchedFiles.get(key);
        if (lastCount === lineCount) continue; // no change
        // New or changed file → record observation
        watchedFiles.set(key, lineCount);
        insertFileObservation("doubao", sessionId, trajPath, lineCount, now);
      }
    }
  } catch {}
}
setTimeout(watchDoubaoTrajectories, 8000);
setInterval(watchDoubaoTrajectories, DOUBAO_WATCH_INTERVAL_MS);

// Migrate resource snapshots to DB (if JSONL exists, import then archive)
async function migrateResourceJsonlToDB() {
  try {
    const raw = await fs.readFile(SNAPSHOT_FILE, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return;
    for (const line of lines) {
      try {
        const snap = JSON.parse(line);
        const ts = snap.ts;
        for (const [agent, data] of Object.entries(snap)) {
          if (agent === "ts" || typeof data !== "object") continue;
          insertResourceSnapshot(ts, agent, data);
        }
      } catch {}
    }
    // Archive the JSONL (rename to .bak) so we don't re-import
    await fs.rename(SNAPSHOT_FILE, SNAPSHOT_FILE + ".bak");
    console.log(`[observatory-db] Migrated ${lines.length} resource snapshots from JSONL to DB`);
  } catch (e) {
    if (e.code !== "ENOENT") console.log(`[observatory-db] Migration skip: ${e.message}`);
  }
}

// ============================================================================
// Session/metrics sync — 后台增量同步（5 分钟间隔）
// 从各 Agent 原始数据源 extract → 清洗/标准化 → 写入 observatory.db
// 用 session_id 去重，只处理新增 session（delta）
// ============================================================================

const SYNC_SESSION_LIMIT = 500;
let syncRunning = false;
let syncTimer = null;

async function syncAgentData(agentName, adapter) {
  let newCount = 0;
  let totalCount = 0;
  try {
    const sessions = await adapter.extractSessions({ limit: SYNC_SESSION_LIMIT });
    totalCount = sessions.items ? sessions.items.length : (Array.isArray(sessions) ? sessions.length : 0);
    const knownIds = getKnownSessionIds(agentName);
    for (const s of (sessions.items || sessions || [])) {
      const sid = s.session_id || s.id;
      if (!sid) continue;
      // Write session metadata
      upsertSession(agentName, s);
      // Extract metrics for new sessions OR known sessions missing metrics
      const needsMetrics = !knownIds.has(sid) || !hasSessionMetrics(agentName, sid);
      if (needsMetrics) {
        try {
          const [metrics, failures, events, usage, timeline] = await Promise.all([
            adapter.extractMetrics(sid),
            adapter.extractFailures ? adapter.extractFailures(sid) : Promise.resolve({ summary: {} }),
            adapter.extractEvents ? adapter.extractEvents(sid) : Promise.resolve([]),
            adapter.extractUsage ? adapter.extractUsage(sid) : Promise.resolve([]),
            adapter.extractTimeline ? adapter.extractTimeline(sid) : Promise.resolve([]),
          ]);
          // Merge failures into metrics
          const allMetrics = [...metrics];
          const fsum = (failures && failures.summary) || {};
          const failuresNc = failures && failures.source_available === false;
          for (const cat of ["gateway", "tool", "model", "dependency", "agent"]) {
            allMetrics.push({
              metric: "failures_" + cat,
              value: failuresNc ? null : (fsum[cat] || 0),
              state: failuresNc ? "not-captured" : "captured",
              missing_reason: failuresNc ? "source_unavailable" : null,
            });
          }
          upsertMetrics(agentName, sid, allMetrics);
          try { if (events?.length) upsertEvents(agentName, sid, events); } catch {}
          try { if (usage?.length) upsertUsage(agentName, sid, usage); } catch {}
          try { if (timeline?.length) upsertTimeline(agentName, sid, timeline); } catch {}
          newCount++;
        } catch {}
      }
    }
    upsertSyncLog(agentName, totalCount, newCount, null);
    return { total: totalCount, new: newCount };
  } catch (e) {
    upsertSyncLog(agentName, totalCount || 0, newCount, e.message);
    return { total: totalCount, new: newCount, error: e.message };
  }
}

async function syncAllAgents() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    getDB(); // ensure initialized
    for (const [name, adapter] of Object.entries(adapters)) {
      await syncAgentData(name, adapter);
    }
    // Clean old data
    cleanOldMetrics();
  } finally {
    syncRunning = false;
  }
}

// Start sync: 10s after boot (full sync), then recursive with dynamic interval
function scheduleNextSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    await syncAllAgents();
    scheduleNextSync();
  }, config.db.syncIntervalMs);
}
setTimeout(() => { migrateResourceJsonlToDB().then(() => syncAllAgents()).then(scheduleNextSync); }, 10000);

// ============================================================================
// collectEnvCheck — Observatory 系统健康检查
// 两层：系统级（Node/SQLite/配置/适配器/磁盘）+ Agent 级（数据源/session/进程/
// 采集基础设施/数据时效性/已知限制）。
// 返回结构：{ system: {overall, checks:[...]}, agents: {name: {overall, checks}} }
// status: "ok" | "warning" | "error" | "info"
// ============================================================================

const AGENT_PROCESS_NAMES = {
  workbuddy: ["WorkBuddy"],
  mobilework: ["MobileWork"],
  teleagent: ["TeleAgent", "super-agent-server"],
  doubao: ["Doubao"],
  dsh: ["dsh", "DSH"],
  codex: ["Codex"],
  opencode: ["OpenCode", "opencode-cli"],
};

async function collectEnvCheck() {
  const system = await checkSystemEnv();
  const agents = {};
  for (const [name, adapter] of Object.entries(adapters)) {
    const cfg = resolveAgentConfig(name);
    const checks = [];
    checks.push(...await checkDataSource(name, adapter));
    checks.push(...await checkSessions(name, adapter));
    checks.push(...await checkProcess(name));
    checks.push(...await checkDataFreshness(name, adapter));
    if (name === "opencode") checks.push(...await checkOpencodeEnv(cfg));
    else if (name === "mobilework") checks.push(...await checkMobileworkEnv(cfg));
    else if (name === "workbuddy") checks.push(...await checkWorkbuddyEnv(cfg));
    else if (name === "teleagent") checks.push(...await checkTeleagentEnv(cfg));
    else if (name === "doubao") checks.push(...await checkDoubaoEnv(cfg));
    else if (name === "dsh") checks.push(...await checkDshEnv(cfg));
    else if (name === "codex") checks.push(...await checkCodexEnv(cfg));
    const hasError = checks.some((c) => c.status === "error");
    const hasWarning = checks.some((c) => c.status === "warning");
    agents[name] = { overall: hasError ? "error" : hasWarning ? "warning" : "ok", checks };
  }
  return { system, agents };
}

// ---- 系统级检查 ----

async function checkSystemEnv() {
  const checks = [];
  // Node.js 版本
  const nodeVer = process.version;
  const major = Number(nodeVer.slice(1).split(".")[0]);
  checks.push({
    name: "node_version",
    status: major >= 18 ? "ok" : "error",
    detail: `Node.js ${nodeVer}` + (major >= 18 ? "" : "（需 >= 18）"),
    fix: major >= 18 ? null : "升级 Node.js 到 >= 18",
  });
  // SQLite 查询工具
  try {
    const sqlitePath = config.sqliteExecutable;
    const stat = await fs.stat(sqlitePath);
    checks.push({ name: "sqlite_tool", status: "ok", detail: `runtime/sqlite3.exe (${(stat.size / 1024 / 1024).toFixed(1)}MB)` });
  } catch {
    checks.push({ name: "sqlite_tool", status: "error", detail: "runtime/sqlite3.exe 不存在", fix: "SQLite 查询工具缺失，适配器无法读取 SQLite 数据源" });
  }
  // 配置文件
  try {
    const cfgPath = path.join(appDirectory, "agent-log-observatory.config.json");
    const raw = await fs.readFile(cfgPath, "utf8");
    if (raw.includes("<username>")) {
      checks.push({ name: "config", status: "error", detail: "配置文件含 <username> 占位符未替换", fix: "编辑 agent-log-observatory.config.json 替换 <username>" });
    } else {
      checks.push({ name: "config", status: "ok", detail: "agent-log-observatory.config.json 已解析" });
    }
  } catch {
    checks.push({ name: "config", status: "info", detail: "无配置文件，使用默认值" });
  }
  // 适配器加载
  const adapterCount = Object.keys(adapters).length;
  checks.push({ name: "adapters", status: adapterCount === 7 ? "ok" : "warning", detail: `${adapterCount}/7 适配器已加载` });
  // 数据源可达健康度
  let available = 0;
  for (const [, adapter] of Object.entries(adapters)) {
    try { if ((await adapter.discover()).available) available++; } catch {}
  }
  checks.push({
    name: "data_sources",
    status: available === adapterCount ? "ok" : available === 0 ? "error" : "warning",
    detail: `${available}/${adapterCount} Agent 数据源可达`,
    fix: available < adapterCount ? "查看下方各 Agent 的 data_source 检查项" : null,
  });
  // 总磁盘占用
  try {
    let totalBytes = 0;
    for (const [name] of Object.entries(adapters)) {
      const cfg = resolveAgentConfig(name);
      for (const dir of [cfg.dataDir, cfg.configDir, cfg.appDir, cfg.cliDir].filter(Boolean)) {
        try {
          const ps = `Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum | Select-Object -ExpandProperty Sum | Out-File -LiteralPath $env:OBS_PS_OUT -Encoding utf8`;
          const run = await runPowerShell(`$ErrorActionPreference='SilentlyContinue'; ${ps}`, { timeoutMs: 15000 });
          totalBytes += Number(stripBom(run.stdout).trim()) || 0;
        } catch {}
      }
    }
    checks.push({ name: "disk_usage", status: "info", detail: `Agent 数据总占用 ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB` });
  } catch {}
  const hasError = checks.some((c) => c.status === "error");
  const hasWarning = checks.some((c) => c.status === "warning");
  return { overall: hasError ? "error" : hasWarning ? "warning" : "ok", checks };
}

// ---- Agent 级通用检查 ----

async function checkDataSource(name, adapter) {
  try {
    const r = await adapter.discover();
    const sources = r.sources || {};
    const sourceNames = Object.entries(sources).filter(([, v]) => v).map(([k]) => k);
    if (r.available) {
      return [{ name: "data_source", status: "ok", detail: sourceNames.length ? `可达 (${sourceNames.join(", ")})` : "可达" }];
    }
    return [{ name: "data_source", status: "error", detail: "数据源不可达", fix: `检查 ${name} 安装路径和数据目录` }];
  } catch (e) {
    return [{ name: "data_source", status: "error", detail: `discover 失败: ${e.message}` }];
  }
}

async function checkSessions(name, adapter) {
  try {
    const sessions = await adapter.extractSessions({ limit: 1 });
    const count = sessions.items ? sessions.items.length : (Array.isArray(sessions) ? sessions.length : 0);
    if (count > 0) return [{ name: "sessions", status: "ok", detail: "有 session 数据" }];
    return [{ name: "sessions", status: "info", detail: "无 session 数据", fix: `在 ${name} 中发起一次对话` }];
  } catch (e) {
    return [{ name: "sessions", status: "warning", detail: `查询失败: ${e.message}` }];
  }
}

async function checkProcess(name) {
  const names = AGENT_PROCESS_NAMES[name];
  if (!names) return [];
  try {
    const namePattern = names.join("','");
    const run = await runPowerShell(
      `$ErrorActionPreference='SilentlyContinue'; (Get-Process -Name '${namePattern}' -ErrorAction SilentlyContinue).Count | Out-File -LiteralPath $env:OBS_PS_OUT -Encoding utf8`,
      { timeoutMs: 10000 }
    );
    const count = Number(stripBom(run.stdout).trim());
    if (count > 0) return [{ name: "process", status: "ok", detail: `运行中 (${count} 个进程)` }];
    return [{ name: "process", status: "info", detail: "未运行", fix: name === "mobilework" ? "运行 启动Mobilework.cmd" : `启动 ${name} 客户端` }];
  } catch {
    return [];
  }
}

async function checkDataFreshness(name, adapter) {
  try {
    const sessions = await adapter.extractSessions({ limit: 1 });
    const items = sessions.items || (Array.isArray(sessions) ? sessions : []);
    if (!items.length) return [];
    const s = items[0];
    const ts = s.startedAt || s.started_at || s.createdAt || s.created_at || s.timestamp;
    if (!ts) return [{ name: "data_freshness", status: "info", detail: "无法解析时间戳" }];
    const ms = typeof ts === "number" ? ts : Date.parse(ts);
    if (!ms || isNaN(ms)) return [{ name: "data_freshness", status: "info", detail: "无法解析时间戳" }];
    const daysAgo = (Date.now() - ms) / 86400000;
    if (daysAgo < 1) return [{ name: "data_freshness", status: "ok", detail: `最新数据 ${Math.round(daysAgo * 24)} 小时前` }];
    if (daysAgo < 7) return [{ name: "data_freshness", status: "ok", detail: `最新数据 ${Math.round(daysAgo)} 天前` }];
    return [{ name: "data_freshness", status: "info", detail: `最新数据 ${Math.round(daysAgo)} 天前` }];
  } catch {
    return [];
  }
}

// ---- Agent 特定检查 ----

async function checkOpencodeEnv(cfg) {
  const checks = [];
  // collector plugin
  try {
    const jsoncPath = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");
    const content = await fs.readFile(jsoncPath, "utf8");
    if (content.includes("opencode-collector-plugin")) {
      checks.push({ name: "collector_plugin", status: "ok", detail: "plugin 已安装 (opencode.jsonc)" });
    } else {
      checks.push({ name: "collector_plugin", status: "info", detail: "plugin 未安装", fix: "运行 node collectors/install-opencode.mjs 安装采集器插件" });
    }
  } catch {
    checks.push({ name: "collector_plugin", status: "info", detail: "无法读取 opencode.jsonc" });
  }
  // collector 数据
  try {
    if (await hasCollectorData("opencode")) {
      checks.push({ name: "collector_data", status: "ok", detail: "有采集数据 (attempts-*.jsonl)" });
    } else {
      checks.push({ name: "collector_data", status: "info", detail: "无采集数据", fix: "在 opencode 中发起对话即可自动采集" });
    }
  } catch {}
  // session_v2 表
  try {
    const tbl = await adapters.opencode._sessionTable();
    checks.push({ name: "session_table", status: "ok", detail: tbl === "session_v2" ? "session_v2 表（V2）" : "session 表（V1）" });
  } catch {}
  return checks;
}

async function checkMobileworkEnv(cfg) {
  const checks = [];
  // LLM 代理端口
  try {
    const { createConnection } = await import("node:net");
    const ok = await new Promise((resolve) => {
      const sock = createConnection({ host: "127.0.0.1", port: 8890 }, () => { sock.destroy(); resolve(true); });
      sock.on("error", () => resolve(false));
      setTimeout(() => { sock.destroy(); resolve(false); }, 2000);
    });
    if (ok) {
      checks.push({ name: "llm_proxy", status: "ok", detail: "MITM 代理运行中 (port 8890)" });
    } else {
      checks.push({ name: "llm_proxy", status: "info", detail: "代理未运行 (port 8890)", fix: "运行 启动Mobilework.cmd" });
    }
  } catch {}
  // collector 数据
  try {
    if (await hasCollectorData("mobilework")) {
      checks.push({ name: "collector_data", status: "ok", detail: "有采集数据 (attempts-*.jsonl)" });
    } else {
      checks.push({ name: "collector_data", status: "info", detail: "无采集数据", fix: "代理运行后发起对话即可采集" });
    }
  } catch {}
  // stream-timings 碰撞（已知数据质量）
  try {
    const streamDir = path.join(cfg.dashboardDataDir || cfg.dataDir, "stream-timings");
    await fs.access(streamDir);
    checks.push({ name: "stream_timings", status: "info", detail: "stream-timings.json 存在（碰撞时回退 timestamp_collision）" });
  } catch {}
  return checks;
}

async function checkWorkbuddyEnv(cfg) {
  const checks = [];
  try {
    const traceDir = path.join(cfg.dataDir, "traces");
    const entries = await fs.readdir(traceDir);
    const pidDirs = entries.filter((e) => !e.startsWith("."));
    if (pidDirs.length > 0) {
      checks.push({ name: "trace_dir", status: "ok", detail: `trace 目录有数据 (${pidDirs.length} 个 pid 子目录)` });
    } else {
      checks.push({ name: "trace_dir", status: "info", detail: "trace 目录为空", fix: "在 WorkBuddy 中发起对话后会自动生成 trace" });
    }
  } catch {
    checks.push({ name: "trace_dir", status: "info", detail: "trace 目录不存在", fix: `检查 ${cfg.dataDir}/traces/` });
  }
  return checks;
}

async function checkTeleagentEnv(cfg) {
  const checks = [];
  // 日志目录
  try {
    const logDir = path.join(cfg.dataDir, "log");
    await fs.access(logDir);
    checks.push({ name: "log_dir", status: "ok", detail: "日志目录存在 (dataDir/log)" });
  } catch {
    try {
      const usersDir = path.join(cfg.dataDir, "users");
      const userDirs = await fs.readdir(usersDir);
      let foundLogs = false;
      for (const ud of userDirs) {
        try { await fs.access(path.join(usersDir, ud, "log")); foundLogs = true; break; } catch {}
      }
      if (foundLogs) {
        checks.push({ name: "log_dir", status: "warning", detail: "日志在 users/<id>/log/，adapter 查的是 dataDir/log/", fix: "adapter _extractCallsFromLogs 路径需修复为 cfg.dataDir/users/*/log/" });
      } else {
        checks.push({ name: "log_dir", status: "info", detail: "日志目录不存在", fix: "检查 TeleAgent 是否运行并生成日志" });
      }
    } catch {
      checks.push({ name: "log_dir", status: "info", detail: "无法定位日志目录" });
    }
  }
  // TTFT 设计限制
  checks.push({ name: "ttft_limitation", status: "info", detail: "TTFT 永久 not-captured（[cost] 是生成结束时间，非首 token）", fix: "设计限制（SPEC TIME-04），turn_e2e_ms 可替代看完整生成时间" });
  return checks;
}

async function checkDoubaoEnv(cfg) {
  const checks = [];
  try {
    const trajDir = cfg.sessionsRoot || cfg.dataDir;
    const entries = await fs.readdir(trajDir);
    const trajFiles = entries.filter((e) => e.endsWith(".jsonl"));
    if (trajFiles.length > 0) {
      checks.push({ name: "trajectory", status: "ok", detail: `trajectory 文件 ${trajFiles.length} 个` });
    } else {
      checks.push({ name: "trajectory", status: "info", detail: "无 trajectory 文件", fix: "在 Doubao 中发起对话" });
    }
  } catch {
    checks.push({ name: "trajectory", status: "info", detail: "trajectory 目录不可达" });
  }
  checks.push({ name: "token_limitation", status: "info", detail: "trajectory.jsonl 无 token 字段（Token 指标 not-captured）" });
  return checks;
}

async function checkDshEnv(cfg) {
  const checks = [];
  try {
    const sessions = await fs.readdir(cfg.dataDir);
    const sessionFiles = sessions.filter((e) => e.includes("session") && (e.endsWith(".zstd") || e.endsWith(".jsonl")));
    if (sessionFiles.length > 0) {
      checks.push({ name: "session_files", status: "ok", detail: `session 文件 ${sessionFiles.length} 个` });
    } else {
      checks.push({ name: "session_files", status: "info", detail: "无 session 文件", fix: "在 DSH 中发起对话" });
    }
  } catch {
    checks.push({ name: "session_files", status: "info", detail: "数据目录不可达" });
  }
  checks.push({ name: "failure_attribution", status: "info", detail: "无 error/failure 事件类型（失败归因全 not-captured）" });
  return checks;
}

async function checkCodexEnv(cfg) {
  const checks = [];
  try {
    const dbPath = cfg.dataDir;
    const stat = await fs.stat(dbPath);
    checks.push({ name: "database", status: "ok", detail: `Codex DB ${(stat.size / 1024 / 1024).toFixed(1)}MB` });
  } catch {
    checks.push({ name: "database", status: "info", detail: "DB 文件不可达" });
  }
  try {
    const tomlPath = path.join(os.homedir(), ".codex", "config.toml");
    await fs.access(tomlPath);
    checks.push({ name: "config_toml", status: "ok", detail: "config.toml 存在" });
  } catch {
    checks.push({ name: "config_toml", status: "info", detail: "config.toml 不存在" });
  }
  checks.push({ name: "token_detail", status: "info", detail: "logs 仅有 total_usage_tokens（累计），无 input/output/cache 分项" });
  return checks;
}

function parseTimeFilter(url) {
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const result = {};
  if (since) {
    const ms = parseDateParam(since);
    if (ms) result.since = ms;
  }
  if (until) {
    const ms = parseDateParam(until);
    if (ms) result.until = ms;
  }
  return result;
}

function parseDateParam(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00+08:00").getTime();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).getTime();
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === "/api/health") {
    const results = {};
    for (const [name, adapter] of Object.entries(adapters)) {
      try { results[name] = await adapter.discover(); } catch (e) { results[name] = { available: false, error: e.message }; }
    }
    return json(res, { status: "ok", timestamp: beijingIso(), agents: results, version: config.appVersion });
  }

  if (p === "/api/agents") {
    const results = {};
    for (const [name, adapter] of Object.entries(adapters)) {
      try { results[name] = await adapter.discover(); } catch (e) { results[name] = { available: false, error: e.message }; }
    }
    return json(res, results);
  }

  const capsMatch = p.match(/^\/api\/agents\/(\w+)\/(\w+)\/capabilities$/);
  if (capsMatch) {
    const [, agent, installation] = capsMatch;
    const adapter = adapters[agent];
    if (!adapter) return json(res, { error: "unknown_agent" }, 404);
    return json(res, await adapter.capabilities({ installation }));
  }

  const sessionsMatch = p.match(/^\/api\/sessions\/(\w+)$/);
  if (p === "/api/sessions" || sessionsMatch) {
    const agent = sessionsMatch ? sessionsMatch[1] : (url.searchParams.get("agent") || "");
    const timeFilter = parseTimeFilter(url);
    // DB fast path: if sessions have item_json, query from DB
    const dbStats = getDBStats();
    const useDB = dbStats.session_count > 0;
    if (useDB) {
      const items = getDBSessionItems({
        agent: agent && adapters[agent] ? agent : null,
        limit: agent ? 100 : 50,
        since: timeFilter.since || 0,
        until: timeFilter.until || Date.now(),
      });
      if (items.length > 0) {
        if (agent && adapters[agent]) return jsonFiltered(res, { items, source: "db" });
        return jsonFiltered(res, { items: items.map((s) => ({ ...s, agent_object: s.agent_object || s.agent_name || s.agent })), asOf: Date.now(), source: "db" });
      }
    }
    // Fallback: live extraction
    if (agent && adapters[agent]) {
      const result = await adapters[agent].extractSessions({ limit: 100, ...timeFilter });
      return jsonFiltered(res, { ...result, source: "live" });
    }
    const allSessions = [];
    for (const [name, adapter] of Object.entries(adapters)) {
      try {
        const result = await adapter.extractSessions({ limit: 50, ...timeFilter });
        allSessions.push(...result.items.map((s) => ({ ...s, agent_object: name })));
      } catch {}
    }
    return jsonFiltered(res, { items: allSessions, asOf: Date.now(), source: "live" });
  }

  const sessionDetailMatch = p.match(/^\/api\/sessions\/(\w+)\/default\/([^/]+)$/);
  if (sessionDetailMatch) {
    const [, agent, sessionId] = sessionDetailMatch;
    const adapter = adapters[agent];
    if (!adapter) return jsonFiltered(res, { error: "unknown_agent" }, 404);
    // DB fast path
    try {
      const fromDB = getDBSessionItem(agent, sessionId);
      if (fromDB) return jsonFiltered(res, { ...fromDB, source: "db" });
    } catch {}
    const sessions = await adapter.extractSessions({ limit: 500 });
    const found = sessions.items.find((s) => s.session_id === sessionId);
    if (!found) return jsonFiltered(res, { error: "not_found" }, 404);
    return jsonFiltered(res, { ...found, source: "live" });
  }

  const eventsMatch = p.match(/^\/api\/sessions\/(\w+)\/default\/([^/]+)\/events$/);
  if (eventsMatch) {
    const [, agent, sessionId] = eventsMatch;
    const adapter = adapters[agent];
    if (!adapter) return jsonFiltered(res, { error: "unknown_agent" }, 404);
    // DB fast path
    try {
      const fromDB = getDBEvents(agent, sessionId);
      if (fromDB) return jsonFiltered(res, { items: fromDB, source: "db" });
    } catch {}
    // On-demand backfill: read live, write to DB, return
    const items = await adapter.extractEvents(sessionId);
    try { if (items?.length) upsertEvents(agent, sessionId, items); } catch {}
    return jsonFiltered(res, { items: items || [], source: "live" });
  }

  const usageMatch = p.match(/^\/api\/sessions\/(\w+)\/default\/([^/]+)\/usage$/);
  if (usageMatch) {
    const [, agent, sessionId] = usageMatch;
    const adapter = adapters[agent];
    if (!adapter) return jsonFiltered(res, { error: "unknown_agent" }, 404);
    if (!adapter.extractUsage) return jsonFiltered(res, { items: [] });
    // DB fast path
    try {
      const fromDB = getDBUsage(agent, sessionId);
      if (fromDB) return jsonFiltered(res, { items: fromDB, source: "db" });
    } catch {}
    const items = await adapter.extractUsage(sessionId);
    try { if (items?.length) upsertUsage(agent, sessionId, items); } catch {}
    return jsonFiltered(res, { items: items || [], source: "live" });
  }

  const callsMatch = p.match(/^\/api\/sessions\/(\w+)\/default\/([^/]+)\/calls$/);
  if (callsMatch) {
    const [, agent, sessionId] = callsMatch;
    const adapter = adapters[agent];
    if (!adapter) return json(res, { error: "unknown_agent" }, 404);
    if (!adapter.extractCalls) return json(res, { llm_calls: [], tool_calls: [] });
    return json(res, await adapter.extractCalls(sessionId));
  }

  const metricsMatch = p.match(/^\/api\/sessions\/(\w+)\/default\/([^/]+)\/metrics$/);
  if (metricsMatch) {
    const [, agent, sessionId] = metricsMatch;
    const adapter = adapters[agent];
    if (!adapter) return json(res, { error: "unknown_agent" }, 404);
    // DB fast path
    try {
      const fromDB = getDBSessionMetrics(agent, sessionId);
      if (fromDB && fromDB.length > 0) return json(res, { items: fromDB, source: "db" });
    } catch {}
    if (!adapter.extractMetrics) return json(res, { items: [] });
    return json(res, { items: await adapter.extractMetrics(sessionId), source: "live" });
  }

  const failuresMatch = p.match(/^\/api\/sessions\/(\w+)\/default\/([^/]+)\/failures$/);
  if (failuresMatch) {
    const [, agent, sessionId] = failuresMatch;
    const adapter = adapters[agent];
    if (!adapter) return json(res, { error: "unknown_agent" }, 404);
    if (!adapter.extractFailures) return json(res, { diagnostics: [], summary: { gateway:0,tool:0,model:0,dependency:0,agent:0 } });
    return json(res, await adapter.extractFailures(sessionId));
  }

  if (p === "/api/metrics/compare") {
    const agentFilter = url.searchParams.get("agents");
    const agentNames = agentFilter ? agentFilter.split(",").filter((n) => adapters[n]) : Object.keys(adapters);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
    const timeFilter = parseTimeFilter(url);
    const result = {};
    const since = timeFilter.since || 0;
    const until = timeFilter.until || Date.now();

    // Try DB first — if it has sessions, query from there (fast path)
    const dbStats = getDBStats();
    const useDB = dbStats.session_count > 0;

    for (const name of agentNames) {
      const adapter = adapters[name];
      try {
        if (useDB) {
          const d = getDB();
          const dbSessions = d.prepare(
            "SELECT session_id FROM sessions WHERE agent = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC LIMIT ?"
          ).all(name, since, until, limit);
          if (dbSessions.length > 0) {
            const sessionMetrics = [];
            for (const s of dbSessions) {
              const rows = d.prepare(
                "SELECT metric_name as metric, value, state, missing_reason, unit FROM session_metrics WHERE agent = ? AND session_id = ?"
              ).all(name, s.session_id);
              const map = {};
              for (const r of rows) {
                if (!map[r.metric] || r.state === "captured") map[r.metric] = r;
              }
              sessionMetrics.push({ session_id: s.session_id, metrics: map });
            }
            result[name] = aggregateForCompare(sessionMetrics);
            continue;
          }
        }
        // Fallback: live extraction
        const sessions = await adapter.extractSessions({ limit, ...timeFilter });
        const sessionMetrics = [];
        for (const s of sessions.items.slice(0, limit)) {
          try {
            const [m, f] = await Promise.all([
              adapter.extractMetrics(s.session_id),
              adapter.extractFailures ? adapter.extractFailures(s.session_id) : Promise.resolve({ summary: {} }),
            ]);
            const map = {};
            for (const item of m) {
              if (!map[item.metric] || item.state === "captured") map[item.metric] = item;
            }
            const fsum = f.summary || {};
            const failuresNc = f.source_available === false;
            for (const cat of ["gateway", "tool", "model", "dependency", "agent"]) {
              map["failures_" + cat] = failuresNc
                ? { value: null, state: "not-captured", missing_reason: "source_unavailable" }
                : { value: fsum[cat] || 0, state: "captured" };
            }
            sessionMetrics.push({ session_id: s.session_id, metrics: map });
          } catch {}
        }
        result[name] = aggregateForCompare(sessionMetrics);
      } catch (e) {
        result[name] = { error: e.message, session_count: 0 };
      }
    }
    return json(res, { agents: result, generated_at: beijingIso(), source: useDB ? "db" : "live" });
  }

  if (p === "/api/metrics/aggregate") {
    const agentName = url.searchParams.get("agent");
    const metricName = url.searchParams.get("metric") || "turn_e2e_ms";
    const ps = (url.searchParams.get("percentile") || "50,95").split(",").map((n) => parseInt(n, 10));
    if (!agentName || !adapters[agentName]) {
      return json(res, { error: "invalid_agent" }, 400);
    }
    const adapter = adapters[agentName];
    const sessions = await adapter.extractSessions({ limit: 50 });
    const values = [];
    let captured = 0, notCaptured = 0;

    for (const s of sessions.items) {
      try {
        const metrics = await adapter.extractMetrics(s.session_id);
        const found = metrics.find((m) => m.metric === metricName);
        if (found && found.state === "captured" && found.value != null) {
          values.push(found.value);
          captured++;
        } else {
          notCaptured++;
        }
      } catch { notCaptured++; }
    }

    const results = ps.map((p) => {
      const r = percentile(values, p);
      return { percentile: p, value: r.value, state: r.state, missing_reason: r.missing_reason, comparable: r.comparable, coverage: r.coverage };
    });

    return json(res, {
      agent: agentName, metric: metricName,
      sample_count: values.length, captured, not_captured: notCaptured,
      total_sessions: sessions.items.length,
      percentiles: results,
      generated_at: beijingIso(),
    });
  }

  if (p === "/api/resources") {
    const data = await collectResources();
    return json(res, { agents: data, generated_at: beijingIso() });
  }

  if (p === "/api/resources/history") {
    const sinceMs = Number(url.searchParams.get("since")) || 0;
    const points = getDBResourceHistory(sinceMs);
    return json(res, { points, generated_at: beijingIso() });
  }

  if (p === "/api/sync") {
    syncAllAgents();
    return json(res, { status: "started", generated_at: beijingIso() });
  }

  if (p === "/api/resync" && req.method === "POST") {
    const body = await new Promise((resolve) => {
      let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => resolve(data));
    });
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch {}
    const targetAgent = parsed.agent || null;
    const d = getDB();
    let deleted = 0;
    if (targetAgent) {
      deleted = d.prepare("DELETE FROM session_metrics WHERE agent = ?").run(targetAgent).changes;
    } else {
      deleted = d.prepare("DELETE FROM session_metrics").run().changes;
    }
    syncAllAgents();
    return json(res, { status: "started", deleted_metrics: deleted, agent: targetAgent || "all", generated_at: beijingIso() });
  }

  if (p === "/api/db-stats") {
    const stats = getDBStats();
    return json(res, { ...stats, generated_at: beijingIso() });
  }

  if (p === "/api/settings" && req.method === "GET") {
    return json(res, {
      db: { retentionDays: config.db.retentionDays, syncIntervalMs: config.db.syncIntervalMs },
      system: { port: config.port, timezone: config.timezone, version: config.appVersion },
      generated_at: beijingIso(),
    });
  }

  if (p === "/api/settings" && req.method === "PUT") {
    const body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { return json(res, { error: "invalid_json" }, 400); }
    const result = saveDbSettings({
      retentionDays: parsed.db?.retentionDays,
      syncIntervalMs: parsed.db?.syncIntervalMs,
    });
    if (result.ok) {
      // Reschedule sync with new interval
      if (syncTimer) { clearTimeout(syncTimer); scheduleNextSync(); }
      return json(res, { status: "ok", db: config.db, generated_at: beijingIso() });
    }
    return json(res, { error: result.error }, 500);
  }

  if (p === "/api/clean-db" && req.method === "POST") {
    const result = cleanOldMetrics();
    return json(res, { ...result, generated_at: beijingIso() });
  }

  if (p === "/api/env-check") {
    const data = await collectEnvCheck();
    return json(res, { system: data.system, agents: data.agents, generated_at: beijingIso() });
  }

  const timelineMatch = p.match(/^\/api\/sessions\/(\w+)\/default\/([^/]+)\/timeline$/);
  if (timelineMatch) {
    const [, agent, sessionId] = timelineMatch;
    const adapter = adapters[agent];
    if (!adapter) return json(res, { error: "unknown_agent" }, 404);
    if (!adapter.extractTimeline) return json(res, { items: [] });
    // DB fast path
    try {
      const fromDB = getDBTimeline(agent, sessionId);
      if (fromDB) return json(res, { items: fromDB, source: "db" });
    } catch {}
    const items = await adapter.extractTimeline(sessionId);
    try { if (items?.length) upsertTimeline(agent, sessionId, items); } catch {}
    return json(res, { items: items || [], source: "live" });
  }

  // ============================================================================
  // /api/export — 一键导出观测数据（含每 Agent 每 Session 的全部详细日志）
  // ============================================================================
  if (p === "/api/export") {
    const agentFilter = url.searchParams.get("agents");
    const agentNames = agentFilter
      ? agentFilter.split(",").filter((n) => adapters[n])
      : Object.keys(adapters);
    const timeFilter = parseTimeFilter(url);
    const since = timeFilter.since || 0;
    const until = timeFilter.until || Date.now();

    const now = Date.now();
    const stamp = beijingIso().replace(/[-:T]/g, "").slice(0, 15);
    const filename = `observatory-export-${stamp}.json`;

    const exportData = { export_metadata: {}, summary: {}, agents: {} };

    // --- export_metadata ---
    const sessionsByAgent = {};
    let totalSessions = 0;
    let availableAgents = 0;

    // --- summary: reuse aggregateForCompare logic ---
    const compareData = {};

    // --- per-agent session detail ---
    const useDB = getDBStats().session_count > 0;

    for (const name of agentNames) {
      const adapter = adapters[name];

      // agent_info via discover()
      let agentInfo;
      try {
        const d = await adapter.discover();
        agentInfo = {
          available: d.available,
          adapter_version: d.adapter_version,
          agent_version: d.agent_version,
          sources: d.sources,
          missing_reasons: d.missing_reasons || [],
          modes: d.modes || [],
        };
      } catch (e) {
        agentInfo = { available: false, adapter_version: null, error: e.message };
      }
      if (agentInfo.available) availableAgents++;

      // get sessions
      let sessions = [];
      try {
        if (useDB) {
          sessions = getDBSessionItems({ agent: name, limit: 500, since, until });
        }
        if (sessions.length === 0) {
          const result = await adapter.extractSessions({ limit: 500, ...timeFilter });
          sessions = result.items || [];
        }
      } catch { sessions = []; }

      sessionsByAgent[name] = sessions.length;
      totalSessions += sessions.length;

      // collect sessionMetrics for compare summary
      const sessionMetricsForCompare = [];

      // build per-session detail
      const sessionDetails = [];
      for (const s of sessions) {
        const sid = s.session_id || s.id;
        if (!sid) continue;

        // metrics
        let metrics = [];
        try {
          if (useDB) {
            const fromDB = getDBSessionMetrics(name, sid);
            if (fromDB && fromDB.length > 0) metrics = fromDB;
          }
          if (metrics.length === 0) metrics = await adapter.extractMetrics(sid);
        } catch {}

        // events
        let events = [];
        try {
          if (useDB) {
            const fromDB = getDBEvents(name, sid);
            if (fromDB && fromDB.length > 0) events = fromDB;
          }
          if (events.length === 0) events = (await adapter.extractEvents?.(sid)) || [];
        } catch {}

        // usage
        let usage = [];
        try {
          if (useDB) {
            const fromDB = getDBUsage(name, sid);
            if (fromDB && fromDB.length > 0) usage = fromDB;
          }
          if (usage.length === 0) usage = (await adapter.extractUsage?.(sid)) || [];
        } catch {}

        // calls (always live, no DB cache)
        let calls = { llm_calls: [], tool_calls: [], trace_duration_ms: null };
        try {
          if (adapter.extractCalls) calls = await adapter.extractCalls(sid);
        } catch {}

        // failures (always live, no DB cache)
        let failures = {
          diagnostics: [],
          summary: { gateway: 0, tool: 0, model: 0, dependency: 0, agent: 0 },
          source_available: true,
        };
        try {
          if (adapter.extractFailures) {
            const f = await adapter.extractFailures(sid);
            const fsum = f.summary || {};
            const failuresNc = f.source_available === false;
            failures = {
              diagnostics: f.diagnostics || [],
              summary: {
                gateway: failuresNc ? null : (fsum.gateway || 0),
                tool: failuresNc ? null : (fsum.tool || 0),
                model: failuresNc ? null : (fsum.model || 0),
                dependency: failuresNc ? null : (fsum.dependency || 0),
                agent: failuresNc ? null : (fsum.agent || 0),
              },
              source_available: f.source_available !== false,
            };
          }
        } catch {}

        // timeline
        let timeline = [];
        try {
          if (useDB) {
            const fromDB = getDBTimeline(name, sid);
            if (fromDB && fromDB.length > 0) timeline = fromDB;
          }
          if (timeline.length === 0) timeline = (await adapter.extractTimeline?.(sid)) || [];
        } catch {}

        // merge failures into metrics for compare summary
        const metricMap = {};
        for (const m of metrics) {
          if (!metricMap[m.metric] || m.state === "captured") {
            metricMap[m.metric] = { value: m.value, state: m.state, unit: m.unit };
          }
        }
        const fsum = failures.summary;
        const failuresNc = !failures.source_available;
        for (const cat of ["gateway", "tool", "model", "dependency", "agent"]) {
          metricMap["failures_" + cat] = failuresNc
            ? { value: null, state: "not-captured", missing_reason: "source_unavailable" }
            : { value: fsum[cat] || 0, state: "captured" };
        }
        sessionMetricsForCompare.push({ session_id: sid, metrics: metricMap });

        sessionDetails.push({
          session: s,
          metrics,
          events,
          usage,
          calls,
          failures,
          timeline,
        });
      }

      exportData.agents[name] = { agent_info: agentInfo, sessions: sessionDetails };
      compareData[name] = aggregateForCompare(sessionMetricsForCompare);
    }

    exportData.export_metadata = {
      exported_at: beijingIso(),
      exported_at_epoch_ms: now,
      tool_version: config.appVersion,
      filter: {
        agents: agentFilter || "all",
        since: timeFilter.since ? new Date(timeFilter.since).toISOString() : null,
        until: timeFilter.until ? new Date(timeFilter.until).toISOString() : null,
      },
      statistics: {
        total_agents: agentNames.length,
        available_agents: availableAgents,
        total_sessions: totalSessions,
        sessions_by_agent: sessionsByAgent,
      },
    };

    exportData.summary = {
      generated_at: beijingIso(),
      agents: compareData,
    };

    const body = JSON.stringify(redact(exportData), null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    res.end(body);
    return;
  }

  return jsonFiltered(res, { error: "not_found", path: p }, 404);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${config.host}:${config.port}`);
  if (url.pathname.startsWith("/api/")) {
    try { await handleApi(req, res, url); }
    catch (e) { json(res, { error: "internal", message: e.message }, 500); }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(await ensureHtml());
});

server.listen(config.port, config.host, () => {
  console.log(`Agent Log Observatory ${config.appVersion}`);
  console.log(`Listening on http://127.0.0.1:${config.port}/`);
  console.log(`API: http://127.0.0.1:${config.port}/api/health`);
});
