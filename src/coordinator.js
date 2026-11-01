import { randomUUID } from 'node:crypto';
import { resolveProject as defaultResolve } from './paths.js';
import { pageArgs } from './store.js';
import { PROVIDERS, LEVELS } from './persistent-tools.js';
const timestamp = () => new Date().toISOString();
export function validateStart(provider, input) {
  if (!PROVIDERS.includes(provider)) throw Error('Invalid provider');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('arguments must be an object');
  const keys = ['prompt','cwd','sessionId','model','requestId','parentJobId',...(provider === 'claude' ? ['permissionMode','maxTurns','maxBudgetUsd'] : provider === 'opencode' ? ['level','worktree'] : [])];
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw Error('Unknown argument: '+key);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 100000) throw Error('Invalid prompt (1-100000 characters)');
  if (typeof input.cwd !== 'string' || !input.cwd || input.cwd.length > 4096) throw Error('Invalid cwd');
  for (const key of ['sessionId','model','requestId','parentJobId'])
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(input[key]))) throw Error('Invalid '+key);
  if (input.permissionMode !== undefined && !['plan','acceptEdits'].includes(input.permissionMode)) throw Error('Invalid permissionMode');
  if (input.maxTurns !== undefined && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 1000)) throw Error('Invalid maxTurns');
  if (input.maxBudgetUsd !== undefined && (typeof input.maxBudgetUsd !== 'number' || !Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd <= 0)) throw Error('Invalid maxBudgetUsd');
  if (input.level !== undefined && !LEVELS.includes(input.level)) throw Error('Invalid level');
  if (input.worktree !== undefined && typeof input.worktree !== 'boolean') throw Error('Invalid worktree');
  return { ...input, requestId: input.requestId ?? randomUUID(),
    ...(provider === 'claude' ? {permissionMode: input.permissionMode ?? 'plan',maxTurns: input.maxTurns ?? 50} : provider === 'opencode' ? {level: input.level ?? 'read-only',worktree: input.worktree ?? false} : {}) };
}
export class Coordinator {
  constructor({ store, runner, resolveProject = defaultResolve, maxActive = 4, maxQueued = 100, onFatal = error => { console.error('Storage failure:',error.message); process.exitCode=1; } }) {
    for (const n of [maxActive,maxQueued]) if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid queue limit');
    Object.assign(this,{store,runner,resolveProject,maxActive,maxQueued,onFatal});
    this.active=new Map();this.closing=false;this.pumping=false;
    store.recover();store.prune();
    queueMicrotask(()=>this.pump());
  }
  async start(provider,input) {
    if (this.closing) throw Error('Service is shutting down');
    const args=validateStart(provider,input);
    const original={...args};
    const prior=this.store.findRequest(provider,original);
    if(prior)return prior;
    const {cwd,project}=await this.resolveProject(args.cwd);args.cwd=cwd;
    if(this.closing)throw Error('Service is shutting down');
    if(args.parentJobId){
      const parent=this.store.get(provider,args.parentJobId);
      if(['queued','running'].includes(parent.status)||!parent.sessionId)throw Error('Parent must be finished and have a sessionId');
      if(parent.cwd!==cwd)throw Error('Resume must use the original cwd');
      if(args.sessionId && args.sessionId!==parent.sessionId)throw Error('sessionId does not match parent');
      args.sessionId=parent.sessionId;
    }
    const existing=this.store.findRequest(provider,original);
    if(existing)return existing;
    if(this.store.queued().length>=this.maxQueued)throw Error('Queue is full; retry later with the same requestId');
    const view=this.store.insert(provider,args,project,original);
    this.pump();
    return view;
  }
  pump() {
    if(this.closing||this.pumping)return;
    this.pumping=true;
    try {
      for(const job of this.store.queued()){
        if(this.active.size>=this.maxActive)break;
        const busy=[...this.active.values()].some(a=>a.project===job.project ||
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
      outcome=await this.runner(record.provider,record.args,(patch,events=[])=>{
        if(patch.sessionId)record.sessionId=patch.sessionId;
        // Terminal status belongs to the coordinator, only after runner cleanup.
        const {status,finishedAt,id,...progress}=patch;
        this.store.update(record.id,progress);
        this.store.appendEvents(record.id,events);
      },record.controller.signal);
    } catch(error) {if(error.code==='CLEANUP_FAILED'){this.fail(error);return;}outcome={status:'failed',error:String(error.message||error).slice(0,4000)};}
    try {
      if(this.closing)outcome={...outcome,status:'interrupted',error:'Service stopped; inspect workspace before explicit resume.'};
      else if(record.cancelled)outcome={...outcome,status:'cancelled',result:null};
      if(!['completed','failed','cancelled','timed_out','interrupted'].includes(outcome?.status))
        outcome={status:'failed',error:'Provider ended without a terminal result'};
      this.store.update(record.id,{...outcome,finishedAt:timestamp(),progress:{phase:outcome.status,text:'',updatedAt:timestamp()}});
      this.store.prune();
    } catch(error){this.fail(error);}
    finally {this.active.delete(record.id);queueMicrotask(()=>this.pump());}
  }
  fail(error){
    this.closing=true;
    for(const record of this.active.values())record.controller.abort();
    this.onFatal(error);
  }
  status(provider,id){return this.store.get(provider,id);}
  list(provider,args){pageArgs(args);return this.store.list(provider,args);}
  events(provider,id,args){return this.store.events(provider,id,args);}
  cancel(provider,id){
    const job=this.store.get(provider,id);
    if(job.status==='queued'){const result=this.store.update(id,{status:'cancelled',finishedAt:timestamp(),progress:{phase:'cancelled',text:''}});this.store.prune();return result;}
    const record=this.active.get(id);
    if(record){record.cancelled=true;this.store.update(id,{cancelRequested:true});record.controller.abort();}
    return this.store.get(provider,id);
  }
  diagnostics(){
    return {version:'0.3.0',status:this.closing?'stopping':'ready',counts:this.store.counts(),
      limits:{maxActive:this.maxActive,maxQueued:this.maxQueued,maxHistory:this.store.maxHistory,maxAgeMs:this.store.maxAgeMs,maxEvents:this.store.maxEvents}};
  }
  async shutdown(){
    this.closing=true;
    for(const record of this.active.values())record.controller.abort();
    await Promise.all([...this.active.values()].map(r=>r.done));
  }
}
