import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareChartData } from '../lib/chart-data.mjs';
import { redact } from '../lib/redactor.mjs';

const args=process.argv.slice(2),inputs=[];let output,manifest,k=5;
for(let i=0;i<args.length;i++) {
  const flag=args[i],value=args[++i];
  if(flag==='--input'){
    // SOURCE_ID=FILE; explicit IDs let repeated exports share a source namespace.
    const eq=value.indexOf('=');
    const file=eq<0?value:value.slice(eq+1),raw=await fs.readFile(file);
    const hash=crypto.createHash('sha256').update(raw).digest('hex');
    inputs.push({source_id:eq<0?hash:value.slice(0,eq),sha256:hash,data:JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''))});
  }else if(flag==='--output')output=value;
  else if(flag==='--manifest')manifest=JSON.parse((await fs.readFile(value,'utf8')).replace(/^\uFEFF/,''));
  else if(flag==='--k')k=Number(value);
  else throw new Error(`Unknown option: ${flag}`);
}
if(!inputs.length||!output)throw new Error('Usage: node scripts/prepare-chart-data.mjs --input SOURCE_ID=export.json [--input ...] --output chart-data.json [--manifest bindings.json] [--k 5]');
if(manifest&&(!Array.isArray(manifest.bindings)||Object.keys(manifest).some(key=>key!=='bindings')))throw new Error('manifest must contain only a bindings array; see schemas/chart-bindings.schema.json');
const data=prepareChartData(inputs,{bindings:manifest?.bindings || [],k});
data.sources=inputs.map(({source_id,sha256})=>({source_id,sha256}));
await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});
await fs.writeFile(output,JSON.stringify(redact(data),null,2),{flag:'wx'});
console.log(JSON.stringify({output:path.resolve(output),...data.statistics}));
