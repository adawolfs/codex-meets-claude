import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('controlled load keeps queue, history, events and heap bounded',{timeout:180000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'bridge-soak-')),store=new Store({directory,maxHistory:1000});
 const c=new Coordinator({store,resolveProject:async cwd=>({cwd,project:cwd}),runner:async(_p,args,update,signal)=>{
  update({progress:{phase:'running',text:'working'}},Array.from({length:300},(_,i)=>({sequence:i+1,type:'text',text:'progress'})));
  await sleep(1);return {status:signal.aborted?'cancelled':'completed',result:args.prompt};
 }});
 t.after(async()=>{await c.shutdown();store.close();rmSync(directory,{recursive:true,force:true});});
 const start=Date.now(),heap=process.memoryUsage().heapUsed,duration=Number(process.env.BRIDGE_SOAK_MS||1000);
 let n=0,first,last;
 while(n<1500||Date.now()-start<duration){
  if((store.counts().queued||0)>=90){await sleep(5);continue;}
  last=await c.start(n%2?'claude':'codex',{prompt:'job-'+n,cwd:'/project-'+n%16,requestId:'load-'+n});
  first??=last;n++;
  assert.ok(c.active.size<=4);
 }
 while(c.active.size||store.queued().length)await sleep(10);
 assert.ok((store.counts().completed||0)<=1000);assert.throws(()=>store.get(first.provider,first.id),/not found/);
 assert.equal(store.events(last.provider,last.id,{limit:100}).truncated,true);
 assert.ok(statSync(join(directory,'jobs.sqlite')).size<50000000);
 assert.ok(process.memoryUsage().heapUsed-heap<150000000);
 t.diagnostic(JSON.stringify({jobs:n,durationMs:Date.now()-start,retained:store.counts(),heapGrowth:process.memoryUsage().heapUsed-heap}));
});
