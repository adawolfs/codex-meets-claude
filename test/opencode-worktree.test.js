import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store, terminal } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { createWorktree, worktreeStatus, removeWorktree } from '../src/worktrees.js';
import { validateCall } from '../src/persistent-tools.js';
import { resolveProject } from '../src/paths.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const git=(cwd,...a)=>execFileSync('git',['-C',cwd,'-c','user.name=t','-c','user.email=t@t','-c','commit.gpgsign=false',...a],{encoding:'utf8'});
const temp=(t,prefix)=>{const d=realpathSync(mkdtempSync(join(tmpdir(),prefix)));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
function makeRepo(t){const d=temp(t,'bridge-wt-repo-');git(d,'init','-q','-b','main');writeFileSync(join(d,'README'),'x\n');mkdirSync(join(d,'sub'));writeFileSync(join(d,'sub','f'),'y\n');git(d,'add','.');git(d,'commit','-qm','init');return d;}
// The fake delegate obeys its prompt: "write:<file>" writes a file, "commit" commits it, "hold" waits to be released.
function setup(t,{storeOptions={},...options}={}){
  const directory=temp(t,'bridge-wt-state-'),store=new Store({directory,...storeOptions}),seen=[],gates=new Map(),live=new Set();
  const runner=async(provider,args,update)=>{
    seen.push(args);live.add(args.prompt);
    const sessionId=args.sessionId||'s-'+args.prompt;update({sessionId,...(provider==='opencode'?{openCode:{sessionId,endpoint:'http://x',interrupt:null}}:{})},[]);
    try{
      if(args.prompt.includes('hold'))await new Promise(r=>gates.set(args.prompt,r));
      const file=/write:(\S+)/.exec(args.prompt)?.[1];
      if(file){mkdirSync(dirname(join(args.cwd,file)),{recursive:true});writeFileSync(join(args.cwd,file),'new\n');}
      if(args.prompt.includes('commit')){git(args.cwd,'add','-A');git(args.cwd,'commit','-qm','work');}
      return {status:'completed',result:'ok'};
    }finally{live.delete(args.prompt);}
  };
  const c=new Coordinator({store,runner,...options});
  t.after(async()=>{for(const r of gates.values())r();await c.shutdown();store.close();});
  const done=async(id,provider='opencode')=>{for(let i=0;i<500;i++){const v=c.status(provider,id);if(terminal(v.status)&&!c.active.has(id))return v;await sleep(10);}throw Error('job did not finish');};
  const started=async(prompt)=>{for(let i=0;i<500&&!gates.has(prompt);i++)await sleep(10);assert.ok(gates.has(prompt),prompt+' never started');};
  const release=prompt=>gates.get(prompt)();
  return {c,store,directory,seen,live,done,started,release};
}
const run=async(f,cwd,{worktree=true,write=null,prompt='go',...rest}={})=>{
  const view=await f.c.start('opencode',{prompt:prompt+(write?' write:'+write:''),cwd,worktree,...rest});
  return f.done(view.id);
};

test('a worktree job refuses a dirty source checkout',async t=>{
  const repo=makeRepo(t),f=setup(t);
  writeFileSync(join(repo,'README'),'changed\n');writeFileSync(join(repo,'loose.js'),'x');
  await assert.rejects(()=>f.c.start('opencode',{prompt:'x',cwd:repo,worktree:true}),e=>/uncommitted/.test(e.message)&&/README/.test(e.message)&&/loose\.js/.test(e.message));
  assert.equal(f.store.listWorktrees().length,0);
  assert.equal(git(repo,'branch','--list','bridge/*'),'');
  assert.deepEqual(f.store.list('opencode',{}).jobs,[]);
});

test('a worktree job outside git is refused',async t=>{
  const dir=temp(t,'bridge-wt-nogit-'),f=setup(t);
  await assert.rejects(()=>f.c.start('opencode',{prompt:'x',cwd:dir,worktree:true}),/git repository/);
});

test('a worktree job runs on its own branch and reports what changed',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const view=await run(f,repo,{write:'a.js'});
  assert.equal(view.status,'completed');
  assert.match(view.worktree.branch,/bridge\//);
  assert.equal(view.worktree.branch,'bridge/'+view.id);
  assert.deepEqual(view.worktree.changedFiles,['a.js']);
  assert.ok(existsSync(view.worktree.path));
  assert.ok(view.worktree.path.startsWith(realpathSync(f.directory)+'/'),'worktree lives under the state directory');
  assert.equal(view.cwd,repo,'the stored cwd stays the original path');
  assert.equal(f.seen[0].cwd,view.worktree.path);assert.equal(f.seen[0].worktree,false);
  assert.equal(existsSync(join(repo,'a.js')),false,'the source checkout is untouched');
  assert.equal(git(view.worktree.path,'rev-parse','HEAD'),git(repo,'rev-parse','HEAD'));
});

test('a job started from a subdirectory runs in the same subdirectory of its worktree',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const view=await run(f,join(repo,'sub'),{write:'b.js'});
  assert.equal(f.seen[0].cwd,join(view.worktree.path,'sub'));
  assert.equal(f.seen[0].configCwd,join(repo,'sub'),'configuration is read at the source, with its ancestors and ignored files');
  assert.deepEqual(view.worktree.changedFiles,['sub/b.js']);
});

test('a clean worktree is removed automatically; a dirty one is kept',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const clean=await run(f,repo,{write:null});
  assert.equal(existsSync(clean.worktree.path),false);
  assert.equal(clean.worktree.removed,true);
  assert.equal(f.store.listWorktrees().length,0);
  assert.equal(git(repo,'branch','--list','bridge/*'),'','the branch goes with the tree');
  const dirty=await run(f,repo,{write:'a.js'});
  assert.equal(existsSync(dirty.worktree.path),true);
  assert.equal(dirty.worktree.removed,false);
  assert.equal(f.store.listWorktrees().length,1);
});

test('a committed change counts as a change: the worktree is kept and cleanup needs discard',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const view=await run(f,repo,{write:'c.js',prompt:'commit'});
  assert.equal(existsSync(view.worktree.path),true);
  assert.deepEqual(view.worktree.changedFiles,['c.js']);
  assert.equal(worktreeStatus(view.worktree.path).dirty,true);
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId:view.worktree.id}),/discard/);
});

test('a failed job with changes keeps its worktree',async t=>{
  const repo=makeRepo(t),f=setup(t,{});
  f.c.runner=async(p,args)=>{writeFileSync(join(args.cwd,'half.js'),'x');throw Error('boom');};
  const view=await run(f,repo);
  assert.equal(view.status,'failed');assert.equal(existsSync(view.worktree.path),true);assert.deepEqual(view.worktree.changedFiles,['half.js']);
});

test('cleanup refuses a dirty worktree without discard, and refuses a live one always',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const parent=await run(f,repo,{write:'a.js'}),{id:worktreeId,path}=parent.worktree;
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId}),/discard/);
  const child=await f.c.start('opencode',{prompt:'hold',cwd:repo,parentJobId:parent.id});
  await f.started('hold');
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId,discard:true}),/still running/);
  assert.equal(existsSync(path),true);
  f.release('hold');await f.done(child.id);
  assert.deepEqual(await f.c.cleanup('opencode',{worktreeId,discard:true}),{worktreeId,removed:true});
  assert.equal(existsSync(path),false);
  assert.equal(f.store.listWorktrees().length,0);
  assert.equal(git(repo,'branch','--list','bridge/*'),'');
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId}),/not found/);
  await assert.rejects(()=>f.c.cleanup('claude',{worktreeId}),/opencode/);
});

test('cleanup refuses a queued owner and a held owner whose delegate was never proven stopped',async t=>{
  const repo=makeRepo(t),other=makeRepo(t),f=setup(t,{maxActive:1});
  const parent=await run(f,repo,{write:'a.js'}),{id:worktreeId,path}=parent.worktree;
  // The only slot is taken elsewhere, so a resume into the worktree waits in the queue.
  const busy=await f.c.start('opencode',{prompt:'hold',cwd:other});await f.started('hold');
  const child=await f.c.start('opencode',{prompt:'next',cwd:repo,parentJobId:parent.id});
  await sleep(30);assert.equal(f.c.status('opencode',child.id).status,'queued');
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId,discard:true}),/still running/);
  // Cancelling a queued resume never removes the parent's tree.
  assert.equal(f.c.cancel('opencode',child.id).status,'cancelled');assert.equal(existsSync(path),true);
  f.release('hold');await f.done(busy.id);
  f.store.update(parent.id,{openCode:{sessionId:'s',endpoint:'http://x',interrupt:'unconfirmed'}});
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId,discard:true}),/still running/);
  assert.equal(existsSync(path),true);
  f.store.confirm(parent.id,'forced');
  assert.equal((await f.c.cleanup('opencode',{worktreeId,discard:true})).removed,true);
});

test('cleanup refuses a worktree whose job is still being created, and a racing retry leaves one tree',async t=>{
  const repo=makeRepo(t),gate=Promise.withResolvers();let entered;const reached=new Promise(r=>{entered=r;});
  const f=setup(t,{resolveProject:async cwd=>{const r=await resolveProject(cwd);if(cwd.includes('bridge-wt-state-')){entered();await gate.promise;}return r;}});
  const input={prompt:'go',cwd:repo,worktree:true,requestId:'same'};
  const first=f.c.start('opencode',input),second=f.c.start('opencode',input);
  await reached;
  const [row]=f.store.listWorktrees();
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId:row.id,discard:true}),/still running/);
  gate.resolve();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.id,b.id);
  await f.done(a.id);
  assert.equal(f.store.listWorktrees().length,0,'the loser removed its tree and the winner, clean, was auto-removed');
  assert.equal(git(repo,'worktree','list','--porcelain').match(/^worktree /gm).length,1);
  assert.equal(git(repo,'branch','--list','bridge/*'),'');
});

test('cancelling a queued worktree job removes the fresh tree it never used',async t=>{
  const repo=makeRepo(t),other=makeRepo(t),f=setup(t,{maxActive:1});
  const busy=await f.c.start('opencode',{prompt:'hold',cwd:other});await f.started('hold');
  const queued=await f.c.start('opencode',{prompt:'never',cwd:repo,worktree:true});
  assert.equal(existsSync(queued.worktree.path),true);
  const view=f.c.cancel('opencode',queued.id);
  assert.equal(view.status,'cancelled');assert.equal(view.worktree.removed,true);
  assert.equal(existsSync(queued.worktree.path),false);assert.equal(f.store.listWorktrees().length,0);
  f.release('hold');await f.done(busy.id);
});

test('a clean finish never removes a worktree its delegate may still be writing to',async t=>{
  const repo=makeRepo(t),f=setup(t);
  f.c.runner=async(p,args,update)=>{update({openCode:{sessionId:'s',endpoint:'http://x',interrupt:'unconfirmed'}},[]);return {status:'cancelled'};};
  const view=await run(f,repo);
  assert.equal(existsSync(view.worktree.path),true);assert.equal(view.worktree.removed,false);
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId:view.worktree.id,discard:true}),/still running/);
});

test('cleanup refuses a worktree an in-place job is running in, even with discard and before it writes',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const base=await run(f,repo,{write:'a.js',prompt:'commit'}),{id:worktreeId,path}=base.worktree;
  const job=await f.c.start('claude',{prompt:'hold',cwd:join(path,'sub')});await f.started('hold');
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId}),/still running/);
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId,discard:true}),/still running/);
  assert.equal(existsSync(path),true);
  f.release('hold');await f.done(job.id,'claude');
  assert.equal((await f.c.cleanup('opencode',{worktreeId,discard:true})).removed,true);
});

test('a clean worktree is not auto-removed while an in-place job waits to run in it',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const x=await f.c.start('opencode',{prompt:'hold-x',cwd:repo,worktree:true});await f.started('hold-x');
  const y=await f.c.start('codex',{prompt:'hold-y',cwd:x.worktree.path});
  await sleep(30);assert.equal(f.c.status('codex',y.id).status,'queued');
  f.release('hold-x');const done=await f.done(x.id);
  assert.equal(done.worktree.removed,false);assert.equal(existsSync(x.worktree.path),true);
  await f.started('hold-y');assert.equal(f.seen.at(-1).cwd,x.worktree.path);
  f.release('hold-y');await f.done(y.id,'codex');
});

test('ignored files a delegate writes count as changes; ignored files present at creation do not',async t=>{
  const repo=makeRepo(t);
  writeFileSync(join(repo,'.gitignore'),'out/\n*.log\n');git(repo,'add','.');git(repo,'commit','-qm','ignore');
  // A checkout hook that generates an ignored file: that file is part of the fresh tree, not the delegate's work.
  writeFileSync(join(repo,'.git','hooks','post-checkout'),'#!/bin/sh\necho gen > checkout.log\n',{mode:0o755});
  const f=setup(t);
  const clean=await run(f,repo);
  assert.equal(clean.worktree.removed,true,JSON.stringify(clean.worktree));
  const kept=await run(f,repo,{write:'out/report.txt'});
  assert.equal(kept.worktree.removed,false);
  assert.deepEqual(kept.worktree.changedFiles,['out/'],'an ignored directory is reported whole');
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId:kept.worktree.id}),/discard/);
  assert.equal(existsSync(join(kept.worktree.path,'out','report.txt')),true);
});

test('thousands of ignored and untracked files keep the report small, the list lean and the service up',async t=>{
  const repo=makeRepo(t);
  writeFileSync(join(repo,'.gitignore'),'node_modules/\n');git(repo,'add','.');git(repo,'commit','-qm','ignore');
  let fatal=null;const f=setup(t,{onFatal:e=>{fatal=e;}});
  // An `npm ci` in the tree: thousands of ignored files with long paths, plus many untracked ones outside any ignore.
  f.c.runner=async(p,args)=>{
    for(let i=0;i<3000;i++){const d=join(args.cwd,'node_modules','pkg-'+i%50,'lib'.repeat(20));mkdirSync(d,{recursive:true});writeFileSync(join(d,'file-'+i+'.js'),'x');}
    mkdirSync(join(args.cwd,'gen'));for(let i=0;i<1500;i++)writeFileSync(join(args.cwd,'gen','out-'+i+'.txt'),'x');
    return {status:'completed',result:'ok'};
  };
  const view=await run(f,repo);
  assert.equal(fatal,null);assert.equal(view.status,'completed');assert.equal(view.worktree.removed,false);
  assert.equal(view.worktree.changedFiles.length,200);assert.equal(view.worktree.truncated,true);
  assert.equal(view.worktree.changedCount,1501,'node_modules/ counts once, each untracked file once');
  assert.ok(view.worktree.changedFiles.includes('gen/out-0.txt'));
  rmSync(join(view.worktree.path,'gen'),{recursive:true});
  assert.deepEqual(worktreeStatus(view.worktree.path).changedFiles,['node_modules/']);
  const [summary]=f.c.list('opencode',{}).jobs;
  assert.equal(summary.worktree.changedFiles,undefined);assert.equal(summary.worktree.changedCount,1501);assert.equal(summary.worktree.id,view.worktree.id);
});

test('an oversized terminal view is trimmed and stored instead of stopping the service',async t=>{
  const repo=makeRepo(t);let fatal=null;const f=setup(t,{onFatal:e=>{fatal=e;}});
  f.c.runner=async(p,args)=>{writeFileSync(join(args.cwd,'a.js'),'x');return {status:'completed',result:'r'.repeat(4_600_000)};};
  const view=await run(f,repo);
  assert.equal(fatal,null);assert.equal(f.c.closing,false);
  assert.equal(view.status,'completed');assert.match(view.result,/result truncated/);assert.ok(view.result.length<1_100_000);
  assert.deepEqual(view.worktree.changedFiles,[]);assert.equal(view.worktree.truncated,true);assert.equal(view.worktree.changedCount,1);
  assert.equal(existsSync(view.worktree.path),true,'the delegate\'s work is kept');
});

test('a rename reports both its old and new path',async t=>{
  const repo=makeRepo(t),root=temp(t,'bridge-wt-root-');
  const tree=await createWorktree({project:repo,jobId:'j2',root});
  git(tree.path,'mv','README','RENAMED');
  assert.deepEqual(worktreeStatus(tree.path),{dirty:true,changedFiles:['README','RENAMED'],changedCount:2,truncated:false});
});

test('a failed creation keeps the row when its partial tree cannot be removed',async t=>{
  const repo=makeRepo(t);
  // The checkout hook breaks the new tree and fails, leaving a directory that is no longer a worktree.
  writeFileSync(join(repo,'.git','hooks','post-checkout'),'#!/bin/sh\nrm -f .git\nexit 1\n',{mode:0o755});
  const f=setup(t);
  await assert.rejects(()=>f.c.start('opencode',{prompt:'x',cwd:repo,worktree:true}),/Could not create worktree/);
  const rows=f.store.listWorktrees();
  assert.equal(rows.length,1,'the partial tree stays discoverable');
  assert.equal(existsSync(rows[0].path),true);
  assert.equal(f.c.diagnostics().worktrees.count,1);
});

test('worktree records survive pruning of their job',async t=>{
  const repo=makeRepo(t),other=makeRepo(t),f=setup(t,{storeOptions:{maxHistory:1}});
  const kept=await run(f,repo,{write:'a.js'});
  await run(f,other,{worktree:false});
  f.store.prune();
  assert.throws(()=>f.store.get('opencode',kept.id),/not found/);
  assert.equal(f.store.listWorktrees().length,1);
  assert.equal(f.c.diagnostics().worktrees.count,1);
  assert.equal(f.c.diagnostics().worktrees.items[0].id,kept.worktree.id);
  // With its job gone the worktree is unowned, so it can still be cleaned up.
  assert.equal((await f.c.cleanup('opencode',{worktreeId:kept.worktree.id,discard:true})).removed,true);
});

test('two worktree jobs on one repository run concurrently; in-place jobs still serialise',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const a=await f.c.start('opencode',{prompt:'hold-a',cwd:repo,worktree:true}),b=await f.c.start('opencode',{prompt:'hold-b',cwd:repo,worktree:true});
  await f.started('hold-a');await f.started('hold-b');
  assert.deepEqual([...f.live].sort(),['hold-a','hold-b']);
  assert.notEqual(a.worktree.path,b.worktree.path);
  // An in-place job on the same repository is not blocked by worktree jobs.
  const c=await f.c.start('opencode',{prompt:'hold-c',cwd:repo}),d=await f.c.start('opencode',{prompt:'hold-d',cwd:repo});
  await f.started('hold-c');await sleep(50);
  assert.equal(f.c.status('opencode',d.id).status,'queued');assert.equal(f.live.has('hold-d'),false);
  f.release('hold-c');await f.done(c.id);await f.started('hold-d');
  for(const p of ['hold-a','hold-b','hold-d'])f.release(p);
  for(const j of [a,b,d])await f.done(j.id);
});

test('resume re-enters the parent worktree, and is rejected once it is gone',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const parent=await run(f,repo,{write:'a.js'});
  const child=await f.c.start('opencode',{prompt:'more',cwd:repo,parentJobId:parent.id});
  assert.equal(child.worktree.path,parent.worktree.path);
  assert.equal(child.worktree.id,parent.worktree.id);
  const finished=await f.done(child.id);
  assert.equal(f.seen.at(-1).cwd,parent.worktree.path);assert.equal(f.seen.at(-1).sessionId,'s-go write:a.js');
  assert.equal(finished.worktree.path,parent.worktree.path);
  removeWorktree(parent.worktree.path,{discard:true});
  await assert.rejects(()=>f.c.start('opencode',{prompt:'more',cwd:repo,parentJobId:parent.id}),/worktree/);
});

test('a bare sessionId resume follows the job that ran the session: its worktree, its lock and its cwd',async t=>{
  const repo=makeRepo(t),other=makeRepo(t),f=setup(t);
  const parent=await run(f,repo,{write:'a.js',sessionId:'S1'}),session=parent.sessionId,{id:worktreeId,path}=parent.worktree;
  await assert.rejects(()=>f.c.start('opencode',{prompt:'x',cwd:other,sessionId:session}),e=>e.message.includes(parent.id)&&/resume must use that cwd/.test(e.message));
  const child=await f.c.start('opencode',{prompt:'hold',cwd:repo,sessionId:session});
  assert.equal(child.worktree.id,worktreeId);
  await f.started('hold');
  assert.equal(f.seen.at(-1).cwd,path);assert.equal(f.seen.at(-1).sessionId,session);
  // The tree has an owner, so it cannot be force-removed under the delegate; an in-place job in the source still runs.
  await assert.rejects(()=>f.c.cleanup('opencode',{worktreeId,discard:true}),/still running/);
  const inPlace=await f.c.start('opencode',{prompt:'hold-src',cwd:repo});await f.started('hold-src');
  // While it runs, a further bare resume of that session is refused rather than queued against an unknown tree.
  await assert.rejects(()=>f.c.start('opencode',{prompt:'again',cwd:repo,sessionId:session}),/must be finished/);
  f.release('hold');f.release('hold-src');await f.done(child.id);await f.done(inPlace.id);
  assert.equal(existsSync(path),true);
  // An in-place session resumed bare keeps the in-place rules; an unknown session is left to the adapter's checks.
  const flat=await run(f,other,{worktree:false,prompt:'flat',sessionId:'F1'});
  await assert.rejects(()=>f.c.start('opencode',{prompt:'x',cwd:other,sessionId:flat.sessionId,worktree:true}),/new worktree/);
  const resumed=await run(f,other,{worktree:false,sessionId:flat.sessionId,prompt:'more'});
  assert.equal(resumed.status,'completed');assert.equal(resumed.worktree,undefined);
  assert.equal((await run(f,other,{worktree:false,sessionId:'never-seen'})).status,'completed');
});

test('a queued resume whose worktree vanishes fails instead of running elsewhere',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const parent=await run(f,repo,{write:'a.js'});
  const a=await f.c.start('opencode',{prompt:'hold',cwd:repo,parentJobId:parent.id});
  const b=await f.c.start('opencode',{prompt:'late',cwd:repo,parentJobId:parent.id});
  await f.started('hold');
  rmSync(parent.worktree.path,{recursive:true,force:true});
  f.release('hold');await f.done(a.id);
  const late=await f.done(b.id);
  assert.equal(late.status,'failed');assert.match(late.error,/worktree/);
  assert.equal(f.seen.some(s=>s.prompt==='late'),false);
});

test('resuming an in-place session into a new worktree is refused',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const parent=await run(f,repo,{worktree:false});
  await assert.rejects(()=>f.c.start('opencode',{prompt:'more',cwd:repo,parentJobId:parent.id,worktree:true}),/worktree/);
});

test('a cwd that is already a bridge worktree does not alias its parent repository',async t=>{
  const repo=makeRepo(t),f=setup(t);
  const base=await run(f,repo,{write:'a.js',prompt:'commit'}),wt=base.worktree.path;
  // An in-place job inside the bridge worktree locks the worktree, not the repository it came from.
  const inWt=await f.c.start('opencode',{prompt:'hold-wt',cwd:join(wt,'sub')}),inRepo=await f.c.start('opencode',{prompt:'hold-repo',cwd:repo});
  await f.started('hold-wt');await f.started('hold-repo');
  assert.deepEqual([...f.live].sort(),['hold-repo','hold-wt']);
  // ...but it does serialise with another job in that same worktree.
  const again=await f.c.start('opencode',{prompt:'hold-again',cwd:wt});
  await sleep(50);assert.equal(f.c.status('opencode',again.id).status,'queued');
  f.release('hold-wt');f.release('hold-repo');await f.done(inWt.id);await f.done(inRepo.id);
  await f.started('hold-again');f.release('hold-again');await f.done(again.id);
  // A worktree started from a bridge worktree is a sibling under the state directory, never nested inside it.
  const nested=await run(f,wt,{write:'n.js'});
  assert.equal(nested.status,'completed');
  assert.notEqual(nested.worktree.path,wt);
  assert.equal(nested.worktree.path.startsWith(wt+'/'),false);
  assert.ok(nested.worktree.path.startsWith(realpathSync(f.directory)+'/'));
  assert.equal(git(nested.worktree.path,'rev-parse','HEAD'),git(wt,'rev-parse','HEAD'),'branched from the bridge worktree it was asked for');
  assert.deepEqual(nested.worktree.changedFiles,['n.js']);
});

test('a worktree root inside the source repository is refused rather than nesting',async t=>{
  const repo=makeRepo(t);
  writeFileSync(join(repo,'.gitignore'),'state/\n');git(repo,'add','.');git(repo,'commit','-qm','ignore');
  const f=setup(t,{worktreeRoot:join(repo,'state','worktrees')});
  await assert.rejects(()=>f.c.start('opencode',{prompt:'x',cwd:repo,worktree:true}),/inside/);
  assert.equal(git(repo,'branch','--list','bridge/*'),'');
});

test('a crash leaves either a row with no tree or a tree with no job, and cleanup survives both',async t=>{
  const repo=makeRepo(t),f=setup(t),root=join(f.directory,'worktrees');
  // Row written, tree never created.
  f.store.putWorktree({id:'w-gone',job:'j-gone',project:repo,branch:'bridge/j-gone',path:join(root,'j-gone'),created:new Date().toISOString()});
  assert.equal((await f.c.cleanup('opencode',{worktreeId:'w-gone'})).removed,true);
  // Tree created, job row never inserted.
  const tree=await createWorktree({project:repo,jobId:'j-orphan',root});
  f.store.putWorktree({id:'w-orphan',job:'j-orphan',project:repo,...tree,created:new Date().toISOString()});
  assert.equal((await f.c.cleanup('opencode',{worktreeId:'w-orphan'})).removed,true);
  assert.equal(existsSync(tree.path),false);
  assert.equal(git(repo,'branch','--list','bridge/*'),'');
  assert.equal(f.store.listWorktrees().length,0);
});

test('removeWorktree refuses a dirty tree without discard and always takes the branch with it',async t=>{
  const repo=makeRepo(t),root=temp(t,'bridge-wt-root-');
  const tree=await createWorktree({project:repo,jobId:'j1',root});
  assert.deepEqual(tree,{path:join(root,'j1'),branch:'bridge/j1'});
  assert.deepEqual(worktreeStatus(tree.path),{dirty:false,changedFiles:[],changedCount:0,truncated:false});
  writeFileSync(join(tree.path,'README'),'edit\n');
  assert.deepEqual(worktreeStatus(tree.path),{dirty:true,changedFiles:['README'],changedCount:1,truncated:false});
  assert.throws(()=>removeWorktree(tree.path),/discard/);
  assert.equal(existsSync(tree.path),true);
  removeWorktree(tree.path,{discard:true});
  assert.equal(existsSync(tree.path),false);
  assert.equal(git(repo,'branch','--list','bridge/*'),'');
  assert.equal(git(repo,'worktree','list','--porcelain').includes(tree.path),false);
});

test('opencode_cleanup takes a worktreeId and an optional discard',()=>{
  assert.deepEqual(validateCall('opencode','cleanup',{worktreeId:'w',discard:true}).inputSchema.required,['worktreeId']);
  assert.throws(()=>validateCall('opencode','cleanup',{}),/Missing worktreeId/);
  assert.throws(()=>validateCall('opencode','cleanup',{worktreeId:'w',discard:'yes'}),/Invalid discard/);
  assert.throws(()=>validateCall('opencode','cleanup',{worktreeId:'w',force:true}),/Unknown argument/);
});
