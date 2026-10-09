import path from "node:path";
import { config } from "../lib/config.mjs";
console.log(JSON.stringify({root:config.appDirectory,runtime:config.runtimeDirectory,port:config.port,mobilework:process.env.AGENT_LOG_MOBILEWORK_EXE || (config.agents.mobilework.installDir ? path.join(config.agents.mobilework.installDir,"MobileWork.exe") : "")}));
