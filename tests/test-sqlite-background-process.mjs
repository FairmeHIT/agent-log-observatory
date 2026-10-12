import {test} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import {querySqlite} from '../lib/sqlite-query.mjs';

function fakeSqlite(t, contents) {
 const calls=[];
 t.mock.method(childProcess,'spawn',(exe,args,options)=>{
  calls.push({exe,args,options});
  const file=args.find(x=>x.startsWith('.output "')).slice(9,-1);
  fs.writeFileSync(file,contents[calls.length-1]);
  const child=new EventEmitter();queueMicrotask(()=>child.emit('close',0));return child;
 });
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 return calls;
}
function assertSilent(calls){
 assert.ok(calls.length);
 for(const call of calls){assert.equal(call.options.windowsHide,true);assert.equal(call.options.stdio,'ignore');assert.equal(call.args[0],'-readonly');}
}
test('SQLite JSON query hides the CLI window and preserves read-only data',async t=>{
 const calls=fakeSqlite(t,['[{"value":7}]']);
 assert.deepEqual(await querySqlite('fixture-sqlite','fixture-db','SELECT value FROM fixture'),[{value:7}]);
 assert.equal(calls.length,1);assertSilent(calls);
});
test('SQLite list fallback also hides every CLI window',async t=>{
 const calls=fakeSqlite(t,['broken JSON','7\x1ffixture\n']);
 assert.deepEqual(await querySqlite('fixture-sqlite','fixture-db','SELECT value, name FROM fixture'),[{value:7,name:'fixture'}]);
 assert.equal(calls.length,2);assertSilent(calls);
});
