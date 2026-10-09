// Explicit copy-only migration. Does not delete or overwrite either source or destination records.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCollectorRoot } from "../lib/runtime-paths.mjs";
const source = path.resolve(process.argv[2] || path.join(os.homedir(), ".agent-log-observatory/collectors"));
const dest = getCollectorRoot();
if(source === dest) throw new Error("Source equals destination");
let copied=0, existing=0;
for(const agent of ["opencode","mobilework","doubao"]) {
  const dir=path.join(source,agent);
  if(!fs.existsSync(dir)) continue;
  for(const name of fs.readdirSync(dir)) {
    if(!/^attempts-\d{8}\.jsonl$/.test(name)) continue;
    const target=path.join(dest,agent,name);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    if(fs.existsSync(target)) { existing++; continue; }
    fs.copyFileSync(path.join(dir,name),target,fs.constants.COPYFILE_EXCL); copied++;
  }
}
console.log("Copied " + copied + " files; skipped " + existing + " existing files. Source unchanged.");
