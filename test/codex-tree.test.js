import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../src/jobs.js';
test('Codex cancellation waits for SIGTERM-ignoring descendants even after main exits',{skip:process.platform==='win32',timeout:10000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'bridge-tree-'));let pid;
 const m=new JobManager({provider:'codex',command:process.execPath,prefix:['test/fake-codex-tree.js']});
 t.after(async()=>{if(pid){try{process.kill(pid,'SIGKILL');}catch{}}await m.shutdown();rmSync(directory,{recursive:true,force:true});});
 const j=m.start({prompt:directory,cwd:process.cwd()});
 const deadline=Date.now()+3000;
 while(!pid&&Date.now()<deadline){try{pid=Number(readFileSync(join(directory,'child.pid'),'utf8'));}catch{await new Promise(r=>setTimeout(r,20));}}
 assert.ok(pid);
 m.cancel(j.id);const result=await m.wait(j.id);assert.equal(result.status,'cancelled');
 let state;try{state=readFileSync('/proc/'+pid+'/stat','utf8').split(' ')[2];}catch{}
 assert.ok(state===undefined||state==='Z','live descendant survived finishedAt: '+state);
});
