export function parseCommandArgs(args) {
 const text=args.trim();
 if(!text)return {kind:'panel'};
 if(text.startsWith('{')) {
  try{return {kind:'json',request:JSON.parse(text)};}
  catch{throw Error('Invalid review options JSON. Pass a specification path or a JSON object.');}
 }
 const quoted=(text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"));
 const spec=quoted?text.slice(1,-1):text;
 if(!spec.trim())throw Error('Specification path cannot be empty');
 return {kind:'path',spec};
}
export const DEFAULT_MODELS=Object.freeze({pi:'openai-codex/gpt-6.1-sol',codex:'gpt-6.1-sol',claude:'sonnet5.5'});
export function withDefaultModels(rows) {
 return Array.isArray(rows)?rows.map(r=>r && DEFAULT_MODELS[r.kind] && (r.model==null || (typeof r.model==='string' && !r.model.trim()))?{...r,model:DEFAULT_MODELS[r.kind]}:r):rows;
}
const kinds = new Set(['pi','codex','claude']);
export const reviewerKey = r => JSON.stringify([r.kind,typeof r.model==='string'?r.model.trim():'']);
export function uniqueReviewers(rows) {
 const seen=new Set();const result=[];
 for(const row of Array.isArray(rows)?withDefaultModels(rows):[]) {
  if(!row || !kinds.has(row.kind) || (row.model!=null && typeof row.model!=='string'))continue;
  const model=row.model?.trim() ?? '';
  if(/\s/.test(model) || /REPLACE_WITH|PLACEHOLDER|<[^>]*>/i.test(model))continue;
  const key=reviewerKey({...row,model});
  if(seen.has(key))continue;
  seen.add(key);result.push({id:`reviewer-${result.length+1}`,kind:row.kind,model});
 }
 return result;
}
export function reviewerOptions(config,available=[]) {
 const saved=Object.values(config.presets ?? {}).flatMap(p=>Array.isArray(p?.reviewers)?p.reviewers:[]);
 return uniqueReviewers([...['pi','codex','claude'].map(kind=>({kind})),...saved,...available.filter(m=>typeof m?.provider==='string' && typeof m?.id==='string').map(m=>({kind:'pi',model:`${m.provider}/${m.id}`}))]);
}
