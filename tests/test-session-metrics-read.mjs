import test from 'node:test';
import assert from 'node:assert/strict';
import {readSessionMetrics} from '../lib/session-metrics-read.mjs';
test('fresh read bypasses stale cache without syncing or modifying it; old requests retain cache behavior',async()=>{
 let reads=0,cacheReads=0;const cached=[{metric:'token_total',value:1}],live=[{metric:'token_total',value:2}];
 const adapter={extractMetrics:async sid=>{assert.equal(sid,'session-fixture');reads++;return live;}};
 const readCache=()=>{cacheReads++;return cached;};
 assert.deepEqual(await readSessionMetrics(adapter,'session-fixture',{readCache}),{items:cached,source:'db',fresh:false});assert.equal(reads,0);
 assert.deepEqual(await readSessionMetrics(adapter,'session-fixture',{fresh:true,readCache}),{items:live,source:'live',fresh:true});assert.equal(cacheReads,1);assert.equal(cached[0].value,1);
});
test('cache faults fall back to read-only adapter extraction, and missing extraction stays empty',async()=>{
 assert.equal((await readSessionMetrics({extractMetrics:async()=>[]},'sid',{readCache:()=>{throw Error('locked');}})).source,'live');
 assert.deepEqual(await readSessionMetrics({},'sid',{fresh:true}),{items:[],source:'unavailable',fresh:true});
});
