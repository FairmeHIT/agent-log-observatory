// Explicit read-only sampling service for historical evidence recovery. No DB
// cache sync, timers, collectors, client control or model requests.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {readSessionMetrics} from '../lib/session-metrics-read.mjs';
import {redact,whitelistFilter} from '../lib/redactor.mjs';
import {WorkBuddyAdapter} from '../adapters/workbuddy-adapter.mjs';
import {MobileworkAdapter} from '../adapters/mobilework-adapter.mjs';
import {TeleAgentAdapter} from '../adapters/teleagent-adapter.mjs';
import {DoubaoAdapter} from '../adapters/doubao-adapter.mjs';
import {DshAdapter} from '../adapters/dsh-adapter.mjs';
import {CodexAdapter} from '../adapters/codex-adapter.mjs';
import {OpencodeAdapter} from '../adapters/opencode-adapter.mjs';

export function createSessionEvidenceServer(){
  const adapters={workbuddy:new WorkBuddyAdapter(),mobilework:new MobileworkAdapter(),teleagent:new TeleAgentAdapter(),doubao:new DoubaoAdapter(),dsh:new DshAdapter(),codex:new CodexAdapter(),opencode:new OpencodeAdapter()};
  return createServer(async(req,res)=>{
    const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(redact(whitelistFilter(data))));};
    if(req.method!=='GET'||!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress))return reply(403,{error:'read_only_loopback'});
    const url=new URL(req.url,'http://127.0.0.1'),m=/^\/api\/sessions\/([a-z]+)\/default\/([A-Za-z0-9_-]+)(\/metrics)?$/.exec(url.pathname);
    if(!m||!adapters[m[1]])return reply(404,{error:'not_found'});
    try{
      const adapter=adapters[m[1]],id=m[2];
      if(m[3])return reply(200,await readSessionMetrics(adapter,id,{fresh:true}));
      const result=await adapter.extractSessions({session_id:id,limit:20000});
      const session=result.items?.find(s=>s.session_id===id);
      if(!session)return reply(404,{error:'not_found'});
      // Only identity/model metadata crosses this endpoint, no titles/content.
      return reply(200,Object.fromEntries(['session_id','agent_object','model','provider','agent_version','adapter_version'].map(k=>[k,session[k]??null])));
    }catch{return reply(503,{error:'source_read_failed'});}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createSessionEvidenceServer();server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,read_only:true})));
}
