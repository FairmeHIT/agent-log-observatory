// collectors/install-mobilework-proxy.mjs
//
// 安装/卸载 Mobilework LLM MITM 代理：
//   install  → 备份 providers.jsonc，修改 baseURL 指向代理，生成 proxy-config.json
//   uninstall → 恢复备份
//   status   → 检查当前状态
//
// 用法：
//   node install-mobilework-proxy.mjs install
//   node install-mobilework-proxy.mjs uninstall
//   node install-mobilework-proxy.mjs status
//
// 约束：
//   - 只修改 providers.jsonc 的 baseURL 字段，其他字段（apiKey/models/limits）原样保留
//   - 备份文件 .collector-llm-proxy.bak，可回退
//   - diff 验证：只改 baseURL，不改 provider 名称或结构

import fs from "node:fs";
import path from "node:path";
import { config } from "../lib/config.mjs";
import { runtimePath } from "../lib/runtime-paths.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";

const CONFIG_DIR = path.join(config.agents.mobilework.dataDir, "config");
const PROVIDERS_PATH = path.join(CONFIG_DIR, "providers.jsonc");
const BAK_PATH = path.join(CONFIG_DIR, "providers.jsonc.llm-proxy-bak");
const PROXY_CONFIG_PATH = process.env.AGENT_LOG_PROXY_CONFIG || runtimePath("mobilework-proxy.json");

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 8890;

// ── URL decomposition ───────────────────────────────────────────────
/**
 * Decompose baseURL into { target, pathPrefix }.
 *   http://47.112.174.22:38421/v1         → target=http://47.112.174.22:38421, prefix=/v1
 *   http://127.0.0.1:53074/p/mw-auto      → target=http://127.0.0.1:53074, prefix=/p/mw-auto
 *   http://example.com                    → target=http://example.com, prefix=""
 */
function decomposeBaseURL(baseURL) {
  try {
    const u = new URL(baseURL);
    if (u.protocol !== "http:") return null;
    const target = `${u.protocol}//${u.host}`;
    const pathPrefix = u.pathname.replace(/\/+$/, ""); // strip trailing slash
    return { target, pathPrefix };
  } catch {
    return null;
  }
}

/**
 * Build proxy baseURL from path prefix.
 *   /v1           → http://127.0.0.1:8890/v1
 *   /p/mw-auto    → http://127.0.0.1:8890/p/mw-auto
 */
function proxyBaseURL(pathPrefix) {
  const base = `http://${PROXY_HOST}:${PROXY_PORT}`;
  if (!pathPrefix) return base;
  return base + pathPrefix;
}

// ── install ─────────────────────────────────────────────────────────
function install() {
  if (!fs.existsSync(PROVIDERS_PATH)) {
    console.error(`[install] providers.jsonc not found: ${PROVIDERS_PATH}`);
    process.exit(1);
  }

  // Check if already installed
  if (fs.existsSync(BAK_PATH)) {
    console.error(`[install] backup already exists: ${BAK_PATH}`);
    console.error(`[install] already installed? run "status" or "uninstall" first.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(PROVIDERS_PATH, "utf8");
  const json = parseJsonc(raw);

  const provider = json.provider || {};
  if (typeof provider !== "object" || Object.keys(provider).length === 0) {
    console.error("[install] no providers found in providers.jsonc");
    process.exit(1);
  }

  // Build routes from original baseURLs
  const routes = [];
  const changes = [];

  for (const [name, cfg] of Object.entries(provider)) {
    const baseURL = cfg?.options?.baseURL;
    if (!baseURL) continue;
    const dec = decomposeBaseURL(baseURL);
    if (!dec) {
      throw new Error(`Provider ${name} has an unsupported baseURL: only valid HTTP upstream URLs are supported. No client config changed.`);
    }

    // Check for duplicate path prefixes
    if (routes.some((r) => r.path_prefix === dec.pathPrefix)) {
      if (routes.find(r => r.path_prefix === dec.pathPrefix).target !== dec.target) {
        throw new Error(`Conflicting route prefix ${dec.pathPrefix}; configure unique provider prefixes before installing.`);
      }
      // Same prefix and same target
      changes.push({ name, old: baseURL, new: proxyBaseURL(dec.pathPrefix), prefix: dec.pathPrefix, dedup: true });
      continue;
    }

    routes.push({
      path_prefix: dec.pathPrefix,
      target: dec.target,
      comment: `${name} → ${dec.target}`,
    });
    changes.push({ name, old: baseURL, new: proxyBaseURL(dec.pathPrefix), prefix: dec.pathPrefix });
  }

  if (changes.length === 0) {
    console.error("[install] no providers with baseURL found");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(PROXY_CONFIG_PATH), { recursive: true });

  // Backup original
  fs.copyFileSync(PROVIDERS_PATH, BAK_PATH);
  console.log(`[install] backup saved: ${BAK_PATH}`);

  // Modify baseURLs
  for (const change of changes) {
    const cfg = provider[change.name];
    cfg.options.baseURL = change.new;
  }

  // Write modified providers.jsonc (pretty-printed, preserving structure)
  const modified = JSON.stringify(json, null, 2);
  fs.writeFileSync(PROVIDERS_PATH, modified, "utf8");
  console.log(`[install] providers.jsonc updated (${changes.length} baseURLs changed)`);

  // Print diff
  console.log("\n[install] baseURL changes:");
  for (const c of changes) {
    console.log(`  ${c.name}:`);
    console.log(`    - ${c.old}`);
    console.log(`    + ${c.new}`);
  }

  // Write proxy-config.json
  const proxyConfig = {
    $schema: "mobilework-llm-proxy-config-0.1.0",
    comment: "Auto-generated by install-mobilework-proxy.mjs. MITM reverse proxy routes.",
    port: PROXY_PORT,
    host: PROXY_HOST,
    routes,
  };
  fs.writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(proxyConfig, null, 2), "utf8");
  console.log(`\n[install] proxy-config.json written: ${PROXY_CONFIG_PATH}`);
  console.log(`[install] routes:`);
  for (const r of routes) {
    console.log(`  ${r.path_prefix} → ${r.target}`);
  }

  console.log(`\n[install] ✓ Done. Start the proxy:`);
  console.log(`  node collectors/mobilework-llm-proxy/index.mjs`);
  console.log(`[install] Then restart Mobilework to use the proxy URLs.`);
}

// ── uninstall ───────────────────────────────────────────────────────
function uninstall() {
  if (!fs.existsSync(BAK_PATH)) {
    console.error(`[uninstall] no backup found: ${BAK_PATH}`);
    console.error(`[uninstall] not installed?`);
    process.exit(1);
  }
  fs.copyFileSync(BAK_PATH, PROVIDERS_PATH);
  fs.unlinkSync(BAK_PATH);
  console.log(`[uninstall] providers.jsonc restored from backup`);
  console.log(`[uninstall] ✓ Done. Restart Mobilework to use original URLs.`);
}

// ── status ──────────────────────────────────────────────────────────
function status() {
  const installed = fs.existsSync(BAK_PATH);
  console.log(`[status] installed: ${installed}`);
  console.log(`[status] providers.jsonc: ${PROVIDERS_PATH}`);
  console.log(`[status] backup: ${BAK_PATH}`);
  console.log(`[status] proxy-config: ${PROXY_CONFIG_PATH}`);

  if (fs.existsSync(PROXY_CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, "utf8"));
      console.log(`[status] proxy: http://${cfg.host}:${cfg.port}`);
      console.log(`[status] routes:`);
      for (const r of cfg.routes || []) {
        console.log(`  ${r.path_prefix} → ${r.target}`);
      }
    } catch {
      console.log(`[status] proxy-config: parse error`);
    }
  }

  // Quick check: are baseURLs pointing to proxy?
  if (fs.existsSync(PROVIDERS_PATH)) {
    try {
      const raw = fs.readFileSync(PROVIDERS_PATH, "utf8");
      const json = parseJsonc(raw);
      const provider = json.provider || {};
      let proxied = 0, total = 0;
      for (const [, cfg] of Object.entries(provider)) {
        const b = cfg?.options?.baseURL;
        if (!b) continue;
        total++;
        if (b.includes(`127.0.0.1:${PROXY_PORT}`)) proxied++;
      }
      console.log(`[status] baseURLs: ${proxied}/${total} pointing to proxy`);
    } catch {
      console.log(`[status] providers.jsonc: parse error`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────
const cmd = process.argv[2] || "status";
if (cmd === "install") install();
else if (cmd === "uninstall") uninstall();
else if (cmd === "status") status();
else { console.error("Usage: install-mobilework-proxy.mjs install|uninstall|status"); process.exitCode = 1; }
