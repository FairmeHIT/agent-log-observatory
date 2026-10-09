import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../lib/jsonc.mjs';
import { config, resolveConfiguredPath } from '../lib/config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, 'runtime', 'portability-tests');
fs.mkdirSync(scratch, {recursive:true});
const sandbox = fs.mkdtempSync(path.join(scratch, '中文 space-'));
const configFile = path.join(sandbox,'config.json');
const agentDir = path.join(sandbox,'agents');
const outputRoot = path.join(sandbox,'runtime');
fs.mkdirSync(agentDir,{recursive:true});
fs.writeFileSync(configFile,JSON.stringify({port:18976,runtimeDirectory:outputRoot,collectorRoot:path.join(outputRoot,'collectors'),agents:{opencode:{configDir:agentDir},mobilework:{dataDir:agentDir}}}));
let seq=0;
function run(args,extra={}) {
  const output = path.join(sandbox, `child-${seq++}.txt`);
  const fd=fs.openSync(output,'w');
  let result;
  try { result=spawnSync(process.execPath,args,{cwd:sandbox,env:{...process.env,AGENT_LOG_CONFIG:configFile,AGENT_LOG_RUNTIME_DIR:'',AGENT_LOG_COLLECTOR_ROOT:'',...extra},stdio:['ignore',fd,fd],windowsHide:true}); }
  finally {fs.closeSync(fd);}
  if(result.error) throw result.error;
  return {code:result.status,text:fs.readFileSync(output,'utf8')};
}
function script(name,action) {return run([path.join(root,name),...(action ? [action] : [])]);}
// Deliberately leave private test artifacts in ignored runtime; no broad deletion of user paths.

test('JSONC comments/trailing commas do not alter URLs or string commas',()=>{
  const obj=parseJsonc('{/*x*/"url":"https://example.test//a", "text":",}", "a":[1,], // comment\n}');
  assert.deepEqual(obj,{url:'https://example.test//a',text:',}',a:[1]});
});
test('relative and home paths are resolved independent of current cwd',()=>{
  assert.equal(resolveConfiguredPath('runtime/collectors'),path.join(root,'runtime','collectors'));
  assert.equal(resolveConfiguredPath('~/.codex'),path.join(os.homedir(),'.codex'));
  assert.equal(config.timezone,'Asia/Shanghai');
});
test('project URL/path resolution and local JSON settings survive CJK/spaces',()=>{
  const result=script('scripts/paths.mjs'); assert.equal(result.code,0,result.text);
  const obj=JSON.parse(result.text); assert.equal(obj.root,root); assert.equal(obj.port,18976); assert.equal(obj.runtime,outputRoot);
});
test('missing explicit config fails rather than falling back to personal config',()=>{
  const result=run([path.join(root,'scripts/paths.mjs')],{AGENT_LOG_CONFIG:path.join(sandbox,'missing.json')});
  assert.notEqual(result.code,0); assert.match(result.text,/file does not exist/);
});
test('invalid config is reported rather than silently ignored',()=>{
  const bad=path.join(sandbox,'bad.json'); fs.writeFileSync(bad,'{nope');
  const result=run([path.join(root,'scripts/paths.mjs')],{AGENT_LOG_CONFIG:bad});
  assert.notEqual(result.code,0); assert.match(result.text,/Invalid Observatory config/);
});
test('opencode install/status/uninstall backs up and preserves unrelated fields',()=>{
  const file=path.join(agentDir,'opencode.jsonc');
  const original='// keep comment in backup\n{"$schema":"custom", "plugins":["other"], "provider":{"fixture":{"apiKey":"synthetic-key"}}, "permission":{"write":"ask"},}';
  fs.writeFileSync(file,original);
  const install=script('collectors/install-opencode.mjs','install'); assert.equal(install.code,0,install.text);
  assert.equal(fs.readFileSync(file+'.collector.bak','utf8'),original);
  const installed=JSON.parse(fs.readFileSync(file));
  assert.equal(installed.$schema,'custom'); assert.deepEqual(installed.provider,parseJsonc(original).provider);
  assert.equal(installed.plugins.length,2);
  const again=script('collectors/install-opencode.mjs','install'); assert.equal(again.code,0,again.text);
  assert.equal(JSON.parse(fs.readFileSync(file)).plugins.length,2);
  const status=script('collectors/install-opencode.mjs','status'); assert.match(status.text,/plugin installed: true/);
  installed.postInstallSetting=true; fs.writeFileSync(file,JSON.stringify(installed));
  const uninstall=script('collectors/install-opencode.mjs','uninstall'); assert.equal(uninstall.code,0,uninstall.text);
  const restored=JSON.parse(fs.readFileSync(file)); assert.deepEqual(restored.plugins,['other']); assert.equal(restored.postInstallSetting,true);
});
test('Mobilework reverse proxy keeps secrets in client config and restores original bytes',()=>{
  const dir=path.join(agentDir,'config'); fs.mkdirSync(dir,{recursive:true}); const file=path.join(dir,'providers.jsonc');
  const original='// original fixture\n{"provider":{"fixture":{"options":{"baseURL":"http://127.0.0.1:19999/v1", "apiKey":"synthetic-key"},"models":{"fixture":{}}}},}';
  fs.writeFileSync(file,original);
  const result=script('collectors/install-mobilework-proxy.mjs','install'); assert.equal(result.code,0,result.text);
  assert.equal(fs.readFileSync(file+'.llm-proxy-bak','utf8'),original);
  const installed=JSON.parse(fs.readFileSync(file)); assert.equal(installed.provider.fixture.options.apiKey,'synthetic-key');
  assert.equal(installed.provider.fixture.options.baseURL,'http://127.0.0.1:8890/v1');
  const routes=fs.readFileSync(path.join(outputRoot,'mobilework-proxy.json'),'utf8'); assert.ok(!routes.includes('synthetic-key'));
  const reverted=script('collectors/install-mobilework-proxy.mjs','uninstall'); assert.equal(reverted.code,0,reverted.text);
  assert.equal(fs.readFileSync(file,'utf8'),original);
});
test('Mobilework conflicting route prefixes fail BEFORE external writes',()=>{
  const file=path.join(agentDir,'config/providers.jsonc');
  const original=JSON.stringify({provider:{a:{options:{baseURL:'http://127.0.0.1:1111/v1'}},b:{options:{baseURL:'http://127.0.0.1:2222/v1'}}}});
  fs.writeFileSync(file,original);
  const result=script('collectors/install-mobilework-proxy.mjs','install'); assert.notEqual(result.code,0); assert.match(result.text,/Conflicting route prefix/);
  assert.equal(fs.readFileSync(file,'utf8'),original); assert.equal(fs.existsSync(file+'.llm-proxy-bak'),false);
});
test('plugin writes into configured project runtime without recording event body',()=>{
  const pluginUrl=new URL('../collectors/opencode-collector-plugin/index.mjs',import.meta.url).href;
  const code=`import plugin from ${JSON.stringify(pluginUrl)}; const hooks={}; await plugin.setup({session:{hook:async(name,fn)=>{hooks[name]=fn}}}); hooks['http.request']({sessionID:'fixture-session',kind:'primary',request:{body:'DO_NOT_CAPTURE_BODY'}}); hooks['http.response']({sessionID:'fixture-session',kind:'primary',response:{status:200,body:'DO_NOT_CAPTURE_BODY'}});`;
  const result=run(['--input-type=module','-e',code]); assert.equal(result.code,0,result.text);
  const dir=path.join(outputRoot,'collectors/opencode'); const names=fs.readdirSync(dir); assert.equal(names.length,1);
  const data=fs.readFileSync(path.join(dir,names[0]),'utf8'); assert.ok(!data.includes('DO_NOT_CAPTURE_BODY')); assert.equal(JSON.parse(data.trim()).session_id,'fixture-session');
});
test('dependencies resolve to vendored archives, not a registry',()=>{
  const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
  for(const [name,pkg] of Object.entries(lock.packages)) if(name) assert.ok(pkg.resolved.startsWith('file:vendor/npm/'),name);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'vendor/manifest.json'))); assert.equal(manifest.artifacts.length,6);
});
test('launchers no longer terminate clients or unrelated processes by name/port',()=>{
  for(const name of ['启动.cmd','停止.cmd','启动Mobilework.cmd']){
    const text=fs.readFileSync(path.join(root,name),'utf8'); assert.ok(!/taskkill|wmic|D:\\/i.test(text),name); assert.match(text,/services\.ps1/);
  }
  const services=fs.readFileSync(path.join(root,'scripts/services.ps1'),'utf8'); assert.match(services,/-WindowStyle Hidden/); assert.match(services,/Get-OwnedProcess/);
});

test('unsupported HTTPS provider is rejected before client config changes',()=>{
  const file=path.join(agentDir,'config/providers.jsonc');
  const original=JSON.stringify({provider:{fixture:{options:{baseURL:'https://example.test/v1'}}}});
  fs.writeFileSync(file,original);
  const result=script('collectors/install-mobilework-proxy.mjs','install'); assert.notEqual(result.code,0); assert.match(result.text,/only valid HTTP/);
  assert.equal(fs.readFileSync(file,'utf8'),original); assert.equal(fs.existsSync(file+'.llm-proxy-bak'),false);
});
