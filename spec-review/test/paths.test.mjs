import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInputFile } from '../paths.mjs';
test('input validation accepts files and rejects missing paths and directories with path',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-paths-'));
 try {
  await writeFile(join(root,'spec.md'),'spec');
  assert.equal(await validateInputFile(root,'spec.md'),await validateInputFile(root,join(root,'spec.md')));
  await assert.rejects(validateInputFile(root,'.'),e=>e.message.includes(root)&&e.message.includes('regular file'));
  await assert.rejects(validateInputFile(root,'missing.md'),e=>e.message.includes(join(root,'missing.md')));
 } finally {await rm(root,{recursive:true,force:true});}
});
