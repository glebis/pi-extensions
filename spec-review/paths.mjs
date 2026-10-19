import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function validateInputFile(cwd, input) {
 if(typeof input !== 'string' || !input.trim())throw Error('Input path must be a nonempty file path');
 const path=resolve(cwd,input);
 try {
  const canonical=await realpath(path);
  if(!(await stat(canonical)).isFile())throw Error('Expected a regular file');
  await readFile(canonical);
  return canonical;
 } catch(e) {throw Error(`Invalid input file ${path}: ${e.message}`);}
}
