// Explicit allowlist: ignores local settings, history, generated output and node_modules.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const packageInfo=JSON.parse(fs.readFileSync(path.join(root,"package.json")));
const out=path.join(root,"releases","agent-log-observatory-"+packageInfo.version);
if(fs.existsSync(out)) throw new Error("Release directory exists; preserve/archive it before exporting again: "+out);
const files=["AGENTS.md","README.md","SPEC.md","LICENSE","需求文档.md","版本迭代说明.md","THIRD_PARTY_NOTICES.md",".gitignore","package.json","package-lock.json","agent-log-observatory.config.example.json","server.mjs","index.html","启动.cmd","停止.cmd","启动Mobilework.cmd","runtime/sqlite3.exe","runtime/README.md","releases/README.md","docs/deployment.md","docs/dependency-inventory.md","docs/collector-design.md"];
const denied=new Set(["collectors/mobilework-llm-proxy/proxy-config.json"]);
function collect(dir) {
  for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})) {
    const name=dir+"/"+entry.name;
    if(entry.isSymbolicLink()) throw new Error("Symlink excluded: "+name);
    if(entry.isDirectory()) collect(name);
    else if(!denied.has(name) && !/\.(bak|llm-proxy-bak)$/.test(name)) files.push(name);
  }
}
for(const dir of ["adapters","lib","schemas","tests","scripts","collectors","vendor"]) collect(dir);
const manifest=[];
for(const file of files.sort()) {
  const from=path.join(root,file), to=path.join(out,file);
  if(fs.lstatSync(from).isSymbolicLink()) throw new Error("Symlink excluded: "+file);
  fs.mkdirSync(path.dirname(to),{recursive:true}); fs.copyFileSync(from,to);
  manifest.push({file,sha256:crypto.createHash("sha256").update(fs.readFileSync(to)).digest("hex")});
}
fs.writeFileSync(path.join(out,"release-manifest.json"),JSON.stringify({version:packageInfo.version,files:manifest},null,2));
console.log("Exported "+manifest.length+" files: "+out);
console.log("Private data excluded. Review source/fixture redaction and choose a project license before publishing.");
