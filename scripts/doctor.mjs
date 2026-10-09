import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { zstdDecompressSync } from "node:zlib";
import { config } from "../lib/config.mjs";
const require = createRequire(import.meta.url);
let failed = false;
function check(name, run) { try { console.log("[OK] " + name + ": " + run()); } catch(e) { failed = true; console.error("[FAIL] " + name + ": " + e.message); } }
check("Node", () => { if(Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Node 24.x required"); return process.version; });
check("Platform", () => { if(process.platform !== "win32" || process.arch !== "x64") throw new Error("This release is validated only on Windows x64"); return "Windows x64"; });
check("Built-ins", () => { if(typeof WebSocket !== "function" || typeof zstdDecompressSync !== "function") throw new Error("WebSocket/zstd missing"); return "WebSocket + zstd"; });
check("Vendored integrity", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../vendor/manifest.json", import.meta.url)));
  for(const entry of manifest.artifacts) {
    const bytes = fs.readFileSync(new URL("../" + entry.file, import.meta.url));
    if(crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Hash mismatch: " + entry.file);
  }
  return manifest.artifacts.length + " SHA-256 checks";
});
check("SQLite CLI", () => { if(!fs.existsSync(config.sqliteExecutable)) throw new Error("Missing executable: " + config.sqliteExecutable); return config.sqliteExecutable; });
check("better-sqlite3", () => { const Database = require("better-sqlite3"); const db = new Database(":memory:"); try { if(db.prepare("SELECT 1 AS ok").get().ok !== 1) throw new Error("Query failed"); } finally { db.close(); } return "native binding loaded + query succeeded"; });
console.log("[INFO] Runtime: " + config.runtimeDirectory);
console.log("[INFO] Collectors: " + config.collectorRoot);
for(const [name, agent] of Object.entries(config.agents)) {
  const source = agent.dataDir || agent.sessionsRoot;
  console.log("[" + (source && fs.existsSync(source) ? "FOUND" : "OPTIONAL") + "] " + name + ": " + (source || "not configured"));
}
if(failed) process.exitCode = 1;
