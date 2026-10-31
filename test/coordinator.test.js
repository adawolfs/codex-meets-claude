import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
const tick=()=>new Promise(r=>setImmediate(r));
async function setup(t,options={}) {
 const directory=mkdtempSync(join(tmpdir(),'bridge-queue-')),store=new Store({directory});
 const controls=new Map();
 const runner=async(provider,args,update,signal)=>new Promise(resolve=>{
  controls.set(args.prompt,{finish:()=>resolve({status:signal.aborted?'cancelled':'completed',result:args.prompt}),signal});
  update({sessionId:args.sessionId||'session-'+args.prompt,progress:{phase:'running',text:'working'}},[]);
 });
 const c=new Coordinator({store,runner,resolveProject:async cwd=>({cwd,project:cwd}),...options});
 t.after(async()=>{for(const v of controls.values())v.finish();await c.shutdown();store.close();rmSync(directory,{recursive:true,force:true});});
 return {c,store,controls};
}
test('global queue skips occupied project, retains locks until cancelled process finishes',async t=>{
 const {c,controls}=await setup(t,{maxActive:2,maxQueued:4});
 const a=await c.start('claude',{prompt:'a',cwd:'/p'}),b=await c.start('codex',{prompt:'b',cwd:'/p'}),d=await c.start('codex',{prompt:'d',cwd:'/q'});
 await tick();assert.equal(c.status('claude',a.id).status,'running');assert.equal(c.status('codex',b.id).status,'queued');assert.equal(c.status('codex',d.id).status,'running');
 c.cancel('claude',a.id);assert.equal(controls.get('a').signal.aborted,true);await tick();assert.equal(c.status('codex',b.id).status,'queued');
 controls.get('a').finish();await tick();assert.equal(c.status('claude',a.id).status,'cancelled');assert.equal(c.status('codex',b.id).status,'running');
 controls.get('b').finish();controls.get('d').finish();await tick();
});
test('session lock crosses projects, queue cancel never starts, capacity and input validation',async t=>{
 const {c,controls}=await setup(t,{maxActive:2,maxQueued:1});
 await c.start('claude',{prompt:'a',cwd:'/p',sessionId:'same'});
 const b=await c.start('claude',{prompt:'b',cwd:'/q',sessionId:'same'});await tick();assert.equal(c.status('claude',b.id).status,'queued');
 await assert.rejects(c.start('codex',{prompt:'full',cwd:'/third'}),/queue/i);
 assert.equal(c.cancel('claude',b.id).status,'cancelled');assert.equal(controls.has('b'),false);
 for(const args of [{prompt:''},{maxTurns:0},{surprise:1},{requestId:''},{permissionMode:'bypassPermissions'}])await assert.rejects(c.start('claude',{prompt:'valid',cwd:'/p',...args}));
 await assert.rejects(c.start('codex',{prompt:'x',cwd:'/p',permissionMode:'acceptEdits'}));
 controls.get('a').finish();await tick();
});
test('idempotency works at capacity and persisted result keeps durable ID',async t=>{
 const {c,store,controls}=await setup(t,{maxActive:1,maxQueued:1});
 const request={prompt:'a',cwd:'/p',requestId:'retry'};
 const a=await c.start('claude',request);await c.start('codex',{prompt:'b',cwd:'/q'});
 assert.equal((await c.start('claude',request)).id,a.id);
 await assert.rejects(c.start('claude',{...request,prompt:'changed'}),/requestId/);
 controls.get('a').finish();await tick();assert.equal(store.get('claude',a.id).result,'a');assert.equal(store.get('claude',a.id).id,a.id);
 controls.get('b').finish();await tick();
});
test('shutdown preserves never-started queue and marks active interrupted; resume is explicit',async t=>{
 const {c,store,controls}=await setup(t,{maxActive:1});
 const a=await c.start('claude',{prompt:'a',cwd:'/p'}),b=await c.start('claude',{prompt:'b',cwd:'/q'});
 const closing=c.shutdown();controls.get('a').finish();await closing;
 assert.equal(store.get('claude',a.id).status,'interrupted');assert.equal(store.get('claude',b.id).status,'queued');
 const next=new Coordinator({store,runner:async()=>({status:'completed',result:'resumed'}),resolveProject:async cwd=>({cwd,project:cwd})});
 const r=await next.start('claude',{prompt:'resume',cwd:'/p',parentJobId:a.id});await tick();
 assert.equal(next.status('claude',r.id).sessionId,'session-a');assert.equal(next.status('claude',r.id).parentJobId,a.id);
 await assert.rejects(next.start('codex',{prompt:'resume',cwd:'/p',parentJobId:a.id}));
 await next.shutdown();
});


test('cancelling queued jobs prunes terminal history even while a long job is active',async t=>{
 const {c,store,controls}=await setup(t,{maxActive:1});store.maxHistory=2;
 await c.start('claude',{prompt:'blocker',cwd:'/p'});
 for(let i=0;i<8;i++){const j=await c.start('claude',{prompt:'cancel-'+i,cwd:'/p'});c.cancel('claude',j.id);}
 assert.equal(store.counts().cancelled,2);
 controls.get('blocker').finish();await tick();
});

test('idempotent resume retry survives parent eviction and missing directory',async t=>{
 const {c,store,controls}=await setup(t);store.maxHistory=2;
 const p=await c.start('claude',{prompt:'parent',cwd:'/p'});controls.get('parent').finish();await tick();
 const request={prompt:'child',cwd:'/p',parentJobId:p.id,requestId:'stable-child'};
 const child=await c.start('claude',request);
 for(let i=0;i<3;i++){const j=await c.start('codex',{prompt:'other'+i,cwd:'/other'});controls.get('other'+i).finish();await tick();}
 assert.throws(()=>store.get('claude',p.id),/not found/);
 assert.equal((await c.start('claude',request)).id,child.id);
 c.resolveProject=async()=>{throw Error('directory removed');};
 assert.equal((await c.start('claude',request)).id,child.id);
 controls.get('child').finish();await tick();
});
