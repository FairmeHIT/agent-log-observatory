// Adapter source reads are read-only, bounded, and fail explicitly. Delimited
// fallbacks corrupt multiline text/nulls and cannot establish a valid snapshot.
import {spawn} from 'node:child_process';
import {tempPath} from './runtime-paths.mjs';
import fs from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
let seq=0;
const fault=code=>Object.assign(new Error('SQLite source read failed: '+code),{code});
function run(sqliteExe,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(sqliteExe,args,{stdio:'ignore',windowsHide:true});
    const timer=setTimeout(()=>{child.kill();reject(fault('SQLITE_READ_TIMEOUT'));},10000);
    child.once('error',()=>{clearTimeout(timer);reject(fault('SQLITE_SPAWN_ERROR'));});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(fault('SQLITE_READ_ERROR'));});
  });
}
export async function querySqlite(sqliteExe,dbPath,sql) {
  if(!sqliteExe||!dbPath||!sql)throw fault('SQLITE_SOURCE_UNAVAILABLE');
  const file=tempPath(`source-sql-${process.pid}-${seq++}-${Date.now()}.json`);
  try {
    await run(sqliteExe,['-readonly',dbPath,'.timeout 2000','.mode json',`.output "${file.replace(/\\/g,'/')}"`,sql,'.output stdout']);
    const text=await fs.readFile(file,'utf8');
    if(!text.trim())return [];
    let rows;try{rows=JSON.parse(text);}catch{
      // Some CLI JSON output from native clients is malformed. Read the same
      // query through Node's built-in SQLite in read-only mode; never split
      // text into delimiter rows or silently invent an empty successful read.
      let db;
      try{db=new DatabaseSync(dbPath,{readOnly:true,timeout:2000});rows=db.prepare(sql).all();}
      catch{throw fault('SQLITE_INVALID_JSON');}
      finally{db?.close();}
    }
    if(!Array.isArray(rows)||rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw fault('SQLITE_INVALID_JSON');
    return rows;
  } finally {await fs.unlink(file).catch(()=>{});}
}
