import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,chmodSync,unlinkSync,existsSync,accessSync,readFileSync,constants } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { Store } from './store.js';
import { Coordinator } from './coordinator.js';
import { createRunner } from './runner.js';
import { stateDirectory } from './client.js';
import { validateCall } from './persistent-tools.js';

export function safeError(error){
 return String(error?.message||error).slice(0,4000)
  .replace(/sk-[a-zA-Z0-9_-]{12,}/g,'[redacted]')
  .replace(/((?:api[_-]?key|token|authorization|password)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]');
}
function executable(path){
 try{accessSync(path,constants.X_OK);return {path,available:true,authentication:'not_probed'};}catch{return {path:path||null,available:false,authentication:'not_probed'};}
}
// The installed client's version, read from its own package.json (the package does not export it).
let pinned;
function clientVersion(){
 if(pinned)return pinned;
 try{
  let dir=dirname(fileURLToPath(import.meta.resolve('@opencode/client')));
  for(;dir!==dirname(dir);dir=dirname(dir)){
   try{const meta=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));if(meta.name==='@opencode/client')return pinned=String(meta.version);}catch{}
  }
 }catch{}
 return 'unknown';
}
// Read-only: discover() never starts a service and the only request is server.info(); no inference, no credential check beyond the registered ones.
// The budget must stay well under launch.js's 1000 ms readiness timeout: a wedged OpenCode service must never stop Claude or Codex launching.
// A timed-out info request is aborted. discover() takes no signal, but its own probe is capped at 2 s by the client.
export const openCodeProbe=({service=Service,connect=o=>OpenCode.make(o),timeoutMs=500}={})=>async()=>{
 const out=(status,version=null)=>({status,serviceVersion:typeof version==='string'&&version?version.slice(0,64):null,clientVersion:clientVersion()});
 let timer;const abort=new AbortController();
 try{
  return await Promise.race([(async()=>{
   const live=await service.discover();
   if(!live)return out('unreachable');
   const {version}=await connect({baseUrl:live.url,headers:service.headers(live)}).server.info({signal:abort.signal});
   return out(/^2\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)?'ready':'incompatible',version);
  })(),new Promise(r=>{timer=setTimeout(()=>{abort.abort();r(out('unreachable'));},timeoutMs);})]);
 }catch{return out('unreachable');}finally{clearTimeout(timer);}
};
export async function startService({directory=stateDirectory(),probeOpenCode=openCodeProbe(),runner=createRunner({timeoutMs:Number(process.env.BRIDGE_TIMEOUT_MS||3600000)}),resolveProject,maxActive=Number(process.env.BRIDGE_MAX_ACTIVE||4),maxQueued=Number(process.env.BRIDGE_MAX_QUEUED||100)}={}){
 if(process.platform==='win32')throw Error('Persistent service runs in Linux/WSL');
 if(!directory.startsWith('/')||directory.startsWith('/mnt/'))throw Error('State directory must be on the Linux filesystem');
 mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
 // A separate SQLite exclusive transaction is a crash-released OS lock.
 // Acquire it before touching stale sockets or recovering jobs.
 const owner=new DatabaseSync(join(directory,'owner.sqlite'));
 try{owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');}catch{owner.close();throw Error('Service already running for this state directory');}
 chmodSync(join(directory,'owner.sqlite'),0o600);
 let store,coordinator,server,closed=false;
 const socket=join(directory,'bridge.sock');
 try{
  if(Buffer.byteLength(socket)>100)throw Error('State directory is too long for a Unix socket');
  if(existsSync(socket))unlinkSync(socket);
  store=new Store({directory});
  coordinator=new Coordinator({store,runner,resolveProject,maxActive,maxQueued,onFatal:error=>{console.error('Fatal persistence failure:',safeError(error));process.exit(1);}});
  server=createServer(async(req,res)=>{
   const send=(status,value)=>{if(res.destroyed)return;const body=JSON.stringify(value);if(Buffer.byteLength(body)>5000000){res.writeHead(500);res.end('{"error":"Response too large"}');return;}res.writeHead(status,{'content-type':'application/json'});res.end(body);};
   if(req.method!=='POST'||req.url!=='/v1/call'){send(404,{error:'Unknown endpoint'});req.resume();return;}
   let bytes=0;const chunks=[];
   try{
    for await(const chunk of req){bytes+=chunk.length;if(bytes>512000){send(413,{error:'Request too large'});req.resume();return;}chunks.push(chunk);}
    const body=JSON.parse(Buffer.concat(chunks).toString());
    if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['provider','action','args'].includes(k)))throw Error('Invalid request');
    const {provider,action,args={}}=body;validateCall(provider,action,args);
    let value;
    if(action==='start')value=await coordinator.start(provider,args);
    else if(action==='status')value=coordinator.status(provider,args.jobId);
    else if(action==='cancel')value=await coordinator.cancel(provider,args.jobId,{force:args.force});
    else if(action==='list_jobs')value=coordinator.list(provider,args);
    else if(action==='cleanup')value=await coordinator.cleanup(provider,{worktreeId:args.worktreeId,discard:args.discard});
    else if(action==='events')value=coordinator.events(provider,args.jobId,{after:args.after,limit:args.limit});
    else value={...coordinator.diagnostics(),storage:directory,executables:{claude:executable(process.env.CLAUDE_COMMAND),codex:executable(process.env.CODEX_COMMAND)},opencode:await probeOpenCode().catch(()=>({status:'unreachable',serviceVersion:null,clientVersion:clientVersion()}))};
    send(200,value);
   }catch(error){send(400,{error:safeError(error)});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=64;server.keepAliveTimeout=1000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,()=>{server.removeListener('error',reject);resolve();});});
  chmodSync(socket,0o600);
 }catch(error){await coordinator?.shutdown();store?.close();owner.close();throw error;}
 return {coordinator,store,socket,async close(){
  if(closed)return;closed=true;
  const stopped=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
  await coordinator.shutdown();server.closeAllConnections();await stopped;
  store.close();owner.close();
 }};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const service=await startService();
 let closing=false;
 const stop=async()=>{if(closing)return;closing=true;const deadline=setTimeout(()=>process.exit(1),25000);deadline.unref();await service.close();clearTimeout(deadline);};
 process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
 console.error('agent-bridge 0.4.0 ready');
}
