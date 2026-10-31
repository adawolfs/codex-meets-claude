import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { linuxPath, resolveProject } from '../src/paths.js';
test('Windows local and Ubuntu UNC paths map without shell interpretation',()=>{
 assert.equal(linuxPath('C:\\Users\\A B\\project'),'\/mnt/c/Users/A B/project');
 assert.equal(linuxPath('\\\\wsl.localhost\\Ubuntu\\home\\a\\repo'),'/home/a/repo');
 assert.equal(linuxPath('\\\\wsl$\\Ubuntu\\home\\a\\repo'),'/home/a/repo');
 assert.throws(()=>linuxPath('\\\\wsl.localhost\\Debian\\home\\a'),/distro/);
 for(const p of ['relative','C:relative','\\\\server\\share','/tmp/\0bad'])assert.throws(()=>linuxPath(p));
});
test('Git subdirectories share project lock; non-Git directories use real cwd',{skip:process.platform==='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'bridge-path-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 execFileSync('git',['init','-q',root]);const sub=join(root,'space $d');mkdirSync(sub);
 assert.deepEqual(await resolveProject(sub),{cwd:sub,project:root});
 assert.equal((await resolveProject(tmpdir())).project,tmpdir());
});
