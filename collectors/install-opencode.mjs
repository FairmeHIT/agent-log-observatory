// collectors/install-opencode.mjs
//
// 安装/卸载 opencode-collector-plugin 到 ~/.config/opencode/opencode.jsonc
//
// 用法：
//   node collectors/install-opencode.mjs install    # 安装（备份原文件 + 加 plugin 引用）
//   node collectors/install-opencode.mjs uninstall  # 卸载（移除 plugin 引用，恢复备份）
//   node collectors/install-opencode.mjs status      # 查看当前状态
//
// 约束：
// - 备份原文件到 opencode.jsonc.collector.bak（首次安装时）
// - 不触碰 providers/models/permissions 等其他配置
// - plugin 路径用绝对路径引用，指向本仓库 collectors/opencode-collector-plugin

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../lib/config.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "opencode-collector-plugin");

const OC_CONFIG_DIR = config.agents.opencode.configDir;
const OC_CONFIG = ["opencode.jsonc", "opencode.json"].map(name => path.join(OC_CONFIG_DIR, name)).find(file => fs.existsSync(file)) || path.join(OC_CONFIG_DIR, "opencode.jsonc");
const OC_BACKUP = OC_CONFIG + ".collector.bak";

function readConfig() {
  if (!fs.existsSync(OC_CONFIG)) {
    throw new Error(`opencode.jsonc not found at ${OC_CONFIG}`);
  }
  const raw = fs.readFileSync(OC_CONFIG, "utf8");
  const json = raw;
  return { raw, parsed: parseJsonc(json) };
}

function writeConfig(obj) {
  // Preserve the existing schema and every unrelated configuration field.
  fs.writeFileSync(OC_CONFIG, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function pluginAlreadyListed(plugins) {
  if (!Array.isArray(plugins)) return false;
  return plugins.some((p) => {
    if (typeof p === "string") return p === PLUGIN_DIR;
    if (p && typeof p === "object" && typeof p.package === "string")
      return p.package === PLUGIN_DIR;
    return false;
  });
}

function install() {
  if (!fs.existsSync(PLUGIN_DIR)) {
    throw new Error(`plugin dir not found: ${PLUGIN_DIR}`);
  }
  const { raw, parsed } = readConfig();
  // 首次安装备份
  if (!fs.existsSync(OC_BACKUP)) {
    fs.writeFileSync(OC_BACKUP, raw, "utf8");
    console.log(`[install] backed up original config → ${OC_BACKUP}`);
  } else {
    console.log(`[install] backup already exists → ${OC_BACKUP} (not overwritten)`);
  }
  const listed = pluginAlreadyListed(parsed.plugins);
  if (listed) {
    console.log(`[install] plugin already listed in opencode.jsonc, nothing to do`);
    return;
  }
  parsed.plugins = Array.isArray(parsed.plugins) ? [...parsed.plugins, PLUGIN_DIR] : [PLUGIN_DIR];
  writeConfig(parsed);
  console.log(`[install] added plugin reference to opencode.jsonc`);
  console.log(`[install]   path = ${PLUGIN_DIR}`);
  console.log(`[install] restart opencode service: opencode service restart`);
}

function uninstall() {
  if (!fs.existsSync(OC_CONFIG)) {
    console.log(`[uninstall] no config at ${OC_CONFIG}`);
    return;
  }
  const { parsed } = readConfig();
  if (Array.isArray(parsed.plugins)) {
    parsed.plugins = parsed.plugins.filter((p) => {
      if (typeof p === "string") return p !== PLUGIN_DIR;
      if (p && typeof p === "object") return p.package !== PLUGIN_DIR;
      return true;
    });
    if (parsed.plugins.length === 0) delete parsed.plugins;
  }
  writeConfig(parsed);
  console.log(`[uninstall] removed plugin reference from opencode.jsonc`);
  if (fs.existsSync(OC_BACKUP)) {
    console.log(`[uninstall] original backup preserved at ${OC_BACKUP}`);
    console.log(`[uninstall] to fully restore: copy ${OC_BACKUP} → ${OC_CONFIG}`);
  }
  console.log(`[uninstall] restart opencode service: opencode service restart`);
}

function status() {
  if (!fs.existsSync(OC_CONFIG)) {
    console.log(`[status] no config at ${OC_CONFIG}`);
    return;
  }
  const { parsed } = readConfig();
  const listed = pluginAlreadyListed(parsed.plugins);
  console.log(`[status] plugin installed: ${listed}`);
  console.log(`[status] plugin path: ${PLUGIN_DIR}`);
  console.log(`[status] plugin dir exists: ${fs.existsSync(PLUGIN_DIR)}`);
  console.log(`[status] backup exists: ${fs.existsSync(OC_BACKUP)}`);

}

const cmd = process.argv[2] || "status";
try {
  if (cmd === "install") install();
  else if (cmd === "uninstall") uninstall();
  else if (cmd === "status") status();
  else throw new Error("Usage: install-opencode.mjs install|uninstall|status");
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
