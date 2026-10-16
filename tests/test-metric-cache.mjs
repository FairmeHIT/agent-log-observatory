import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('cache replaces an entire metric snapshot and preserves evidence metadata',async()=>{
  const root=path.resolve(import.meta.dirname,'..');
  const runtime=path.join(root,'runtime/tests/metric-cache',randomUUID());
  await fs.mkdir(runtime,{recursive:true});
  const script=`
    import {upsertMetrics,getDBSessionMetrics,closeDB} from './lib/observatory-db.mjs';
    upsertMetrics('synthetic','session',[{metric:'stale',value:999,state:'captured'}]);
    upsertMetrics('synthetic','session',[{metric:'tool_observed_success_rate',value:.5,state:'partial',
      numerator:1,denominator:2,coverage:{eligible:4,observed:4,finished:2},semantic_profile:'known-outcomes',unit:'ratio'}]);
    console.log(JSON.stringify(getDBSessionMetrics('synthetic','session')));
    closeDB();
  `;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{
    cwd:root,windowsHide:true,env:{...process.env,AGENT_LOG_RUNTIME_DIR:runtime},
  });
  const rows=JSON.parse(stdout);assert.equal(rows.length,1);assert.equal(rows[0].metric,'tool_observed_success_rate');
  assert.equal(rows[0].state,'partial');assert.equal(rows[0].denominator,2);assert.equal(rows[0].coverage.eligible,4);
});
