// Private metadata only: never copies credentials, prompts, client configs or Agent binaries.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../lib/config.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";
import { runtimePath } from "../lib/runtime-paths.mjs";
const pluginDir=path.join(config.appDirectory,"collectors/opencode-collector-plugin");
const oc=["opencode.jsonc","opencode.json"].map(n=>path.join(config.agents.opencode.configDir,n)).find(p=>fs.existsSync(p)) || path.join(config.agents.opencode.configDir,"opencode.jsonc");
let refs=[];
if(fs.existsSync(oc)) refs=(parseJsonc(fs.readFileSync(oc,"utf8")).plugins || []).map(p=>typeof p === "string" ? p : p.package).filter(Boolean);
const known=refs.filter(p=>p.includes("opencode-collector-plugin"));
const hash = file => fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
const report={date:new Date().toISOString(),node:process.version,opencode:{configExists:fs.existsSync(oc),collectorReferences:known,canonical:pluginDir,files:known.map(p=>({path:p,entrySha256:hash(path.join(p,"index.mjs")),matchesCanonical:hash(path.join(p,"index.mjs"))===hash(path.join(pluginDir,"index.mjs"))})),backupExists:fs.existsSync(oc+".collector.bak")},mobilework:{reverseProxyBackupExists:fs.existsSync(path.join(config.agents.mobilework.dataDir,"config/providers.jsonc.llm-proxy-bak"))},legacyCollectorRootExists:fs.existsSync(path.join(os.homedir(),".agent-log-observatory/collectors"))};
const out=runtimePath("private/local-installation.json"); fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2)); console.log("Private report: " + out);
