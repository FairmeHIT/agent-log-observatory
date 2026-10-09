import fs from "node:fs";
import path from "node:path";
import { config, resolveConfiguredPath } from "./config.mjs";
export function getRuntimeDirectory() {
  return resolveConfiguredPath(process.env.AGENT_LOG_RUNTIME_DIR || config.runtimeDirectory);
}
export function getCollectorRoot() {
  return resolveConfiguredPath(process.env.AGENT_LOG_COLLECTOR_ROOT || config.collectorRoot);
}
export function runtimePath(...parts) { return path.join(getRuntimeDirectory(), ...parts); }
export function tempPath(name) {
  const dir = runtimePath("tmp");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
