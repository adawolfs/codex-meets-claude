import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OpenCode, isSessionNotFoundError } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { resolveProject as defaultResolve } from './paths.js';
import { pageArgs } from './store.js';
import { PROVIDERS, LEVELS, OPENCODE_MODEL } from './persistent-tools.js';
import { sourceChanges, planWorktree, createWorktree, worktreeStatus, removeWorktree, inside } from './worktrees.js';
const timestamp = () => new Date().toISOString();
const bare = url => { const u = new URL(url); u.username = u.password = u.search = u.hash = ''; return u.href.replace(/\/$/, ''); };
// True only on proof the delegate is stopped: the recorded service accepted the interrupt, or answered that it has no such
// session (the client's typed SessionNotFoundError for this very id). Anything else, transport failures included, is not
// proof. It never starts a service, and an unregistered one proves nothing: `opencode serve` may run elsewhere.
export const openCodeAborter = ({ service = Service, connect = o => OpenCode.make(o), timeoutMs = 5000 } = {}) => async ({ sessionId, endpoint }) => {
  let timer;
  try {
    const live = await service.discover();
    // The recorded endpoint carries no credentials; a service elsewhere is a different instance.
    if (!live || bare(live.url) !== bare(endpoint)) return false;
    const client = connect({ baseUrl: live.url, headers: service.headers(live) });
    return await Promise.race([(async () => client.session.interrupt({ sessionID: sessionId }))().then(() => true, e => isSessionNotFoundError(e) && e.sessionID === sessionId), new Promise(r => { timer = setTimeout(r, timeoutMs, false); })]);
  } catch { return false; } finally { clearTimeout(timer); }
};
export function validateStart(provider, input) {
  if (!PROVIDERS.includes(provider)) throw Error('Invalid provider');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('arguments must be an object');
  const keys = ['prompt','cwd','sessionId','model','requestId','parentJobId',...(provider === 'claude' ? ['permissionMode','maxTurns','maxBudgetUsd'] : provider === 'opencode' ? ['level','worktree'] : [])];
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw Error('Unknown argument: '+key);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 100000) throw Error('Invalid prompt (1-100000 characters)');
  if (typeof input.cwd !== 'string' || !input.cwd || input.cwd.length > 4096) throw Error('Invalid cwd');
  for (const key of ['sessionId','model','requestId','parentJobId']) {
    const pattern = key === 'model' && provider === 'opencode' ? OPENCODE_MODEL : /^[a-zA-Z0-9._-]{1,128}$/;
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !pattern.test(input[key]))) throw Error('Invalid '+key);
  }
  if (input.permissionMode !== undefined && !['plan','acceptEdits'].includes(input.permissionMode)) throw Error('Invalid permissionMode');
  if (input.maxTurns !== undefined && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 1000)) throw Error('Invalid maxTurns');
  if (input.maxBudgetUsd !== undefined && (typeof input.maxBudgetUsd !== 'number' || !Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0)) throw Error('Invalid maxBudgetUsd');
  if (input.level !== undefined && !LEVELS.includes(input.level)) throw Error('Invalid level');
  if (input.worktree !== undefined && typeof input.worktree !== 'boolean') throw Error('Invalid worktree');
  return { ...input, requestId: input.requestId ?? randomUUID(),
    ...(provider === 'claude' ? {permissionMode: input.permissionMode ?? 'plan',maxTurns: input.maxTurns ?? 50} : provider === 'opencode' ? {level: input.level ?? 'read-only',worktree: input.worktree ?? false} : {}) };
}
export class Coordinator {
  constructor({ store, runner, resolveProject = defaultResolve, maxActive = 4, maxQueued = 100, abortSession = openCodeAborter(), worktreeRoot = join(store.directory,'worktrees'), onFatal = error => { console.error('Storage failure:',error.message); process.exitCode=1; } }) {
    for (const n of [maxActive,maxQueued]) if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid queue limit');
    Object.assign(this,{store,runner,resolveProject,maxActive,maxQueued,abortSession,worktreeRoot,onFatal});
    this.active=new Map();this.creating=new Set();this.closing=false;this.pumping=false;this.recovered=false;
    // Nothing is eligible until recovery has settled; a row it could not release keeps its project out of pump.
    store.recover({abortSession}).then(()=>{if(this.closing)return;store.prune();this.recovered=true;this.pump();}).catch(error=>{if(!this.closing)this.fail(error);});
  }
  async start(provider,input) {
    if (this.closing) throw Error('Service is shutting down');
    const args=validateStart(provider,input);
    const original={...args};
    const prior=this.store.findRequest(provider,original);
    if(prior)return prior;
    const {cwd,project}=await this.resolveProject(args.cwd);args.cwd=cwd;
    if(this.closing)throw Error('Service is shutting down');
    let lock=project,worktree;
    if(args.parentJobId){
      const parent=this.store.get(provider,args.parentJobId);
      if(['queued','running'].includes(parent.status)||!parent.sessionId)throw Error('Parent must be finished and have a sessionId');
      if(parent.cwd!==cwd)throw Error('Resume must use the original cwd');
      if(args.sessionId && args.sessionId!==parent.sessionId)throw Error('sessionId does not match parent');
      args.sessionId=parent.sessionId;
      // The worktree comes from its table, never from cwd: a worktree job's stored cwd is the source checkout.
      if(parent.worktree){
        const row=this.store.getWorktree(parent.worktree.id);
        if(!row||!existsSync(row.path))throw Error(`The parent's worktree ${parent.worktree.path} no longer exists; resume is refused rather than run in another directory`);
        worktree={id:row.id,branch:row.branch,path:row.path};lock=row.path;
      } else if(args.worktree)throw Error('Cannot resume an in-place session into a new worktree');
    }
    const admit=()=>{
      if(this.closing)throw Error('Service is shutting down');
      const existing=this.store.findRequest(provider,original);
      if(!existing&&this.store.queued().length>=this.maxQueued)throw Error('Queue is full; retry later with the same requestId');
      return existing;
    };
    const existing=admit();
    if(existing)return existing;
    const id=randomUUID();
    if(args.worktree&&!worktree)return this.isolate(provider,args,original,project,id,admit);
    const view=this.store.insert(provider,args,lock,original,{id,worktree});
    this.pump();
    return view;
  }
  // The row is written before the tree exists, so a crash at any point leaves the worktree discoverable.
  async isolate(provider,args,original,project,id,admit){
    const dirty=sourceChanges(project);
    if(dirty.length)throw Error(`The source checkout ${project} has uncommitted changes (${dirty.slice(0,20).join(', ')}${dirty.length>20?', ...':''}); commit or stash them before starting a worktree job`);
    const row={id:randomUUID(),job:id,project,...planWorktree({project,jobId:id,root:this.worktreeRoot}),created:timestamp()};
    this.store.putWorktree(row);this.creating.add(row.id);
    let inserted=false;
    try {
      await createWorktree({project,jobId:id,root:this.worktreeRoot});
      const {project:lock}=await this.resolveProject(row.path);
      const existing=admit();
      if(existing)return existing;
      const view=this.store.insert(provider,args,lock,original,{id,worktree:{id:row.id,branch:row.branch,path:row.path}});
      inserted=true;this.pump();
      return view;
    } finally {
      this.creating.delete(row.id);
      // Nothing owns a fresh tree that never got its job, so it is safe to drop; the row goes only once the tree has.
      if(!inserted&&this.store.getWorktree(row.id)){try{removeWorktree(row.path,{discard:true,branch:row.branch,repo:project});this.store.deleteWorktree(row.id);}catch{}}
    }
  }
  pump() {
    if(this.closing||this.pumping||!this.recovered)return;
    this.pumping=true;
    try {
      const holds=this.holds(),held=new Set(holds.map(r=>r.project)),heldSessions=new Set(holds.filter(r=>r.sessionId).map(r=>r.provider+'\0'+r.sessionId));
      for(const job of this.store.queued()){
        if(this.active.size>=this.maxActive)break;
        const busy=held.has(job.project)||(job.args.sessionId&&heldSessions.has(job.provider+'\0'+job.args.sessionId))||[...this.active.values()].some(a=>a.project===job.project ||
          (job.args.sessionId && a.provider===job.provider && a.sessionId===job.args.sessionId));
        if(busy)continue;
        this.store.update(job.id,{status:'running',startedAt:timestamp(),progress:{phase:'starting',text:''}});
        const record={...job,sessionId:job.args.sessionId,controller:new AbortController(),cancelled:false};
        this.active.set(job.id,record);
        record.done=this.execute(record);
      }
    } catch(error){this.fail(error);} finally {this.pumping=false;}
  }
  async execute(record) {
    let outcome;
    try {
      outcome=await this.runner(record.provider,this.prepare(record),(patch,events=[])=>{
        if(patch.sessionId)record.sessionId=patch.sessionId;
        // Terminal status belongs to the coordinator, only after runner cleanup; the worktree report too.
        const {status,finishedAt,id,worktree,...progress}=patch;
        this.store.update(record.id,progress);
        this.store.appendEvents(record.id,events);
      },record.controller.signal);
    } catch(error) {if(error.code==='CLEANUP_FAILED'){this.fail(error);return;}outcome={status:'failed',error:String(error.message||error).slice(0,4000)};}
    try {
      if(this.closing)outcome={...outcome,status:'interrupted',error:'Service stopped; inspect workspace before explicit resume.'};
      else if(record.cancelled)outcome={...outcome,status:'cancelled',result:null};
      if(!['completed','failed','cancelled','timed_out','interrupted'].includes(outcome?.status))
        outcome={status:'failed',error:'Provider ended without a terminal result'};
      const {worktree,...result}=outcome;
      // Settled while the row is still running, so cleanup refuses throughout.
      this.finish(record.id,{...result,...(record.worktree?{worktree:this.settle(record,result)}:{}),finishedAt:timestamp(),progress:{phase:outcome.status,text:'',updatedAt:timestamp()}});
      this.store.prune();
    } catch(error){this.fail(error);}
    finally {this.active.delete(record.id);queueMicrotask(()=>this.pump());}
  }
  // An oversized terminal view degrades rather than stopping the service: first the worktree's file list goes, then the
  // result is cut. Its status, error and worktree identity always land.
  finish(id,patch){
    const trims=[p=>p,p=>p.worktree?{...p,worktree:{...p.worktree,changedFiles:[],truncated:true}}:p,
      p=>typeof p.result==='string'?{...p,result:p.result.slice(0,1_000_000)+'\n[result truncated: it exceeded the storage limit]'}:p];
    for(let i=0,next=patch;;i++){
      next=trims[i](next);
      try{return this.store.update(id,next);}catch(error){if(error.code!=='TOO_LARGE'||i===trims.length-1)throw error;}
    }
  }
  // A worktree job runs in its worktree, at the same subdirectory it was started from.
  prepare(record){
    const {view}=this.store.record(record.id);
    if(!view.worktree)return record.args;
    const row=this.store.getWorktree(view.worktree.id);
    if(!row||!existsSync(row.path))throw Error(`Worktree ${view.worktree.path} no longer exists; the job was not started`);
    record.worktree=row;
    const sub=join(row.path,relative(row.project,record.args.cwd));
    return {...record.args,cwd:inside(row.path,sub)&&existsSync(sub)?sub:row.path,worktree:false};
  }
  // Removes only a provably clean tree, and never one a delegate may still write to or another job is waiting to use.
  // An interrupted job keeps its tree: interruption is the state that anticipates an explicit resume.
  settle(record,{status,openCode}){
    const row=record.worktree,report={id:row.id,branch:row.branch,path:row.path,changedFiles:null,removed:false};
    try{
      const {dirty,changedFiles,changedCount,truncated}=worktreeStatus(row.path,{branch:row.branch});Object.assign(report,{changedFiles,changedCount,truncated});
      const held=(openCode??this.store.record(record.id).view.openCode)?.interrupt==='unconfirmed';
      if(dirty||held||status==='interrupted'||this.store.worktreeOwners(row).some(o=>o.id!==record.id))return report;
      removeWorktree(row.path,{branch:row.branch,repo:row.project});this.store.deleteWorktree(row.id);report.removed=true;
    }catch(error){report.error=String(error.message||error).slice(0,1000);}
    return report;
  }
  async cleanup(provider,{worktreeId,discard=false}={}){
    if(provider!=='opencode')throw Error('cleanup is only supported for opencode');
    const row=this.store.getWorktree(worktreeId);
    if(!row)throw Error('worktree not found');
    const owner=this.creating.has(row.id)?{id:row.job}:this.store.worktreeOwners(row)[0];
    if(owner)throw Error(`Worktree ${row.id} is in use: job ${owner.id} is still running, queued, or holds an OpenCode session not proven stopped; wait for it, or cancel it first`);
    removeWorktree(row.path,{discard,branch:row.branch,repo:row.project});
    this.store.deleteWorktree(row.id);
    return {worktreeId:row.id,removed:true};
  }
  holds(){return this.store.unrecovered(new Set(this.active.keys()));}
  fail(error){
    this.closing=true;
    for(const record of this.active.values())record.controller.abort();
    this.onFatal(error);
  }
  status(provider,id){return this.store.get(provider,id);}
  list(provider,args){pageArgs(args);return this.store.list(provider,args);}
  events(provider,id,args){return this.store.events(provider,id,args);}
  cancel(provider,id,{force=false}={}){
    if(force&&provider!=='opencode')throw Error('force is only supported for opencode');
    const job=this.store.get(provider,id);
    if(job.status==='queued'){
      // A worktree this job created never ran anything, so it goes now rather than accumulating.
      const row=job.worktree&&this.store.getWorktree(job.worktree.id),own=row?.job===id;
      const result=this.store.update(id,{status:'cancelled',finishedAt:timestamp(),progress:{phase:'cancelled',text:''},...(own?{worktree:this.settle({id,worktree:row},{status:'cancelled'})}:{})});
      this.store.prune();return result;
    }
    if(this.holds().some(r=>r.id===id))return this.release(job,force);
    const record=this.active.get(id);
    if(record){record.cancelled=true;this.store.update(id,{cancelRequested:true});record.controller.abort();}
    return this.store.get(provider,id);
  }
  // Cancelling a held row retries its abort; only a confirmed one releases the project and session.
  async release(job,force){
    if(force){this.store.confirm(job.id,'forced');queueMicrotask(()=>this.pump());return this.store.get(job.provider,job.id);}
    const {sessionId,endpoint}=job.openCode??{};
    let ok=false;
    try{ok=sessionId&&endpoint&&(await this.abortSession({provider:job.provider,sessionId,endpoint}))===true;}catch{}
    if(!ok)throw Error(`Could not confirm that OpenCode session ${sessionId} stopped, so its project stays locked; retry cancel once the OpenCode service is reachable, or cancel with force:true to release it without proof (the delegate may still be editing).`);
    this.store.confirm(job.id);queueMicrotask(()=>this.pump());
    return this.store.get(job.provider,job.id);
  }
  diagnostics(){
    const worktrees=this.store.listWorktrees();
    return {version:'0.4.0',status:this.closing?'stopping':'ready',counts:this.store.counts(),unrecovered:this.holds().length,worktrees:{count:worktrees.length,items:worktrees.slice(0,100)},
      limits:{maxActive:this.maxActive,maxQueued:this.maxQueued,maxHistory:this.store.maxHistory,maxAgeMs:this.store.maxAgeMs,maxEvents:this.store.maxEvents}};
  }
  async shutdown(){
    this.closing=true;
    for(const record of this.active.values())record.controller.abort();
    await Promise.all([...this.active.values()].map(r=>r.done));
  }
}
