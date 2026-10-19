import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewerOptions,uniqueReviewers,parseCommandArgs,withDefaultModels,DEFAULT_MODELS} from '../selection.mjs';
import {validateRun,invocation} from '../core.mjs';
test('requested reviewer defaults',()=>{
 assert.equal(DEFAULT_MODELS.pi,'openai-codex/gpt-6.1-sol');
 assert.equal(DEFAULT_MODELS.claude,'sonnet5.5');
 assert.deepEqual(invocation(withDefaultModels([{kind:'claude'}])[0],false).args.slice(-2),['--model','sonnet5.5']);
});
test('new reviewer defaults are explicit, preserve overrides and do not mutate inputs',()=>{
 const rows=[{id:'a',kind:'pi'},{id:'b',kind:'codex',model:' '},{id:'c',kind:'claude',model:null},{id:'d',kind:'pi',model:'custom/model'}];
 const result=withDefaultModels(rows);
 assert.deepEqual(result.map(r=>r.model),[DEFAULT_MODELS.pi,DEFAULT_MODELS.codex,DEFAULT_MODELS.claude,'custom/model']);
 assert.equal(rows[0].model,undefined);
 for(const r of result)assert.ok(invocation(r,false).args.includes(r.model));
 assert.equal(uniqueReviewers([{kind:'pi'},{kind:'pi',model:DEFAULT_MODELS.pi}]).length,1);
});
test('command accepts plain and quoted paths without JSON parsing',()=>{
 assert.deepEqual(parseCommandArgs(''),{kind:'panel'});
 assert.deepEqual(parseCommandArgs(' /Users/gleb/my spec.md '),{kind:'path',spec:'/Users/gleb/my spec.md'});
 assert.deepEqual(parseCommandArgs('"/Users/gleb/my spec.md"'),{kind:'path',spec:'/Users/gleb/my spec.md'});
 assert.deepEqual(parseCommandArgs('{"spec":"spec.md","rounds":2}'),{kind:'json',request:{spec:'spec.md',rounds:2}});
 assert.throws(()=>parseCommandArgs('{bad'),/Invalid review options JSON/);
});
test('reviewer choices filter invalid data, normalize, deduplicate, generate IDs',()=>{
 const config={presets:{a:{reviewers:[{id:'same',kind:'codex',model:' alpha '},{id:'same',kind:'codex',model:'alpha'},{kind:'bad',model:'beta'},{kind:'pi',model:''},{kind:'claude',model:'REPLACE_WITH_CLAUDE_MODEL'},{id:'same',kind:'claude',model:'beta'}]}}};
 const options=reviewerOptions(config,[{provider:'provider',id:'model'},{provider:'provider',id:'model'}]);
 assert.equal(options.length,6);
 const selected=uniqueReviewers([...options,...options]);
 assert.equal(selected.length,6);
 assert.equal(new Set(selected.map(r=>r.id)).size,6);
 assert.doesNotThrow(()=>validateRun({reviewers:selected,minimum:6,rounds:1}));
});
test('agent default model is valid and never passes an empty --model flag',()=>{
 for(const kind of ['pi','codex','claude'])for(const model of [undefined,null,'','   ']) {
  const reviewer={id:'a',kind,model};
  assert.doesNotThrow(()=>validateRun({rounds:1,minimum:1,reviewers:[reviewer]}));
  assert.equal(invocation(reviewer,false).args.includes('--model'),false);
 }
 assert.equal(invocation({kind:'codex'},false).args.includes('--ignore-user-config'),false,'honor CLI configured default');
 assert.throws(()=>validateRun({rounds:1,minimum:1,reviewers:[{id:'a',kind:'codex'},{id:'b',kind:'codex',model:' '}]}),/Duplicate reviewer model/);
});
test('JSON configuration cannot duplicate same engine/model under different IDs',()=>{
 assert.throws(()=>validateRun({rounds:1,minimum:1,reviewers:[{id:'a',kind:'pi',model:'p/m'},{id:'b',kind:'pi',model:' p/m '}]}),/Duplicate reviewer model/);
});
