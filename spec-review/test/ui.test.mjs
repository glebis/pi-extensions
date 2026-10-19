import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const host=process.env.PI_TEST_HOST ?? resolve(execFileSync('which',['pi'],{encoding:'utf8'}).trim(),'..','..','lib/node_modules/@earendil-works/pi-coding-agent');
const {loadExtensions}=await import(pathToFileURL(join(host,'dist/core/extensions/loader.js')));

test('interactive setup, live progress, close without cancel, findings, retry only failures, lead, stop',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spec-review-ui-'));const oldPath=process.env.PATH;
 try {
  await mkdir(join(root,'.pi'));await mkdir(join(root,'bin'));
  await writeFile(join(root,'spec.md'),'Clear scope and acceptance tests');
  await writeFile(join(root,'.pi/spec-review.json'),JSON.stringify({defaultPreset:'test',presets:{test:{reviewers:[{id:'ok',kind:'codex',model:'ok'},{id:'flaky',kind:'codex',model:'flaky'}],minimum:2}}}));
  const marker=join(root,'flaky-count');
  await writeFile(join(root,'bin/codex'),`#!/usr/bin/env node
const fs=require('node:fs');const model=process.argv[process.argv.indexOf('--model')+1];
process.stdin.resume();process.stdin.on('end',()=>{let n=0;if(model==='flaky'){try{n=Number(fs.readFileSync(${JSON.stringify(marker)},'utf8'));}catch{}fs.writeFileSync(${JSON.stringify(marker)},String(n+1));}
fs.appendFileSync(${JSON.stringify(join(root,'calls'))},model+'\\n');
setTimeout(()=>{if(model==='flaky' && n===0){process.stderr.write('temporary failure');process.exit(1);}console.log(JSON.stringify({ready:true,acceptance:true,implementation:true,tests:true,findings:[]}));},100);
});`,{mode:0o700});
  process.env.PATH=join(root,'bin')+':'+oldPath;
  const loaded=await loadExtensions([resolve('index.ts')],root);assert.deepEqual(loaded.errors,[]);
  const ext=loaded.extensions[0];const entries=[];const messages=[];
  loaded.runtime.appendEntry=(customType,data)=>entries.push({type:'custom',customType,data:structuredClone(data)});
  loaded.runtime.sendUserMessage=text=>messages.push(text);
  const views=[];const widgets=[];const notices=[];const selections=[];
  let actions=['n','\x1b'];let inputs=['spec.md',''];let selects=['test','3','2','Только выбранные файлы'];
  const ctx={cwd:root,hasUI:true,ui:{setStatus(){},setWidget(_id,lines){widgets.push(lines);},notify(...a){notices.push(a);},confirm:async()=>true,input:async()=>inputs.shift(),select:async(title,options)=>{selections.push({title,options});const choice=selects.shift();assert.ok(choice===undefined || options.includes(choice),`Invalid test selection: ${choice}`);return choice;},
   custom:async factory=>new Promise(resolve=>{
    let disposed=false;
    const tui={terminal:{rows:24},requestRender(){if(component)views.push(component.render(90));}};
    let component;
    component=factory(tui,{}, {},value=>{if(!disposed){disposed=true;component.dispose?.();resolve(value);}});
    views.push(component.render(90));
    const keys=actions.shift() ?? '\x1b';
    for(const key of Array.isArray(keys)?keys:[keys])component.handleInput(key);
   })},sessionManager:{getBranch:()=>entries}};
  const command=ext.commands.get('spec-review');
  await command.handler('',ctx);
  assert.equal((await ext.handlers.get('session_before_switch')[0]({},ctx)).cancel,true,'panel close must not cancel background work');
  // Wait on observable completion instead of timed polling.
  await new Promise(resolve=>{
   const original=ctx.ui.setWidget;
   ctx.ui.setWidget=(id,lines)=>{original(id,lines);if(lines===undefined)resolve();};
  });
  assert.ok(widgets.some(lines=>lines?.some(l=>l.includes('проверяет'))));
  assert.equal(JSON.parse(await readFile(entries.at(-1).data.lastReport,'utf8')).status,'blocked');
  actions=['f','\x1b','r','\x1b'];await command.handler('',ctx);
  await new Promise(resolve=>{const original=ctx.ui.setWidget;ctx.ui.setWidget=(id,lines)=>{original(id,lines);if(lines===undefined)resolve();};});
  const calls=(await readFile(join(root,'calls'),'utf8')).trim().split('\n');
  assert.equal(calls.filter(x=>x==='ok').length,1);
  assert.equal(calls.filter(x=>x==='flaky').length,2);
  assert.equal(JSON.parse(await readFile(entries.at(-1).data.lastReport,'utf8')).status,'approved');
  assert.ok(views.flat().some(l=>l.includes('ОТЗЫВЫ')));
  assert.ok(views.flat().some(l=>l.includes('› [ Начать с настройками по умолчанию ]')));
  assert.ok(views.flat().some(l=>l.includes('недоступно: отчёта пока нет')));
  assert.ok(views.flat().some(l=>l.includes('Enter открыть')));
  actions=['v','\x1b','\x1b'];selects=['Полный путь спецификации'];
  await command.handler('',ctx);
  assert.ok(views.flat().some(l=>l.includes('Строки ')),'detail viewer shows scroll position');
  actions=['v',['\x1b[F','\x1b[H','\x1b'],'\x1b'];selects=['reviewer-1 · codex · ok'];
  await command.handler('',ctx);
  assert.ok(views.flat().some(l=>l.includes('reviewer-1 · codex · ok')),`reviewer details identify engine and model: ${JSON.stringify(notices)}`);
  actions=['l'];await command.handler('',ctx);assert.equal(messages.length,1);
  await writeFile(join(root,'spec.md'),'changed scope');
  actions=['d'];inputs=['Auth decision needs evidence'];await command.handler('',ctx);
  assert.equal(messages.length,2);assert.match(messages[1],/Auth decision needs evidence/);
  assert.equal((await ext.handlers.get('tool_call')[0]({toolName:'write',input:{path:'code.ts'}},ctx)).block,true,'dispute note must not bypass gate');
  const beforeCancel=entries.length;
  actions=['n','\x1b'];inputs=[];await command.handler('',ctx);
  assert.equal(entries.length,beforeCancel,'cancelled setup leaves state untouched');
  actions=['\x1b'];selects=[];
  const savedInput=ctx.ui.input;
  ctx.ui.input=async()=>assert.fail('path argument should preselect spec without asking again');
  const selectionsBeforePath=selections.length;
  await command.handler(` "${join(root,'spec.md')}" `,ctx);
  assert.equal(selections.length,selectionsBeforePath,'path opens quick-start summary without settings dialogs');
  assert.ok(views.at(-1).some(l=>l.includes('0/3 завершено')),'quick-start shows actual zero progress');
  ctx.ui.input=savedInput;
  assert.equal(entries.length,beforeCancel,'path argument opens cancellable wizard, not JSON parser');
  // Reconfigure launches another run; stop is explicit, unlike Escape.
  actions=['n','s','\x1b'];inputs=['spec.md',''];selects=['test','3','2','Только выбранные файлы'];
  await command.handler('',ctx);
  await ext.handlers.get('session_shutdown')[0]({},ctx);
  assert.ok(notices.some(n=>n[0]==='Aborted'));
  const gate=ext.handlers.get('tool_call')[0];
  assert.equal((await gate({toolName:'write',input:{path:'code.ts'}},ctx)).block,true);
  await rm(join(root,'.pi/spec-review.json'));
  actions=['n','\x1b'];inputs=['spec.md',''];selects=['Свой набор','Готово — продолжить','1','1','Только выбранные файлы'];
  await command.handler('',ctx);
  assert.equal(entries.at(-1).data.reviewers.length,3,'custom setup defaults to three reviewers without config file');
  assert.deepEqual(entries.at(-1).data.reviewers.map(r=>r.kind),['pi','codex','claude']);
  assert.equal(entries.at(-1).data.reviewers[0].model,'openai-codex/gpt-6.1-sol','use explicit default model without model input');
  const picker=selections.filter(s=>s.title.startsWith('Добавить ревьюера'));
  assert.equal(picker.at(-1).options[0],'Готово — продолжить');
  assert.equal(picker.at(-1).options.includes('codex · по умолчанию'),false,'preselected reviewer removed from picker');
  await ext.handlers.get('session_shutdown')[0]({},ctx);
 } finally {process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
});
