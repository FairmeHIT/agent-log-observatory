import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";

const home = os.homedir();
const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function env(key) {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : null;
}

function envOrDefault(key, defaultValue) {
  return env(key) || defaultValue;
}

function loadConfigFile() {
  const candidates = env("AGENT_LOG_CONFIG") ? [path.resolve(env("AGENT_LOG_CONFIG"))] : [
    path.join(appDirectory, "agent-log-observatory.config.json"),
    path.join(appDirectory, "agent-log-observatory.config.jsonc"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf8");
        return parseJsonc(raw);
      }
    } catch (error) { throw new Error(`Invalid Observatory config: ${file}: ${error.message}`); }
  }
  if (env("AGENT_LOG_CONFIG")) throw new Error("AGENT_LOG_CONFIG file does not exist");
  return null;
}

const fileConfig = loadConfigFile() || {};

export function resolveConfiguredPath(value) {
  if (!value) return value;
  const expanded = String(value).replace(/^~(?=[\\/]|$)/, home)
    .replace(/\$\{([A-Z_]+)\}/g, (_, key) => { if (!process.env[key]) throw new Error(`Path environment variable is not set: ${key}`); return process.env[key]; });
  return path.resolve(appDirectory, expanded);
}

function agentEnv(name, key, defaultValue) {
  const envKey = `AGENT_LOG_${name.toUpperCase()}_${key.toUpperCase()}`;
  return resolveConfiguredPath(env(envKey) || fileConfig?.agents?.[name]?.[key] || defaultValue);
}

export const config = {
  port: Number.parseInt(envOrDefault("AGENT_LOG_OBSERVATORY_PORT", String(fileConfig.port ?? 8780)), 10),
  host: "127.0.0.1",
  appVersion: "v0.0.9",
  appDirectory,
  runtimeDirectory: resolveConfiguredPath(env("AGENT_LOG_RUNTIME_DIR") || fileConfig.runtimeDirectory || "runtime"),
  collectorRoot: resolveConfiguredPath(env("AGENT_LOG_COLLECTOR_ROOT") || fileConfig.collectorRoot || "runtime/collectors"),
  timezone: "Asia/Shanghai",
  sqliteExecutable: resolveConfiguredPath(env("AGENT_LOG_SQLITE") || fileConfig.sqliteExecutable || "runtime/sqlite3.exe"),
  agents: {
    workbuddy: {
      installDir: agentEnv("workbuddy", "installDir", ""),
      dataDir: agentEnv("workbuddy", "dataDir", path.join(home, ".workbuddy")),
      electronLogsDir: agentEnv("workbuddy", "electronLogsDir", path.join(home, "AppData", "Local", "WorkBuddy", "logs")),
      electronLogsDirAlt: agentEnv("workbuddy", "electronLogsDirAlt", null),
    },
    mobilework: {
      installDir: agentEnv("mobilework", "installDir", ""),
      dataDir: agentEnv("mobilework", "dataDir", path.join(home, ".mobilework")),
      dashboardDataDir: agentEnv("mobilework", "dashboardDataDir", null),
    },
    teleagent: {
      installDir: agentEnv("teleagent", "installDir", ""),
      dataDir: agentEnv("teleagent", "dataDir", path.join(home, ".local", "share", "TeleAgent")),
      configDir: agentEnv("teleagent", "configDir", path.join(home, ".config", "TeleAgent")),
      cacheDir: agentEnv("teleagent", "cacheDir", path.join(home, ".cache", "TeleAgent")),
      dbDir: agentEnv("teleagent", "dbDir", path.join(home, ".local", "share", "TeleAgent", "users")),
    },
    doubao: {
      installDir: agentEnv("doubao", "installDir", ""),
      userDataDir: agentEnv("doubao", "userDataDir", path.join(home, "AppData", "Local", "Doubao")),
      sessionsRoot: agentEnv("doubao", "sessionsRoot", path.join(
        home, "AppData", "Local", "Doubao", "User Data", "Default",
        ".doubao", "agent_mode", "workspace", ".sessions"
      )),
      rpaDevDir: agentEnv("doubao", "rpaDevDir", path.join(home, "AppData", "Local", "Doubao", "rpa-dev")),
      chatsDir: agentEnv("doubao", "chatsDir", path.join(home, "Doubao", "chats")),
    },
    dsh: {
      installDir: agentEnv("dsh", "installDir", ""),
      dataDir: agentEnv("dsh", "dataDir", path.join(home, ".dsh")),
      electronDataDir: agentEnv("dsh", "electronDataDir", path.join(home, "AppData", "Roaming", "dsh-desktop")),
      sessionsDir: agentEnv("dsh", "sessionsDir", path.join(home, ".dsh", "sessions")),
      storagesDir: agentEnv("dsh", "storagesDir", path.join(home, ".dsh", "storages")),
    },
    codex: {
      installDir: agentEnv("codex", "installDir", path.join(home, "AppData", "Local", "OpenAI", "Codex")),
      dataDir: agentEnv("codex", "dataDir", path.join(home, ".codex")),
      configPath: agentEnv("codex", "configPath", path.join(home, ".codex", "config.toml")),
    },
    opencode: {
      dataDir: agentEnv("opencode", "dataDir", path.join(home, ".local", "share", "opencode")),
      configDir: agentEnv("opencode", "configDir", path.join(home, ".config", "opencode")),
      appDir: agentEnv("opencode", "appDir", path.join(home, "AppData", "Local", "Programs", "@opencodedesktop")),
      cliDir: agentEnv("opencode", "cliDir", path.join(home, "AppData", "Roaming", "ai.opencode.desktop")),
    },
  },
  eaqe: {
    bundle: envOrDefault("EAQE_DASHBOARD_BUNDLE", fileConfig?.eaqe?.bundle || ""),
    bundleRoot: envOrDefault("EAQE_DASHBOARD_BUNDLE_ROOT", fileConfig?.eaqe?.bundleRoot || ""),
    bundlePaths: (envOrDefault("EAQE_DASHBOARD_BUNDLES", fileConfig?.eaqe?.bundlePaths || ""))
      .split(path.delimiter)
      .map((v) => v.trim())
      .filter(Boolean),
  },
  live: {
    pollIntervalMs: Number.parseInt(envOrDefault("AGENT_LOG_LIVE_POLL_MS", "15000"), 10),
    fastTickMs: Number.parseInt(envOrDefault("AGENT_LOG_LIVE_TICK_MS", "250"), 10),
    sseDebounceMs: Number.parseInt(envOrDefault("AGENT_LOG_LIVE_SSE_MS", "500"), 10),
  },
  db: {
    retentionDays: Number.parseInt(envOrDefault("AGENT_LOG_DB_RETENTION_DAYS", String(fileConfig?.db?.retentionDays ?? 30)), 10),
    syncIntervalMs: Number.parseInt(envOrDefault("AGENT_LOG_DB_SYNC_INTERVAL_MS", String(fileConfig?.db?.syncIntervalMs ?? 300000)), 10),
  },
};

// ---- 动态配置写入（Settings 页面用）----

const configFilePath = (() => {
  if (env("AGENT_LOG_CONFIG")) return path.resolve(env("AGENT_LOG_CONFIG"));
  for (const f of [path.join(appDirectory, "agent-log-observatory.config.json"), path.join(appDirectory, "agent-log-observatory.config.jsonc")]) {
    if (fs.existsSync(f)) return f;
  }
  return configFilePath;
})();

export function saveDbSettings({ retentionDays, syncIntervalMs }) {
  // Update in-memory config immediately (takes effect on next sync/clean cycle)
  if (retentionDays != null) config.db.retentionDays = Number(retentionDays);
  if (syncIntervalMs != null) config.db.syncIntervalMs = Number(syncIntervalMs);
  // Persist to config file
  try {
    let raw = "{}";
    try { raw = fs.readFileSync(configFilePath, "utf8"); } catch {}
    const obj = parseJsonc(raw);
    if (!obj.db) obj.db = {};
    if (retentionDays != null) obj.db.retentionDays = Number(retentionDays);
    if (syncIntervalMs != null) obj.db.syncIntervalMs = Number(syncIntervalMs);
    fs.writeFileSync(configFilePath, JSON.stringify(obj, null, 2), "utf8");
    return { ok: true, ...config.db, file: configFilePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function resolveAgentConfig(agentObject) {
  const agent = config.agents[agentObject];
  if (!agent) throw new Error(`Unknown agent object: ${agentObject}`);
  return agent;
}

export function getConfigFilePath() {
  return configFilePath;
}
