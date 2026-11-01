import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { createServer } from 'node:http';
import { OpenCode } from '@opencode/client';
import { Coordinator, openCodeAborter } from '../src/coordinator.js';
import { validateCall } from '../src/persistent-tools.js';
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

// A finished job whose adapter could not prove its delegate stopped, as the coordinator stores it.
function unconfirmedDone(store,project='/p',openCode=identity,requestId='d-'+project){
  const id=orphan(store,'opencode',project,{...openCode,interrupt:'unconfirmed'},requestId);
  store.update(id,{status:'cancelled',finishedAt:new Date().toISOString()});return id;
}
test('an unconfirmed orphan holds its session as well as its project',async t=>{
  const {c,started}=await coordinator(t,s=>{orphan(s);},{abortSession:async()=>false});
  const same=await c.start('opencode',{prompt:'same-session',cwd:'/q',sessionId:'s1'});
  const other=await c.start('opencode',{prompt:'other-session',cwd:'/q',sessionId:'s2'});
  const resumed=await c.start('claude',{prompt:'claude-same-id',cwd:'/r',sessionId:'s1'});
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started.sort(),['claude-same-id','other-session']);
  assert.equal(c.status('opencode',same.id).status,'queued');
  assert.equal(c.status('opencode',other.id).status,'completed');assert.equal(c.status('claude',resumed.id).status,'completed');
});
test('a finished job whose interrupt was unconfirmed still holds its project and session, and survives prune',async t=>{
  const {c,store,started}=await coordinator(t,s=>{unconfirmedDone(s);},{abortSession:async()=>false});
  await c.start('claude',{prompt:'project',cwd:'/p'});await c.start('opencode',{prompt:'session',cwd:'/q',sessionId:'s1'});await c.start('claude',{prompt:'free',cwd:'/r'});
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started,['free']);assert.equal(c.diagnostics().unrecovered,1);
  store.maxHistory=1;for(let i=0;i<3;i++){const j=store.insert('claude',args('f'+i,'/z'),'/z');store.update(j.id,{status:'completed',finishedAt:new Date().toISOString()});}
  store.prune();assert.equal(store.unrecovered().length,1);
});
test('a confirmed interrupt and a running orphan are counted together',async t=>{
  const {c}=await coordinator(t,s=>{unconfirmedDone(s,'/p');orphan(s,'opencode','/q',identity,'run');unconfirmedDone(s,'/r',{sessionId:'s9',endpoint:'http://x'},'x');
    const ok=orphan(s,'opencode','/s',identity,'ok');s.update(ok,{status:'completed',finishedAt:new Date().toISOString(),openCode:{...identity,interrupt:'confirmed'}});},{abortSession:async()=>false});
  assert.equal(c.diagnostics().unrecovered,3);
});
test('cancel on an unconfirmed finished job retries the abort and says so when it fails',async t=>{
  let answer=false;const calls=[];
  const {c,store,started}=await coordinator(t,s=>{unconfirmedDone(s);s.insert('claude',args('queued'),'/p');},{abortSession:async s=>(calls.push(s),answer)});
  for(let i=0;i<3;i++)await tick();
  const held=store.unrecovered()[0];
  await assert.rejects(c.cancel('opencode',held.id),/could not confirm.*locked/i);
  assert.deepEqual(started,[]);assert.equal(c.diagnostics().unrecovered,1);assert.equal(store.get('opencode',held.id).openCode.interrupt,'unconfirmed');
  answer=true;
  const view=await c.cancel('opencode',held.id);
  assert.equal(view.openCode.interrupt,'confirmed');assert.equal(view.status,'cancelled');
  for(let i=0;i<5;i++)await tick();
  assert.equal(c.diagnostics().unrecovered,0);assert.deepEqual(started,['go']);
  assert.equal(calls.length,2);assert.deepEqual(calls[0],{provider:'opencode',sessionId:'s1',endpoint:'http://x'});
});
test('cancel on an unconfirmed running orphan releases it as interrupted once the abort lands, and a throwing abort is reported',async t=>{
  let mode='throw';
  const {c,store,started}=await coordinator(t,s=>{orphan(s);s.insert('claude',args('queued'),'/p');},{abortSession:async()=>{if(mode==='throw')throw Error('down');return mode==='ok';}});
  for(let i=0;i<3;i++)await tick();
  const id=store.unrecovered()[0].id;
  await assert.rejects(c.cancel('opencode',id),/could not confirm/i);
  mode='ok';
  assert.equal((await c.cancel('opencode',id)).status,'interrupted');
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started,['go']);
});
test('cancelling a queued or ordinary job is unchanged by holds',async t=>{
  const {c}=await coordinator(t,s=>{orphan(s);},{abortSession:async()=>false});
  const q=await c.start('claude',{prompt:'q',cwd:'/p'});
  assert.equal(c.cancel('claude',q.id).status,'cancelled');
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
  // A discovery that hangs is bounded by the same deadline: recovery gates every queue.
  assert.equal(await openCodeAborter({service:{...fakeService(),discover:()=>new Promise(()=>{})},connect:probe().connect,timeoutMs:20})(target),false);
});

const notFound=(sessionID='s1')=>({_tag:'SessionNotFoundError',sessionID,message:'Session not found'});
const target={provider:'opencode',sessionId:'s1',endpoint:'http://x'};
test('a reachable service that does not know the session proves it stopped; nothing else does',async t=>{
  const aborter=error=>openCodeAborter({service:fakeService(),connect:probe(async()=>{throw error;}).connect})(target);
  assert.equal(await aborter(notFound('s1')),true);
  assert.equal(await aborter(notFound('other')),false);
  assert.equal(await aborter({_tag:'SessionNotFoundError'}),false);
  assert.equal(await aborter({_tag:'UnauthorizedError',message:'no'}),false);
  assert.equal(await aborter({_tag:'LocationNotFoundError',message:'no'}),false);
  assert.equal(await aborter(Object.assign(Error('fetch failed'),{name:'ClientError',reason:'Transport'})),false);
  assert.equal(await aborter(Error('Session not found')),false);
  assert.equal(await aborter(null),false);
});
async function serve(t,status,body){
  const server=createServer((req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  return 'http://127.0.0.1:'+server.address().port;
}
test('identification holds against the real client over HTTP',async t=>{
  const check=async(status,body,sessionId='s1')=>{const url=await serve(t,status,body);
    return openCodeAborter({service:{discover:async()=>({url}),headers:()=>undefined},connect:o=>OpenCode.make(o)})({provider:'opencode',sessionId,endpoint:url});};
  assert.equal(await check(200,{interrupted:true}),true);
  assert.equal(await check(404,notFound('s1')),true);
  assert.equal(await check(404,notFound('s1'),'s2'),false);
  assert.equal(await check(404,{_tag:'LocationNotFoundError',message:'x'}),false);
  assert.equal(await check(404,{}),false);
  assert.equal(await check(500,{message:'boom'}),false);
  assert.equal(await check(401,{_tag:'UnauthorizedError',message:'no'}),false);
  const closed=await serve(t,200,{});
  const gone=createServer();await new Promise(r=>gone.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+gone.address().port;await new Promise(r=>gone.close(r));
  assert.equal(await openCodeAborter({service:{discover:async()=>({url}),headers:()=>undefined},connect:o=>OpenCode.make(o)})({provider:'opencode',sessionId:'s1',endpoint:url}),false);
});
test('cancel releases a hold when the live service reports the session unknown, and records confirmed',async t=>{
  const abortSession=openCodeAborter({service:fakeService(),connect:probe(async()=>{throw notFound('s1');}).connect});
  const {c,store,started}=await coordinator(t,s=>{unconfirmedDone(s);s.insert('claude',args('queued'),'/p');},{abortSession});
  const id=store.unrecovered()[0].id;
  assert.equal((await c.cancel('opencode',id)).openCode.interrupt,'confirmed');
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started,['go']);assert.equal(c.diagnostics().unrecovered,0);
});
test('startup recovery also releases an orphan whose session the service has forgotten',async t=>{
  const abortSession=openCodeAborter({service:fakeService(),connect:probe(async()=>{throw notFound('s1');}).connect});
  const {c,store}=await coordinator(t,s=>{orphan(s);},{abortSession});await tick();
  assert.equal(store.counts().interrupted,1);assert.equal(c.diagnostics().unrecovered,0);
});
test('a transport failure against a reachable service does not release the hold',async t=>{
  const abortSession=openCodeAborter({service:fakeService(),connect:probe(async()=>{throw Object.assign(Error('fetch failed'),{reason:'Transport'});}).connect});
  const {c,store,started}=await coordinator(t,s=>{unconfirmedDone(s);s.insert('claude',args('queued'),'/p');},{abortSession});
  await assert.rejects(c.cancel('opencode',store.unrecovered()[0].id),/force/);
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started,[]);assert.equal(c.diagnostics().unrecovered,1);
});
test('force releases a running orphan and a finished unconfirmed row without any abort, recorded as forced',async t=>{
  const calls=[];
  const {c,store,started}=await coordinator(t,s=>{orphan(s,'opencode','/p');unconfirmedDone(s,'/q');s.insert('claude',args('qp'),'/p');s.insert('opencode',{...args('qs','/z'),sessionId:'s1'},'/z');s.insert('claude',args('qq'),'/q');},{abortSession:async s=>(calls.push(s),false)});
  for(let i=0;i<3;i++)await tick();
  assert.deepEqual(started,[]);calls.length=0;
  const [running,done]=['running','cancelled'].map(st=>store.db.prepare('SELECT id FROM jobs WHERE status=?').get(st).id);
  const a=await c.cancel('opencode',running,{force:true}),b=await c.cancel('opencode',done,{force:true});
  assert.equal(a.status,'interrupted');assert.equal(a.openCode.interrupt,'forced');
  assert.equal(b.status,'cancelled');assert.equal(b.openCode.interrupt,'forced');
  assert.deepEqual(store.get('opencode',running).openCode,{...identity,interrupt:'forced'});
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started.sort(),['go','go','go']);
  assert.equal(c.diagnostics().unrecovered,0);assert.equal(calls.length,0);
});
test('a forced row no longer holds its project or its session',async t=>{
  const {c,store,started}=await coordinator(t,s=>{unconfirmedDone(s);},{abortSession:async()=>false});
  const id=store.unrecovered()[0].id;
  await c.cancel('opencode',id,{force:true});
  await c.start('claude',{prompt:'project',cwd:'/p'});await c.start('opencode',{prompt:'session',cwd:'/q',sessionId:'s1'});
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started.sort(),['project','session']);
});
test('force on a row that holds nothing is an ordinary cancel',async t=>{
  const {c}=await coordinator(t,()=>{});
  const q=await c.start('opencode',{prompt:'q',cwd:'/p'});await c.cancel('opencode',q.id,{force:true});
});
test('force is opencode-only and must be boolean',async t=>{
  const {c,store}=await coordinator(t,()=>{});
  const job=store.insert('claude',args('c'),'/p');
  for(const p of ['claude','codex']){
    assert.throws(()=>c.cancel(p,job.id,{force:true}),/only supported for opencode/);
    assert.throws(()=>validateCall(p,'cancel',{jobId:'x',force:true}),/Unknown argument: force/);
  }
  assert.equal(validateCall('opencode','cancel',{jobId:'x',force:true}).name,'opencode_cancel');
  assert.throws(()=>validateCall('opencode','cancel',{jobId:'x',force:'yes'}),/Invalid force/);
  assert.equal(c.cancel('claude',job.id).status,'cancelled');
});
test('an unconfirmed row with no session identity can be released only by force',async t=>{
  const {c,store,started}=await coordinator(t,s=>{const id=orphan(s,'opencode','/p',{sessionId:null,endpoint:null,interrupt:'unconfirmed'});s.update(id,{status:'failed',finishedAt:new Date().toISOString()});s.insert('claude',args('queued'),'/p');},{abortSession:async()=>true});
  const id=store.unrecovered()[0].id;
  await assert.rejects(c.cancel('opencode',id),/force/);
  assert.equal((await c.cancel('opencode',id,{force:true})).openCode.interrupt,'forced');
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(started,['go']);
});
