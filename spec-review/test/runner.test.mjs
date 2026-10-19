import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, decode } from '../runner.mjs';
test('failed CLI preserves error reported on stdout',async()=>{
 await assert.rejects(runProcess(process.execPath,['-e',`console.log('{"is_error":true,"result":"Unknown model"}');process.exit(1)`],'',process.cwd(),undefined,1000),/Unknown model/);
});
test('process receives stdin without shell expansion',async()=>{
 const text='hello $(touch /tmp/never-spec-review)';
 assert.equal(await runProcess(process.execPath,['-e','process.stdin.pipe(process.stdout)'],text,process.cwd(),undefined,1000),text);
});
test('process failures, timeout, cancellation and output cap reject',async()=>{
 await assert.rejects(runProcess(process.execPath,['-e','process.exit(7)'],'',process.cwd(),undefined,1000));
 await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},100)'],'',process.cwd(),undefined,30),/Timeout/);
 const c=new AbortController(); c.abort();
 await assert.rejects(runProcess(process.execPath,[], '',process.cwd(),c.signal,1000),/Abort/);
 await assert.rejects(runProcess(process.execPath,['-e','console.log("x".repeat(200))'],'',process.cwd(),undefined,1000,100),/Output limit/);
});
test('decodes final Pi and Claude responses; provider errors cannot pass',()=>{
 assert.equal(decode('pi',JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok'}]}})),'ok');
 assert.equal(decode('claude','{"result":"ok"}'),'ok');
 assert.throws(()=>decode('claude','{"is_error":true,"result":"bad"}'));
 assert.throws(()=>decode('pi',JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',content:[]}})));
});
