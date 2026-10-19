import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
// Resolve Pi from PI_TEST_HOST or locally installed CLI. No model calls.
import {execFileSync} from 'node:child_process';
const host=process.env.PI_TEST_HOST ?? resolve(execFileSync('which',['pi'],{encoding:'utf8'}).trim(),'..','..','lib/node_modules/@earendil-works/pi-coding-agent');
const {loadExtensions}=await import(pathToFileURL(join(host,'dist/core/extensions/loader.js')));
test('host loads extension; round approval, invalidation, limit, artifacts, restore',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spec-review-test-'));
 const oldPath=process.env.PATH;
 try {
  const loaded=await loadExtensions([resolve('index.ts')],root);
  assert.deepEqual(loaded.errors,[]);
  const ext=loaded.extensions[0];
  await mkdir(join(root,'.pi'));await mkdir(join(root,'bin')); 
  await writeFile(join(root,'spec.md'),'requirements v1');
  await writeFile(join(root,'.pi/spec-review.json'),JSON.stringify({defaultPreset:'test',presets:{test:{reviewers:[{id:'r',kind:'codex',model:'fake'}],minimum:1}}}));
  await writeFile(join(root,'bin/codex'),'#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({ready:true,acceptance:true,implementation:true,tests:true,findings:[]})));',{mode:0o700});
  process.env.PATH=join(root,'bin')+':'+oldPath;
  // Bind only host actions used by commands. Actual registry and event handlers
  // come from Pi loader, process execution uses real fake CLI binary.
  loaded.runtime.sendUserMessage=()=>{};
  const entries=[];
  loaded.runtime.appendEntry=(customType,data)=>entries.push({type:'custom',customType,data:structuredClone(data)});
  const ctx={cwd:root,hasUI:true,ui:{setStatus(){},notify(){},confirm:async()=>false},sessionManager:{getBranch:()=>entries}};
  const command=ext.commands.get('spec-review');
  const gate=ext.handlers.get('tool_call')[0];
  const originalConfig=await readFile(join(root,'.pi/spec-review.json'),'utf8');
  await writeFile(join(root,'.pi/spec-review.json'),'{"autoSpec":"missing.md"}');
  await ext.handlers.get('session_start')[0]({},ctx);
  assert.equal((await gate({toolName:'bash',input:{}},ctx))?.block,true,'Missing autoSpec must fail closed');
  await writeFile(join(root,'.pi/spec-review.json'),originalConfig);
  await command.handler('{"spec":"spec.md","rounds":1,"context":[]}',ctx);
  assert.equal((await gate({toolName:'bash',input:{command:'echo mutation'}},ctx)).block,true);
  const tool=ext.tools.get('spec_review_round').definition;
  const answer=await tool.execute('t',{},undefined,undefined,ctx);
  assert.equal(answer.details.status,'approved');
  assert.equal(await gate({toolName:'write',input:{path:'code.ts'}},ctx),undefined);
  assert.equal(JSON.parse(await readFile(join(answer.details.artifacts,'report.json'),'utf8')).status,'approved');
  await writeFile(join(root,'spec.md'),'requirements v2');
  assert.equal((await gate({toolName:'write',input:{path:'code.ts'}},ctx)).block,true);
  await assert.rejects(tool.execute('t',{},undefined,undefined,ctx),/Round limit/);
  await ext.handlers.get('session_start')[0]({},ctx);
  assert.equal((await gate({toolName:'bash',input:{}},ctx)).block,true);
  await writeFile(join(root,'bin/codex'),'#!/usr/bin/env node\nlet s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{const ready=s.includes("PEER DISCUSSION:");console.log(JSON.stringify({ready,acceptance:true,implementation:true,tests:true,findings:ready?[]:[{severity:"critical",text:"Clarify auth"}]}));});',{mode:0o700});
  await command.handler('{"spec":"spec.md","rounds":2}',ctx);
  const discussed=await tool.execute('d',{},undefined,undefined,ctx);
  assert.equal(discussed.details.independent[0].ready,false);
  assert.equal(discussed.details.reviews[0].ready,true);
  assert.equal(discussed.details.status,'approved');
 }finally{process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
});
