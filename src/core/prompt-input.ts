import type {Snapshot} from './models.js';
/** Optional, measurable context reduction; all numeric observations and deterministic limits survive. */
export function compactSnapshot(input:Snapshot):Snapshot {
  const s=structuredClone(input);
  s.data_limitations=[...new Set(s.data_limitations)];
  if(s.experience){
    const before=JSON.stringify(s.experience).length;
    s.experience.observations=s.experience.observations.map(o=>({...o,note:o.note.slice(0,160)}));
    s.experience.reviews=s.experience.reviews.slice(-1).map(r=>({...r,summary:r.summary.slice(0,500)}));
    s.experience.limitations=[...new Set(s.experience.limitations),`提示壓縮已截短歷史備註與檢討；保留所有數值成交欄位。原經驗字元 ${before}`];
  }
  return s;
}

/** Lossless table encoding: reduce repeated field names, not observation precision or required risk data. */
export function tableContext(input:Snapshot):Record<string,unknown>{
  const result:Record<string,unknown>={...input};
  for(const key of ['features','instruments'] as const){
    const rows=Object.entries(input[key]??{}),columns=[...new Set(rows.flatMap(([,v])=>Object.keys(v)))].sort();
    result[key]={encoding:'columns-and-rows-v1',columns:['symbol',...columns],rows:rows.map(([symbol,v])=>[symbol,...columns.map(c=>Object.hasOwn(v,c)?(v as unknown as Record<string,unknown>)[c]:null)])};
  }
  return result;
}
