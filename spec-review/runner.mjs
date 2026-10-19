import { spawn } from 'node:child_process';
export function runProcess(command,args,prompt,cwd,signal,timeout=180000,cap=2*1024*1024) {
 return new Promise((resolve,reject)=>{
  if(signal?.aborted) return reject(Error('Aborted'));
  const child=spawn(command,args,{cwd,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  let out='',err='',size=0,failure;
  const kill=()=>{try { if(process.platform!=='win32') process.kill(-child.pid,'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
  const abort=()=>{failure=Error('Aborted');kill();};
  const timer=setTimeout(()=>{failure=Error('Timeout');kill();},timeout);
  signal?.addEventListener('abort',abort,{once:true});
  const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  child.stdout.on('data',b=>{size+=b.length;if(size>cap){failure=Error('Output limit');kill();}else out+=b.toString();});
  child.stderr.on('data',b=>{size+=b.length;if(size>cap){failure=Error('Output limit');kill();}else err+=b.toString();});
  child.stdin.on('error',()=>{});
  child.on('error',e=>{clean();reject(e);});
  child.on('close',(code)=>{clean();if(failure)reject(failure);else if(code!==0)reject(Error(`Exit ${code}: ${[err.trim(),out.trim()].filter(Boolean).join('\n').slice(-8000) || 'Process returned no diagnostic output'}`));else resolve(out);});
  child.stdin.end(prompt);
 });
}
export function decode(kind,text) {
 if(kind==='codex') return text;
 if(kind==='claude') {const e=JSON.parse(text);if(e.is_error || typeof e.result!=='string')throw Error(`Claude failed: ${e.result || JSON.stringify(e.errors ?? e)}`);return e.result;}
 let last;
 for(const line of text.split('\n')) {
  if(!line.trim())continue;
  const e=JSON.parse(line);
  if(e.type==='message_end' && e.message?.role==='assistant')last=e.message;
 }
 if(!last || ['error','aborted'].includes(last.stopReason))throw Error(last?.errorMessage || 'Pi failed or returned no answer');
 return last.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
}
