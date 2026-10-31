import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
const request={prompt:'hello',cwd:'/project',requestId:'one'};
function fixture(t,options={}){const directory=mkdtempSync(join(tmpdir(),'bridge-store-'));let s=new Store({directory,...options});t.after(()=>{s.close();rmSync(directory,{recursive:true,force:true});});return {get store(){return s;},reopen(){s.close();s=new Store({directory,...options});return s;}};}
test('durable IDs and idempotency survive reopening; providers cannot read each other',t=>{
 const f=fixture(t),s=f.store,j=s.insert('claude',request,'/project');
 assert.equal(j.status,'queued');assert.equal(s.insert('claude',{...request},'/project').id,j.id);
 assert.throws(()=>s.insert('claude',{...request,prompt:'different'},'/project'),/requestId/);
 assert.throws(()=>s.get('codex',j.id),/not found/);
 assert.equal(f.reopen().get('claude',j.id).id,j.id);
 assert.equal(f.store.insert('claude',request,'/project').id,j.id);
});
test('recovery interrupts running jobs but preserves queued jobs and completed results',t=>{
 const f=fixture(t),s=f.store;
 const a=s.insert('claude',request,'/project'),b=s.insert('codex',{...request,requestId:'two'},'/other');
 s.update(a.id,{status:'running',sessionId:'session-1'});
 const c=s.insert('claude',{...request,requestId:'three'},'/third');s.update(c.id,{status:'completed',result:'answer',finishedAt:new Date().toISOString()});
 const next=f.reopen();next.recover();
 assert.equal(next.get('claude',a.id).status,'interrupted');assert.equal(next.get('claude',a.id).sessionId,'session-1');
 assert.equal(next.get('codex',b.id).status,'queued');assert.equal(next.get('claude',c.id).result,'answer');
});
test('events retain cursors and bounded history; list pages omit large results',t=>{
 const s=fixture(t,{maxEvents:3,maxHistory:2}).store;
 const a=s.insert('claude',request,'/project');
 s.appendEvents(a.id,Array.from({length:6},(_,i)=>({sequence:i+1,type:'text',text:'a'})));
 s.appendEvents(a.id,[{sequence:6,type:'text',text:'duplicate'}]);
 const p=s.events('claude',a.id,{after:0,limit:2});assert.equal(p.truncated,true);assert.deepEqual(p.events.map(x=>x.sequence),[4,5]);assert.equal(p.hasMore,true);
 assert.equal(s.events('claude',a.id,{after:p.nextCursor}).events[0].sequence,6);
 for(let i=0;i<5;i++){const j=s.insert('claude',{...request,requestId:'job'+i},'/project');s.update(j.id,{status:'completed',result:'long',finishedAt:new Date().toISOString()});}
 s.prune();assert.equal(s.get('claude',a.id).status,'queued');
 const page=s.list('claude',{limit:2});assert.equal(page.jobs.length,2);assert.ok(page.hasMore);assert.ok(page.jobs.every(j=>!('result' in j)&&!('prompt'in j)));
 assert.equal(s.list('claude',{after:page.nextCursor}).jobs.length,1);
 assert.throws(()=>s.events('claude',a.id,{limit:1000}));
});
