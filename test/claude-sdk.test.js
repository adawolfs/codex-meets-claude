import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from '../src/jobs.js';
const init={type:'system',subtype:'init',session_id:'session-1'};
const success={type:'result',subtype:'success',is_error:false,result:'done',session_id:'session-1',usage:{input_tokens:1,output_tokens:2},total_cost_usd:0.01};
const delta=text=>({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const manager=(query,options={})=>new JobManager({provider:'claude',query,...options});
const request={prompt:'review',cwd:process.cwd()};
test('SDK exposes progress before completion and maps resume, model and permission options',async()=>{
 const ready=gate(),release=gate();let options;
 const m=manager(({prompt,options:o})=>{assert.equal(prompt,'review');options=o;return(async function*(){yield init;yield delta('working');ready.resolve();await release.promise;yield success;})();});
 const job=m.start({...request,sessionId:'session-1',permissionMode:'acceptEdits',model:'sonnet'});
 await ready.promise;assert.equal(m.status(job.id).status,'running');assert.equal(m.status(job.id).sessionId,'session-1');assert.equal(m.status(job.id).progress.text,'working');
 assert.equal(options.resume,'session-1');assert.equal(options.permissionMode,'acceptEdits');assert.equal(options.model,'sonnet');assert.equal(options.includePartialMessages,true);assert.equal(options.strictMcpConfig,true);assert.deepEqual(options.mcpServers,{});assert.ok(options.disallowedTools.includes('mcp__*'));
 const decision=await options.canUseTool('Bash',{command:'touch secret'},{toolUseID:'tool-1'});
 assert.equal(decision.behavior,'deny');assert.equal(m.status(job.id).permissionDenials[0].toolName,'Bash');
 release.resolve();const result=await m.wait(job.id);assert.equal(result.status,'completed');assert.equal(result.result,'done');assert.equal(result.costUsd,0.01);assert.deepEqual(result.usage,{input_tokens:1,output_tokens:2});assert.ok(m.events(job.id).events.some(e=>e.type==='permission_denied'));
});
test('SDK rejects invalid requests before backend invocation',()=>{
 const m=manager(()=>{throw Error('backend must not run');});
 for(const args of [{prompt:''},{cwd:'relative'},{permissionMode:'bypassPermissions'},{maxBudgetUsd:-1},{maxTurns:0},{sessionId:'../bad'},{model:5}])assert.throws(()=>m.start({...request,...args}));
});
test('SDK cancellation aborts and cannot be overwritten by late success',async()=>{
 const ready=gate();let signal;
 const m=manager(({options})=>(async function*(){signal=options.abortController.signal;yield init;ready.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));yield success;})());
 const job=m.start(request);await ready.promise;m.cancel(job.id);assert.equal(signal.aborted,true);assert.equal((await m.wait(job.id)).status,'cancelled');assert.ok(m.status(job.id).finishedAt);
});
test('SDK timeout aborts and reports timed_out',async()=>{
 const m=manager(({options})=>(async function*(){yield init;await new Promise(r=>options.abortController.signal.addEventListener('abort',r,{once:true}));throw Error('aborted');})(),{timeoutMs:20});
 assert.equal((await m.wait(m.start(request).id)).status,'timed_out');
});
test('SDK errors and incomplete streams are never success',async()=>{
 for(const messages of [[],[init],[{...success,is_error:true,result:'denied'}],[{...success,subtype:'error_max_turns',errors:['turn limit']}],[{...success,result:undefined}]]){
 const m=manager(()=>(async function*(){yield* messages;})());const result=await m.wait(m.start(request).id);assert.equal(result.status,'failed');assert.ok(result.error);}
 const m=manager(()=>{throw Error('cannot launch');});assert.match((await m.wait(m.start(request).id)).error,/cannot launch/);
});
test('SDK events are bounded and paged without exposing reasoning',async()=>{
 const m=manager(()=>(async function*(){yield init;yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private'}}};for(let i=0;i<20;i++)yield delta('text');yield success;})(),{maxEvents:5});
 const job=m.start(request);await m.wait(job.id);const page=m.events(job.id,{after:0,limit:2});assert.equal(page.events.length,2);assert.equal(page.truncated,true);
 const next=m.events(job.id,{after:page.nextCursor,limit:5});assert.ok(next.events.every(e=>e.sequence>page.nextCursor));assert.ok(!JSON.stringify(m.status(job.id)).includes('private'));assert.throws(()=>m.events(job.id,{after:-1}));
});
test('SDK output and concurrent jobs are bounded',async()=>{
 const m=manager(()=>(async function*(){yield delta('x'.repeat(1000));yield success;})(),{maxOutputBytes:100});
 assert.equal((await m.wait(m.start(request).id)).status,'failed');
 const release=gate();const n=manager(()=>(async function*(){await release.promise;yield success;})(),{maxConcurrent:1});
 const first=n.start(request);assert.throws(()=>n.start(request),/concurrent/);release.resolve();await n.wait(first.id);assert.equal((await n.wait(n.start(request).id)).status,'completed');
});
test('SDK shutdown aborts all queries',async()=>{
 const ready=gate();const m=manager(({options})=>(async function*(){yield init;ready.resolve();await new Promise(r=>options.abortController.signal.addEventListener('abort',r,{once:true}));throw Error('abort');})());
 const job=m.start(request);await ready.promise;await m.shutdown();assert.equal(m.status(job.id).status,'cancelled');
});
