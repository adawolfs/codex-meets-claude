import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { cleanupProcessGroup, signalTree } from './process-tree.js';
import { ClaudeSdkJobs } from './claude-sdk-jobs.js';
import { OpenCodeJobs } from './opencode-jobs.js';

/** Claude uses Agent SDK, OpenCode its HTTP service. Codex consumes JSONL incrementally. */
export class JobManager {
  constructor({ provider = 'claude', command, prefix = [], ...options } = {}) {
    if (provider === 'claude') return new ClaudeSdkJobs({ command, ...options });
    if (provider === 'opencode') return new OpenCodeJobs(options);
    if (provider !== 'codex') throw Error('invalid provider');
    this.command=command||process.env.CODEX_COMMAND||'codex';this.prefix=prefix;this.jobs=new Map();
    this.timeoutMs=options.timeoutMs??900000;this.maxOutputBytes=options.maxOutputBytes??4000000;
    this.maxJobs=options.maxJobs??100;this.maxConcurrent=options.maxConcurrent??4;
  }
  start({prompt,cwd,sessionId,model,permissionMode='plan'}) {
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>100000)throw Error('Invalid prompt');
    if(typeof cwd!=='string'||!isAbsolute(cwd)||!statSync(cwd).isDirectory())throw Error('cwd must be an existing absolute directory');
    if(sessionId!==undefined&&(typeof sessionId!=='string'||!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)))throw Error('invalid sessionId');
    if(model!==undefined&&(typeof model!=='string'||!/^[a-zA-Z0-9._-]{1,128}$/.test(model)))throw Error('invalid model');
    if(permissionMode!=='plan')throw Error('Codex supports only plan (read-only) mode');
    if([...this.jobs.values()].filter(j=>!j.finishedAt).length>=this.maxConcurrent)throw Error('Maximum concurrent jobs reached');
    while(this.jobs.size>=this.maxJobs){const old=[...this.jobs.values()].find(j=>j.finishedAt);if(!old)throw Error('Maximum retained jobs reached');this.jobs.delete(old.id);}
    const args=[...this.prefix,'exec','--json','--skip-git-repo-check','--sandbox','read-only','-c','mcp_servers.claude-bridge.enabled=false'];
    if(model)args.push('--model',model);if(sessionId)args.push('resume',sessionId);args.push('--',prompt);
    const job={id:randomUUID(),status:'running',startedAt:new Date().toISOString(),cwd,sessionId:sessionId??null,result:null,error:null,progress:{phase:'starting',text:''}};
    this.jobs.set(job.id,job);
    let child;
    try{child=spawn(this.command,args,{cwd,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});}
    catch(error){job.status='failed';job.error=error.message;job.finishedAt=new Date().toISOString();job.done=Promise.resolve();return this.snapshot(job);}
    job.child=child;
    child.once('exit',()=>signalTree(child,'SIGKILL'));
    let killTimer;
    const kill=signal=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
    job.stop=()=>{kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),3000);killTimer.unref();};
    const timer=setTimeout(()=>{if(job.status==='running'){job.status='timed_out';job.stop();}},this.timeoutMs);
    let pending='',stderr='',parseError,spawnError,completed=false,sawMessage=false,sawSession=false;
    const decoder=new StringDecoder('utf8');
    const consume=line=>{
      if(!line.trim()||parseError)return;
      try{
        if(Buffer.byteLength(line)>this.maxOutputBytes)throw Error('output message exceeded byte limit');
        const event=JSON.parse(line);
        if(event.type==='thread.started'){job.sessionId=event.thread_id;sawSession=!!event.thread_id;job.progress.phase='running';}
        if(event.type==='item.completed'&&event.item?.type==='agent_message'){
          if(typeof event.item.text!=='string')throw Error('invalid agent message');
          job.result=event.item.text;job.progress.text=event.item.text.slice(-16000);sawMessage=true;
        }
        if(event.type==='turn.completed'){completed=true;job.usage=event.usage??null;}
        if(event.type==='turn.failed'||event.type==='error')throw Error(event.error?.message||event.message||'Codex turn failed');
      }catch(error){parseError=String(error.message).slice(0,4000);job.stop();}
    };
    child.stdout.on('data',chunk=>{
      if(parseError||job.status!=='running')return;
      pending+=decoder.write(chunk);
      let index;
      while((index=pending.indexOf('\n'))!==-1){const line=pending.slice(0,index);pending=pending.slice(index+1);consume(line);if(parseError){pending='';return;}}
      if(Buffer.byteLength(pending)>this.maxOutputBytes){parseError='output message exceeded byte limit';pending='';job.stop();}
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16000);});
    job.done=new Promise((resolve,reject)=>{
      child.on('error',error=>{spawnError=error.message;});
      child.on('close',async code=>{
        clearTimeout(timer);clearTimeout(killTimer);
        if(job.status==='running'){
          pending+=decoder.end();if(pending)consume(pending);
          if(spawnError||parseError||code!==0||!completed||!sawMessage||!sawSession){job.status='failed';job.error=spawnError||parseError||stderr||'Codex returned incomplete output';}
          else job.status='completed';
        }
        clearTimeout(killTimer);try{await cleanupProcessGroup(child);}catch(error){reject(error);return;}job.finishedAt=new Date().toISOString();job.progress.phase=job.status;resolve();
      });
    });
    return this.snapshot(job);
  }
  get(id){const job=this.jobs.get(id);if(!job)throw Error('job not found');return job;}
  snapshot(job){const {child,done,stop,...view}=job;return structuredClone(view);}
  status(id){return this.snapshot(this.get(id));}
  list(){return [...this.jobs.values()].map(j=>this.snapshot(j));}
  async wait(id){const j=this.get(id);await j.done;return this.snapshot(j);}
  cancel(id){const j=this.get(id);if(j.status==='running'){j.status='cancelled';j.stop();}return this.snapshot(j);}
  async shutdown(){for(const j of this.jobs.values())if(j.status==='running')this.cancel(j.id);await Promise.all([...this.jobs.values()].map(j=>j.done));}
}
