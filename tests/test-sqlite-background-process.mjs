import {test} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
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
test('malformed JSON fails explicitly without a lossy list fallback',async t=>{
 const calls=fakeSqlite(t,['broken JSON']);
 await assert.rejects(querySqlite('fixture-sqlite','fixture-db','SELECT value, name FROM fixture'),{code:'SQLITE_INVALID_JSON'});
 assert.equal(calls.length,1);assertSilent(calls);
});
test('nonzero SQLite exit cannot masquerade as an empty successful query',async t=>{
 const calls=fakeSqlite(t,['[]']);
 t.mock.restoreAll();syncBuiltinESMExports();
 t.mock.method(childProcess,'spawn',()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('close',1));return child;});syncBuiltinESMExports();
 await assert.rejects(querySqlite('fixture-sqlite','fixture-db','SELECT value FROM absent'),{code:'SQLITE_READ_ERROR'});
});

test('native read-only fallback preserves embedded newlines, delimiters and SQL null without changing DB bytes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'obs-readonly-')),file=path.join(dir,'source.db');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const db=new DatabaseSync(file);db.exec('CREATE TABLE fixture(value TEXT, optional TEXT)');
 const value='中文\nline\x1fdelimiter "quote"';db.prepare('INSERT INTO fixture VALUES (?,NULL)').run(value);db.close();
 const before=fs.readFileSync(file),calls=fakeSqlite(t,['broken JSON']);
 assert.deepEqual((await querySqlite('fixture-sqlite',file,'SELECT value, optional FROM fixture')).map(r=>({...r})),[{value,optional:null}]);
 assert.deepEqual(fs.readFileSync(file),before);assert.equal(calls.length,1);assertSilent(calls);
});
