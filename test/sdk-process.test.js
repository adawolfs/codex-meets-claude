import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { JobManager } from '../src/jobs.js';
test('SDK result cannot settle while its spawned process is still alive',{timeout:10000},async t=>{
 let child;
 const m=new JobManager({query:({options})=>(async function*(){
  const launch=options.spawnClaudeCodeProcess||(({command,args,...rest})=>spawn(command,args,rest));
  child=launch({command:process.execPath,args:['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],cwd:process.cwd(),env:process.env});
  await new Promise(r=>child.stdout.once('data',r));
  yield {type:'result',subtype:'success',is_error:false,result:'done',session_id:'session-1'};
 })()});
 t.after(()=>{child?.kill('SIGKILL');});
 const result=await m.wait(m.start({prompt:'test',cwd:process.cwd()}).id);
 assert.equal(result.status,'completed');
 assert.ok(child.exitCode!==null||child.signalCode!==null,'process still running after finishedAt');
});
