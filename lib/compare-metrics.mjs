import { percentile } from './metrics.mjs';

export function aggregateForCompare(sessions, names = []) {
  const metrics = {};
  for(const name of new Set([...names,...sessions.flatMap(s=>Object.keys(s.metrics))])) {
    const rows=sessions.map(s=>s.metrics[name]);
    const complete=rows.filter(m=>m?.state==='captured'&&Number.isFinite(m.value));
    const partial=rows.filter(m=>m?.state==='partial'&&Number.isFinite(m.value));
    const units=new Set(complete.map(m=>m.unit ?? null));
    const profiles=new Set(complete.map(m=>m.semantic_profile ?? null));
    const compatible=units.size<=1&&profiles.size<=1;
    const values=compatible?complete.map(m=>m.value):[];
    const ratio=name.endsWith('_rate')||name.endsWith('_coverage');
    const hasWeights=complete.length>0&&complete.every(m=>Number.isFinite(m.numerator)&&Number.isFinite(m.denominator)&&m.denominator>=0);
    const numerator=hasWeights?complete.reduce((a,m)=>a+m.numerator,0):null;
    const denominator=hasWeights?complete.reduce((a,m)=>a+m.denominator,0):null;
    const p50=percentile(values,50),p95=percentile(values,95);
    metrics[name]={captured:complete.length,partial:partial.length,
      not_captured:rows.length-complete.length-partial.length,
      sum:values.length&&!ratio?values.reduce((a,b)=>a+b,0):null,
      avg:values.length?(ratio&&hasWeights?(denominator?numerator/denominator:null):values.reduce((a,b)=>a+b,0)/values.length):null,
      aggregation:ratio&&hasWeights?'pooled_known_outcomes':'session_mean',numerator,denominator,
      p50:p50.value,p95:p95.value,p50_comparable:compatible&&complete.every(m=>m.comparable===true)&&p50.comparable,
      p95_comparable:compatible&&complete.every(m=>m.comparable===true)&&p95.comparable,
      unit:units.size===1?[...units][0]:null,semantic_profiles:[...profiles],
      missing_reason:compatible?(values.length?null:'not_captured'):'mixed_units_or_semantics'};
  }
  return {session_count:sessions.length,metrics};
}
