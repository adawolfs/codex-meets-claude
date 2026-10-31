import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from '../src/jobs.js';
import { createRunner } from '../src/runner.js';
test('SDK permits many small messages while bounding each message',async()=>{
 const m=new JobManager({maxOutputBytes:500,query:()=>(async function*(){
  for(let i=0;i<100;i++)yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'progress'}}};
  yield {type:'result',subtype:'success',is_error:false,result:'done',session_id:'id'};
 })()});
 const j=await m.wait(m.start({prompt:'x',cwd:process.cwd()}).id);assert.equal(j.status,'completed');
});
test('runner emits progress and resolves only after cancellation cleanup',async()=>{
 const controller=new AbortController();let sawSession=false;
 const runner=createRunner({pollMs:5,managerFactory:provider=>new JobManager({provider,query:({options})=>(async function*(){
  yield {type:'system',subtype:'init',session_id:'runner-session'};
  await new Promise(resolve=>options.abortController.signal.addEventListener('abort',resolve,{once:true}));
 })()})});
 const result=await runner('claude',{prompt:'test',cwd:process.cwd()},patch=>{
  if(patch.sessionId){sawSession=true;controller.abort();}
 },controller.signal);
 assert.ok(sawSession);assert.equal(result.status,'cancelled');assert.ok(result.finishedAt);
});
test('Codex parses streaming JSONL without retaining cumulative output',async()=>{
 const m=new JobManager({provider:'codex',command:process.execPath,prefix:['test/fake-codex-stream.js'],maxOutputBytes:20000,timeoutMs:3000});
 const j=m.start({prompt:'stream',cwd:process.cwd()});const result=await m.wait(j.id);
 assert.equal(result.status,'completed');assert.equal(result.sessionId,'stream-session');assert.equal(result.result,'complete');
});
