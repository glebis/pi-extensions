import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRun, parseReview, verdict, hash, allowed, invocation } from '../core.mjs';
const good = { ready:true, findings:[], acceptance:true, implementation:true, tests:true };
test('strict review rejects missing criteria and contradictory approval',()=>{
 assert.deepEqual(parseReview(JSON.stringify(good)),good);
 assert.throws(()=>parseReview('{}'));
 assert.throws(()=>parseReview(JSON.stringify({...good,findings:[{severity:'critical',text:'missing auth'}]})));
 assert.throws(()=>parseReview(JSON.stringify({...good,tests:false})));
});
test('quorum never hides critical dissent',()=>{
 assert.equal(verdict([good,good],2),'approved');
 assert.equal(verdict([good,{error:'timeout'}],2),'blocked');
 assert.equal(verdict([good,{...good,ready:false,findings:[{severity:'critical',text:'x'}]}],1),'changes');
});
test('limits and reviewer identities validated',()=>{
 assert.throws(()=>validateRun({rounds:0,minimum:1,reviewers:[{id:'a',kind:'pi',model:'x'}]}));
 assert.throws(()=>validateRun({rounds:3,minimum:2,reviewers:[{id:'a',kind:'pi',model:'x'}]}));
 assert.throws(()=>validateRun({rounds:3,minimum:1,reviewers:[{id:'a',kind:'other'}]}));
});
test('gate invalidates changed bytes, limits write exception to spec',()=>{
 const state={spec:'/p/spec.md',approvedHash:hash('v1')};
 assert.equal(allowed('edit',{path:'/p/code.ts'},state,'v1','/p'),true);
 assert.equal(allowed('edit',{path:'/p/code.ts'},state,'v2','/p'),false);
 assert.equal(allowed('write',{path:'spec.md'},state,'v2','/p'),true);
 assert.equal(allowed('bash',{command:'echo x'},state,'v2','/p'),false);
 assert.equal(allowed('unknown',{},state,'v2','/p'),false);
 assert.equal(allowed('read',{},state,'v2','/p'),true);
});
test('adapters restrict tools and disable recursive Pi extensions',()=>{
 assert.ok(invocation({kind:'pi',model:'provider/model'},false).args.includes('--no-extensions'));
 assert.ok(invocation({kind:'codex',model:'m'},true).args.includes('read-only'));
 assert.ok(invocation({kind:'claude',model:'m'},false).args.includes('--strict-mcp-config'));
});
