import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Coordinator, openCodeAborter } from '../src/coordinator.js';
const tick=()=>new Promise(r=>setImmediate(r));
const args=(requestId,cwd='/p')=>({prompt:'go',cwd,requestId});
const identity={sessionId:'s1',endpoint:'http://x'};
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'bridge-recover-'));let s=new Store({directory});t.after(()=>{s.close();rmSync(directory,{recursive:true,force:true});});return {directory,get store(){return s;},reopen(){s.close();s=new Store({directory});return s;}};}
function orphan(store,provider='opencode',project='/p',openCode=identity,requestId='o-'+provider){
  const job=store.insert(provider,args(requestId,project),project);
  store.update(job.id,{status:'running',startedAt:new Date().toISOString(),...(openCode?{openCode}:{})});
  return job.id;
}
const V1="BEGIN; CREATE TABLE jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, args TEXT NOT NULL, project TEXT NOT NULL, status TEXT NOT NULL, view TEXT NOT NULL, finished TEXT, UNIQUE(provider,request_id)); CREATE TABLE events (job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(job,seq)); CREATE INDEX jobs_status ON jobs(status,seq); PRAGMA user_version=1; COMMIT;";

test('recovery aborts an orphaned opencode session before releasing its lock',async t=>{
  const f=fixture(t),id=orphan(f.store);
  const store=f.reopen(),aborted=[];
  await store.recover({abortSession:async s=>{aborted.push(s);return true;}});
  assert.deepEqual(aborted,[{provider:'opencode',sessionId:'s1',endpoint:'http://x'}]);
  assert.equal(store.get('opencode',id).status,'interrupted');
  assert.equal(store.unrecovered().length,0);
});
test('an unconfirmed abort keeps the job running and its project locked',async t=>{
  const f=fixture(t),id=orphan(f.store);
  const store=f.reopen();
  await store.recover({abortSession:async()=>false});
  assert.equal(store.get('opencode',id).status,'running');
  assert.deepEqual(store.unrecovered().map(r=>r.project),['/p']);
  assert.equal(store.queued().length,0);
});
test('an abort that throws is an unconfirmed abort, and rejection of one row spares the others',async t=>{
  const f=fixture(t),a=orphan(f.store,'opencode','/p',{sessionId:'bad',endpoint:'http://x'},'a'),b=orphan(f.store,'opencode','/q',{sessionId:'good',endpoint:'http://x'},'b');
  const store=f.reopen();
  await store.recover({abortSession:async s=>{if(s.sessionId==='bad')throw Error('boom');return true;}});
  assert.equal(store.get('opencode',a).status,'running');assert.equal(store.get('opencode',b).status,'interrupted');
});
test('without an abortSession an opencode row can never be confirmed',async t=>{
  const f=fixture(t),id=orphan(f.store);
  const store=f.reopen();await store.recover();
  assert.equal(store.get('opencode',id).status,'running');
});
test('claude and codex jobs recover without any abort call',async t=>{
  const f=fixture(t),a=orphan(f.store,'claude','/p',null),b=orphan(f.store,'codex','/q',null),c=orphan(f.store,'opencode','/r',null);
  const store=f.reopen(),calls=[];
  await store.recover({abortSession:async s=>(calls.push(s),true)});
  assert.equal(calls.length,0);
  for(const [p,id] of [['claude',a],['codex',b],['opencode',c]])assert.equal(store.get(p,id).status,'interrupted');
  await store.recover();
});
test('a resumed opencode job that never reached the service has nothing to abort',async t=>{
  const f=fixture(t),id=orphan(f.store,'opencode','/p',{sessionId:'s1',endpoint:null,interrupt:null});
  const store=f.reopen(),calls=[];
  await store.recover({abortSession:async s=>(calls.push(s),true)});
  assert.equal(calls.length,0);assert.equal(store.get('opencode',id).status,'interrupted');
});
test('the session identity is persisted by update, so a crash mid-run leaves it abortable',t=>{
  const f=fixture(t),job=f.store.insert('opencode',args('x'),'/p');
  f.store.update(job.id,{status:'running',openCode:{...identity,interrupt:null}});
  assert.deepEqual(f.reopen().get('opencode',job.id).openCode,{...identity,interrupt:null});
});
test('a store written by this version reopens at user_version 2 with an empty worktree table',t=>{
  const f=fixture(t);f.reopen();
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM worktrees').get().n,0);
});
test('a v1 database upgrades in place and keeps every job and event',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'bridge-v1-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const raw=new DatabaseSync(join(directory,'jobs.sqlite'));raw.exec(V1);
  const view=(id,status)=>JSON.stringify({id,provider:'claude',status,sessionId:'sess',result:'r'});
  const put=raw.prepare('INSERT INTO jobs(id,provider,request_id,fingerprint,args,project,status,view,finished) VALUES(?,?,?,?,?,?,?,?,?)');
  put.run('j1','claude','r1','f1','{"prompt":"a"}','/p','completed',view('j1','completed'),'2026-01-01T00:00:00.000Z');
  put.run('j2','codex','r2','f2','{"prompt":"b"}','/q','queued',view('j2','queued'),null);
  raw.prepare('INSERT INTO events(job,seq,body) VALUES(?,?,?)').run('j1',1,'{"sequence":1}');
  raw.close();
  const store=new Store({directory});t.after(()=>store.close());
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);
  assert.equal(store.get('claude','j1').result,'r');assert.equal(store.get('codex','j2').status,'queued');
  assert.deepEqual(store.events('claude','j1').events,[{sequence:1}]);
  assert.equal(store.queued().length,1);
  const id=orphan(store);assert.equal(store.unrecovered()[0].id,id);
  const aborted=[];await store.recover({abortSession:async s=>(aborted.push(s.sessionId),true)});
  assert.deepEqual(aborted,['s1']);assert.equal(store.get('opencode',id).status,'interrupted');assert.equal(store.get('codex','j2').status,'queued');
  store.close();assert.equal(new Store({directory}).db.prepare('PRAGMA user_version').get().user_version,2);
});
test('a database newer than this version is still refused',t=>{
  const directory=mkdtempSync(join(tmpdir(),'bridge-v3-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const raw=new DatabaseSync(join(directory,'jobs.sqlite'));raw.exec('PRAGMA user_version=3');raw.close();
  assert.throws(()=>new Store({directory}),/newer/);
});
test('prune never deletes worktree records, even when their job ages out',t=>{
  const f=fixture(t),s=f.store,job=s.insert('opencode',args('w'),'/p');
  s.update(job.id,{status:'completed',finishedAt:'2000-01-01T00:00:00.000Z'});
  s.db.prepare("INSERT INTO worktrees(id,job,project,branch,path,created) VALUES('w1',?,'/p','b','/p-wt','2000-01-01T00:00:00.000Z')").run(job.id);
  s.prune();
  assert.throws(()=>s.get('opencode',job.id),/not found/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM worktrees').get().n,1);
});

async function coordinator(t,prepare,options={}){
  const f=fixture(t);prepare(f.store);const store=f.reopen(),started=[];
  const c=new Coordinator({store,runner:async(p,a)=>(started.push(a.prompt),{status:'completed',result:'ok'}),resolveProject:async cwd=>({cwd,project:cwd}),...options});
  t.after(()=>c.shutdown());
  return {c,store,started};
}
test('the coordinator never starts a queued job in a project whose orphan is unconfirmed',async t=>{
  const {c,store,started}=await coordinator(t,s=>{orphan(s);},{abortSession:async()=>false});
  const blocked=await c.start('claude',{prompt:'blocked',cwd:'/p'}),free=await c.start('claude',{prompt:'free',cwd:'/q'});
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started,['free']);
  assert.equal(c.status('claude',blocked.id).status,'queued');assert.equal(c.status('claude',free.id).status,'completed');
  assert.equal(c.diagnostics().unrecovered,1);assert.equal(store.counts().running,1);
});
test('nothing starts until recovery has settled, then a confirmed abort frees the project',async t=>{
  const gate=Promise.withResolvers();
  const {c,started}=await coordinator(t,s=>{orphan(s);s.insert('claude',args('queued'),'/p');},{abortSession:()=>gate.promise});
  await tick();assert.deepEqual(started,[]);
  gate.resolve(true);for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started,['go']);assert.equal(c.diagnostics().unrecovered,0);
});
test('a rejected recovery abort leaves the project locked without crashing the service',async t=>{
  const {c,started}=await coordinator(t,s=>{orphan(s);s.insert('claude',args('queued'),'/p');},{abortSession:async()=>{throw Error('down');}});
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started,[]);assert.equal(c.diagnostics().unrecovered,1);assert.equal(c.diagnostics().status,'ready');
});
test('a service that has never run opencode recovers and reports zero unrecovered',async t=>{
  const {c}=await coordinator(t,()=>{});await tick();
  assert.equal(c.diagnostics().unrecovered,0);
});

const fakeService=(url='http://x',calls=[])=>({calls,discover:async()=>url&&({url:url.replace('//','//bridge:secret@'),auth:{type:'basic',username:'bridge',password:'secret'}}),headers:()=>({authorization:'Basic x'})});
const probe=(interrupt=async()=>({}))=>{const made=[];return {made,connect:o=>(made.push(o),{session:{interrupt}})};};
test('the real aborter interrupts through a short-lived client at the recorded endpoint',async t=>{
  const seen=[],p=probe(async i=>seen.push(i)),abort=openCodeAborter({service:fakeService(),connect:p.connect});
  assert.equal(await abort({provider:'opencode',sessionId:'s1',endpoint:'http://x'}),true);
  assert.deepEqual(seen,[{sessionID:'s1'}]);assert.equal(p.made[0].baseUrl,'http://bridge:secret@x');
  assert.deepEqual(p.made[0].headers,{authorization:'Basic x'});
});
test('the real aborter treats an unreachable, relocated, failing or hung service as unconfirmed',async t=>{
  const target={provider:'opencode',sessionId:'s1',endpoint:'http://x'};
  assert.equal(await openCodeAborter({service:fakeService(null),connect:probe().connect})(target),false);
  assert.equal(await openCodeAborter({service:fakeService('http://elsewhere'),connect:probe().connect})(target),false);
  assert.equal(await openCodeAborter({service:{...fakeService(),discover:async()=>{throw Error('x');}},connect:probe().connect})(target),false);
  assert.equal(await openCodeAborter({service:fakeService(),connect:probe(async()=>{throw Error('x');}).connect})(target),false);
  assert.equal(await openCodeAborter({service:fakeService(),connect:probe(()=>new Promise(()=>{})).connect,timeoutMs:20})(target),false);
});
