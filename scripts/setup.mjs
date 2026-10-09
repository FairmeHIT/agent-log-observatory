import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node.js 24.x with npm (tested: 24.19.0).");
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
if (!fs.existsSync(npm)) throw new Error("npm CLI not found beside node. Run this script with npm run setup, or install Node with npm.");
const result = spawnSync(process.execPath, [npm, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(root, "runtime/npm-cache")], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
if (!process.argv.includes("--dependencies-only")) {
  const target = path.join(root, "agent-log-observatory.config.json");
  if (!fs.existsSync(target) && !fs.existsSync(target + "c")) fs.copyFileSync(path.join(root, "agent-log-observatory.config.example.json"), target);
}
await import("./doctor.mjs");
