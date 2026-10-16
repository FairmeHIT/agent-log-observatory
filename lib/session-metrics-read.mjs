// Explicit read-only fresh sampling bypasses a mutable dashboard cache. It does
// not sync the DB, install collectors or send an Agent/model request.
export async function readSessionMetrics(adapter,sessionId,{fresh=false,readCache}={}) {
  if(!fresh&&readCache)try {
    const items=readCache(sessionId);
    if(items?.length)return {items,source:'db',fresh:false};
  }catch{}
  if(!adapter.extractMetrics)return {items:[],source:'unavailable',fresh};
  return {items:await adapter.extractMetrics(sessionId),source:'live',fresh};
}
