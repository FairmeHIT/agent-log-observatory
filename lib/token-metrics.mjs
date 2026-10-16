import {makeMetricResult} from './evidence.mjs';

const fields=['input','output','reasoning','cache_read','cache_write'];
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export function usageTotal(r) {
  if(finite(r.reported_total))return r.reported_total;
  if(!finite(r.input)||!finite(r.output)||typeof r.input_includes_cache!=='boolean')return null;
  let total=r.input+r.output;
  if(!r.input_includes_cache) {
    if(!finite(r.cache_read))return null;
    total+=r.cache_read;
    if(r.cache_write>0) {
      if(r.cache_write_accounting!=='exclusive')return null;
      total+=r.cache_write;
    }
  }
  if(r.reasoning>0) {
    if(typeof r.output_includes_reasoning!=='boolean')return null;
    if(!r.output_includes_reasoning)total+=r.reasoning;
  }
  return finite(total)?total:null;
}

// Prefer session summaries over overlapping attempt records and preserve true
// zeroes. Unknown inclusion flags never authorize cache/reasoning arithmetic.
export function computeTokenMetrics(records,sessionId) {
  const matching=(records||[]).filter(r=>r.session_id!=null?r.session_id===sessionId&&(r.scope!=='session'||r.scope_id==null||r.scope_id===sessionId):r.scope_id==null||r.scope_id===sessionId);
  const session=matching.filter(r=>r.scope==='session');
  const candidates=session.length?session:matching;
  const unique=new Map();let conflicts=0;
  for(const [i,r] of candidates.entries()) {
    const key=r.usage_record_id??`row-${i}`,prior=unique.get(key);
    if(prior&&JSON.stringify(prior)!==JSON.stringify(r)){unique.set(key,{usage_record_id:key});conflicts++;}
    else if(!prior)unique.set(key,r);
  }
  const rows=[...unique.values()];
  const profiles=[...new Set(rows.map(r=>[r.input_includes_cache??'unknown',r.output_includes_reasoning??'unknown',r.cache_write_accounting??'unknown'].join('_')))];
  const base={unit:'tokens',scope:'session',scope_id:sessionId,comparable:false,
    source_refs:[{source_id:'adapter-usage',source_kind:'usage',rule_version:'token-accounting-1.0'}]};
  const result=(name,values,profile,grade)=>{
    const valid=values.filter(finite),value=valid.length?valid.reduce((s,v)=>s+v,0):null;
    const partial=valid.length<rows.length||conflicts>0;
    return makeMetricResult(name,value,{...base,evidence_grade:value===null?'unknown':grade,
      state:value===null?'not-captured':partial?'partial':'captured',
      missing_reason:value===null?(rows.length?'semantic_unknown':'not_instrumented'):partial?'partial_capture':null,
      semantic_profile:profile,coverage:{eligible:rows.length,observed:valid.length,finished:valid.length}});
  };
  const metrics=fields.map(f=>result('token_'+f,rows.map(r=>r[f]),`source_${f}_${profiles.length===1?profiles[0]:'mixed'}`,'direct'));
  const totals=rows.map(usageTotal);
  const total=result('token_total',totals,rows.every(r=>finite(r.reported_total))?'source_reported_total':`normalized_total_${profiles.length===1?profiles[0]:'mixed'}`,'derived');
  // Partial totals systematically understate consumption; only components may
  // expose observed partial sums. The full session total must remain unknown.
  if(totals.some(v=>v===null)||conflicts){total.value=null;total.state='not-captured';total.evidence_grade='unknown';total.missing_reason='semantic_unknown';}
  return [...metrics,total];
}
