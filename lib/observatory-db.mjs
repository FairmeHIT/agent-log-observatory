// ============================================================================
// observatory-db.mjs — Observatory 自有缓存库
// 存储：清洗后、标准化后、展示就绪的 session 元数据 + 预计算 metrics
// 同步：后台增量（5 分钟间隔），用 session_id 去重，只处理 delta
// 保留：30 天自动清理 metrics，session 元数据永久保留
// 依赖：better-sqlite3（同步 API，单文件 DB）
// ============================================================================

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { beijingIso } from "./time.mjs";
import { config } from "./config.mjs";
import { runtimePath } from "./runtime-paths.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = runtimePath("observatory.db");

function getRetentionMs() {
  return config.db.retentionDays * 24 * 60 * 60 * 1000;
}

let db = null;

// ---- 初始化 ----

export function getDB() {
  if (db) return db;
  // Ensure runtime/ exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  initSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      agent          TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      started_at     INTEGER,
      ended_at       INTEGER,
      model          TEXT,
      turn_count     INTEGER,
      message_count  INTEGER,
      title          TEXT,
      item_json      TEXT,
      synced_at      INTEGER NOT NULL,
      PRIMARY KEY (agent, session_id)
    );

    CREATE TABLE IF NOT EXISTS session_metrics (
      agent          TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      metric_name    TEXT NOT NULL,
      value          REAL,
      state          TEXT,
      missing_reason TEXT,
      unit           TEXT,
      metric_json    TEXT,
      synced_at      INTEGER NOT NULL,
      PRIMARY KEY (agent, session_id, metric_name)
    );

    CREATE TABLE IF NOT EXISTS resource_snapshots (
      ts             INTEGER NOT NULL,
      agent          TEXT NOT NULL,
      mem_mb         REAL,
      cpu_time_s     REAL,
      avg_cpu_pct    REAL,
      disk_mb        REAL,
      proc_count     INTEGER,
      PRIMARY KEY (ts, agent)
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      agent          TEXT NOT NULL PRIMARY KEY,
      synced_at      INTEGER NOT NULL,
      total_sessions INTEGER,
      new_sessions   INTEGER,
      error          TEXT
    );

    CREATE TABLE IF NOT EXISTS session_events (
      agent          TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      event_json     TEXT NOT NULL,
      synced_at      INTEGER NOT NULL,
      PRIMARY KEY (agent, session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS session_usage (
      agent          TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      usage_json     TEXT NOT NULL,
      synced_at      INTEGER NOT NULL,
      PRIMARY KEY (agent, session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS session_timeline (
      agent          TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      point_json     TEXT NOT NULL,
      synced_at      INTEGER NOT NULL,
      PRIMARY KEY (agent, session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS file_observations (
      agent          TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      file_path      TEXT NOT NULL,
      line_count     INTEGER NOT NULL,
      observed_at    INTEGER NOT NULL,
      PRIMARY KEY (agent, session_id, file_path, observed_at)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(agent, started_at);
    CREATE INDEX IF NOT EXISTS idx_metrics_name ON session_metrics(agent, metric_name);
    CREATE INDEX IF NOT EXISTS idx_resource_ts ON resource_snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(agent, session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON session_usage(agent, session_id);
    CREATE INDEX IF NOT EXISTS idx_timeline_session ON session_timeline(agent, session_id);
  `);
  // Migration: add item_json column if missing (old DBs)
  try {
    const cols = db.prepare("PRAGMA table_info(sessions)").all();
    if (!cols.some((c) => c.name === "item_json")) {
      db.exec("ALTER TABLE sessions ADD COLUMN item_json TEXT");
    }
  } catch {}
  // Migration: add metric_json column if missing (old DBs)
  try {
    const cols = db.prepare("PRAGMA table_info(session_metrics)").all();
    if (!cols.some((c) => c.name === "metric_json")) {
      db.exec("ALTER TABLE session_metrics ADD COLUMN metric_json TEXT");
    }
    // Backfill: reconstruct metric_json from existing columns where NULL
    const nullCount = db.prepare("SELECT COUNT(*) as cnt FROM session_metrics WHERE metric_json IS NULL").get().cnt;
    if (nullCount > 0) {
      const rows = db.prepare("SELECT agent, session_id, metric_name, value, state, missing_reason, unit FROM session_metrics WHERE metric_json IS NULL").all();
      const stmt = db.prepare("UPDATE session_metrics SET metric_json = ? WHERE agent = ? AND session_id = ? AND metric_name = ?");
      const tx = db.transaction((items) => {
        for (const r of items) {
          stmt.run(JSON.stringify({ metric: r.metric_name, value: r.value, state: r.state, missing_reason: r.missing_reason, unit: r.unit }), r.agent, r.session_id, r.metric_name);
        }
      });
      tx(rows);
      console.log(`[observatory-db] Backfilled metric_json for ${rows.length} rows`);
    }
  } catch {}
}

export function closeDB() {
  if (db) { db.close(); db = null; }
}

// ---- Session 写入 ----

export function upsertSession(agent, session) {
  const d = getDB();
  d.prepare(`
    INSERT INTO sessions (agent, session_id, started_at, ended_at, model, turn_count, message_count, title, item_json, synced_at)
    VALUES (@agent, @session_id, @started_at, @ended_at, @model, @turn_count, @message_count, @title, @item_json, @synced_at)
    ON CONFLICT(agent, session_id) DO UPDATE SET
      started_at = @started_at, ended_at = @ended_at, model = @model,
      turn_count = @turn_count, message_count = @message_count, title = @title,
      item_json = @item_json, synced_at = @synced_at
  `).run({
    agent,
    session_id: session.session_id,
    started_at: toEpochMs(session.startedAt || session.started_at),
    ended_at: toEpochMs(session.endedAt || session.ended_at),
    model: session.model || null,
    turn_count: session.turnCount || session.turn_count || null,
    message_count: session.messageCount || session.message_count || null,
    title: session.title || null,
    item_json: JSON.stringify(session),
    synced_at: Date.now(),
  });
}

function toEpochMs(v) {
  if (!v) return null;
  if (typeof v === "number") return v;
  const ms = Date.parse(v);
  return isNaN(ms) ? null : ms;
}

// ---- Metrics 写入 ----

export function upsertMetrics(agent, sessionId, metricsArray) {
  const d = getDB();
  const stmt = d.prepare(`
    INSERT INTO session_metrics (agent, session_id, metric_name, value, state, missing_reason, unit, metric_json, synced_at)
    VALUES (@agent, @session_id, @metric_name, @value, @state, @missing_reason, @unit, @metric_json, @synced_at)
    ON CONFLICT(agent, session_id, metric_name) DO UPDATE SET
      value = @value, state = @state, missing_reason = @missing_reason, unit = @unit, metric_json = @metric_json, synced_at = @synced_at
  `);
  const tx = d.transaction((rows) => {
    for (const r of rows) stmt.run(r);
  });
  const now = Date.now();
  const rows = metricsArray.map((m) => ({
    agent,
    session_id: sessionId,
    metric_name: m.metric,
    value: m.value ?? null,
    state: m.state || null,
    missing_reason: m.missing_reason || null,
    unit: m.unit || null,
    metric_json: JSON.stringify(m),
    synced_at: now,
  }));
  tx(rows);
}

// ---- Resource snapshot 写入 ----

export function insertResourceSnapshot(ts, agent, data) {
  const d = getDB();
  d.prepare(`
    INSERT OR REPLACE INTO resource_snapshots (ts, agent, mem_mb, cpu_time_s, avg_cpu_pct, disk_mb, proc_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ts, agent, data.mem ?? null, data.cpu ?? null, data.avg_cpu ?? null, data.disk ?? null, data.proc ?? null);
}

// ---- 查询 ----

export function getDBStats() {
  const d = getDB();
  const sessionCount = d.prepare("SELECT COUNT(*) as n FROM sessions").get().n;
  const metricCount = d.prepare("SELECT COUNT(*) as n FROM session_metrics").get().n;
  const snapshotCount = d.prepare("SELECT COUNT(*) as n FROM resource_snapshots").get().n;
  const lastSync = d.prepare("SELECT agent, synced_at, new_sessions, error FROM sync_log ORDER BY synced_at DESC").all();
  return { session_count: sessionCount, metric_count: metricCount, snapshot_count: snapshotCount, last_sync: lastSync, retention_days: config.db.retentionDays, sync_interval_ms: config.db.syncIntervalMs };
}

export function getDBSessions(agent, options = {}) {
  const d = getDB();
  const { limit = 50, since, until } = options;
  let sql = "SELECT * FROM sessions";
  const conditions = [];
  const params = [];
  if (agent) { conditions.push("agent = ?"); params.push(agent); }
  if (since) { conditions.push("started_at >= ?"); params.push(since); }
  if (until) { conditions.push("started_at <= ?"); params.push(until); }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY started_at DESC LIMIT ?";
  params.push(limit);
  return d.prepare(sql).all(...params);
}

// Sessions list API: return full item_json objects from DB
export function getDBSessionItems(options = {}) {
  const d = getDB();
  const { agent, limit = 50, since, until } = options;
  const conditions = ["item_json IS NOT NULL"];
  const params = [];
  if (agent) { conditions.push("agent = ?"); params.push(agent); }
  if (since) { conditions.push("started_at >= ?"); params.push(since); }
  if (until) { conditions.push("started_at <= ?"); params.push(until); }
  let sql = "SELECT item_json FROM sessions WHERE " + conditions.join(" AND ");
  sql += " ORDER BY started_at DESC LIMIT ?";
  params.push(limit);
  const rows = d.prepare(sql).all(...params);
  const items = [];
  for (const r of rows) {
    try { items.push(JSON.parse(r.item_json)); } catch {}
  }
  return items;
}

export function getDBSessionItem(agent, sessionId) {
  const d = getDB();
  const row = d.prepare("SELECT item_json FROM sessions WHERE agent = ? AND session_id = ?").get(agent, sessionId);
  if (!row || !row.item_json) return null;
  try { return JSON.parse(row.item_json); } catch { return null; }
}

export function getDBSessionMetrics(agent, sessionId) {
  const d = getDB();
  const rows = d.prepare(
    "SELECT metric_json FROM session_metrics WHERE agent = ? AND session_id = ? AND metric_json IS NOT NULL"
  ).all(agent, sessionId);
  if (!rows.length) return null;
  const items = [];
  for (const r of rows) {
    try { items.push(JSON.parse(r.metric_json)); } catch {}
  }
  return items.length ? items : null;
}

// ---- Events / Usage / Timeline 读写 ----

export function upsertEvents(agent, sessionId, eventsArray) {
  const d = getDB();
  d.prepare("DELETE FROM session_events WHERE agent = ? AND session_id = ?").run(agent, sessionId);
  const stmt = d.prepare("INSERT INTO session_events (agent, session_id, seq, event_json, synced_at) VALUES (?, ?, ?, ?, ?)");
  const now = Date.now();
  const tx = d.transaction((items) => {
    items.forEach((e, i) => stmt.run(agent, sessionId, i, JSON.stringify(e), now));
  });
  tx(eventsArray);
}

export function getDBEvents(agent, sessionId) {
  const d = getDB();
  const rows = d.prepare("SELECT event_json FROM session_events WHERE agent = ? AND session_id = ? ORDER BY seq").all(agent, sessionId);
  if (!rows.length) return null;
  return rows.map((r) => { try { return JSON.parse(r.event_json); } catch { return null; } }).filter(Boolean);
}

export function upsertUsage(agent, sessionId, usageArray) {
  const d = getDB();
  d.prepare("DELETE FROM session_usage WHERE agent = ? AND session_id = ?").run(agent, sessionId);
  const stmt = d.prepare("INSERT INTO session_usage (agent, session_id, seq, usage_json, synced_at) VALUES (?, ?, ?, ?, ?)");
  const now = Date.now();
  const tx = d.transaction((items) => {
    items.forEach((u, i) => stmt.run(agent, sessionId, i, JSON.stringify(u), now));
  });
  tx(usageArray);
}

export function getDBUsage(agent, sessionId) {
  const d = getDB();
  const rows = d.prepare("SELECT usage_json FROM session_usage WHERE agent = ? AND session_id = ? ORDER BY seq").all(agent, sessionId);
  if (!rows.length) return null;
  return rows.map((r) => { try { return JSON.parse(r.usage_json); } catch { return null; } }).filter(Boolean);
}

export function upsertTimeline(agent, sessionId, pointsArray) {
  const d = getDB();
  d.prepare("DELETE FROM session_timeline WHERE agent = ? AND session_id = ?").run(agent, sessionId);
  const stmt = d.prepare("INSERT INTO session_timeline (agent, session_id, seq, point_json, synced_at) VALUES (?, ?, ?, ?, ?)");
  const now = Date.now();
  const tx = d.transaction((items) => {
    items.forEach((p, i) => stmt.run(agent, sessionId, i, JSON.stringify(p), now));
  });
  tx(pointsArray);
}

export function getDBTimeline(agent, sessionId) {
  const d = getDB();
  const rows = d.prepare("SELECT point_json FROM session_timeline WHERE agent = ? AND session_id = ? ORDER BY seq").all(agent, sessionId);
  if (!rows.length) return null;
  return rows.map((r) => { try { return JSON.parse(r.point_json); } catch { return null; } }).filter(Boolean);
}

// ---- File observations（文件监听时间线） ----

export function insertFileObservation(agent, sessionId, filePath, lineCount, observedAt) {
  const d = getDB();
  d.prepare(`
    INSERT OR IGNORE INTO file_observations (agent, session_id, file_path, line_count, observed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(agent, sessionId, filePath, lineCount, observedAt);
}

export function getFileObservations(agent, sessionId) {
  const d = getDB();
  return d.prepare(
    "SELECT file_path, line_count, observed_at FROM file_observations WHERE agent = ? AND session_id = ? ORDER BY observed_at"
  ).all(agent, sessionId);
}

export function getLastObservation(agent, sessionId, filePath) {
  const d = getDB();
  return d.prepare(
    "SELECT line_count, observed_at FROM file_observations WHERE agent = ? AND session_id = ? AND file_path = ? ORDER BY observed_at DESC LIMIT 1"
  ).get(agent, sessionId, filePath);
}

export function getDBResourceHistory(sinceMs = 0) {
  const d = getDB();
  const rows = d.prepare("SELECT * FROM resource_snapshots WHERE ts >= ? ORDER BY ts").all(sinceMs);
  // Group by ts → { ts, agent: { mem, cpu, ... } }
  const points = [];
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, { ts: r.ts });
    byTs.get(r.ts)[r.agent] = {
      mem: r.mem_mb, cpu: r.cpu_time_s, avg_cpu: r.avg_cpu_pct,
      disk: r.disk_mb, proc: r.proc_count,
    };
  }
  for (const p of byTs.values()) points.push(p);
  return points;
}

export function getDBSyncLog() {
  const d = getDB();
  return d.prepare("SELECT * FROM sync_log ORDER BY agent").all();
}

// ---- 保留策略 ----

export function cleanOldMetrics() {
  const d = getDB();
  const cutoff = Date.now() - getRetentionMs();
  const result = d.prepare("DELETE FROM session_metrics WHERE synced_at < ?").run(cutoff);
  d.prepare("DELETE FROM resource_snapshots WHERE ts < ?").run(cutoff);
  return { deleted_metrics: result.changes, cutoff, retention_days: config.db.retentionDays };
}

// ---- 已知 session 检查（增量同步用） ----

export function getKnownSessionIds(agent) {
  const d = getDB();
  const rows = d.prepare("SELECT session_id FROM sessions WHERE agent = ?").all(agent);
  return new Set(rows.map((r) => r.session_id));
}

export function hasSessionMetrics(agent, sessionId) {
  const d = getDB();
  const row = d.prepare("SELECT 1 as found FROM session_metrics WHERE agent = ? AND session_id = ? LIMIT 1").get(agent, sessionId);
  return !!row;
}

export function upsertSyncLog(agent, totalSessions, newSessions, error) {
  const d = getDB();
  d.prepare(`
    INSERT INTO sync_log (agent, synced_at, total_sessions, new_sessions, error)
    VALUES (@agent, @synced_at, @total_sessions, @new_sessions, @error)
    ON CONFLICT(agent) DO UPDATE SET
      synced_at = @synced_at, total_sessions = @total_sessions, new_sessions = @new_sessions, error = @error
  `).run({
    agent,
    synced_at: Date.now(),
    total_sessions: totalSessions,
    new_sessions: newSessions,
    error: error || null,
  });
}
