import { spawn } from 'node:child_process';
import { readdirSync,readFileSync } from 'node:fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function signalTree(child,signal){
 if(!child.pid)return;
 try{
  if(process.platform==='linux')process.kill(-child.pid,signal);
  else if(child.exitCode===null&&child.signalCode===null)child.kill(signal);
 }catch(error){if(error.code!=='ESRCH')throw error;}
}
function livingGroup(pgid){
 if(!pgid)return false;
 for(const name of readdirSync('/proc')){
  if(!/^\d+$/.test(name))continue;
  try{
   const stat=readFileSync('/proc/'+name+'/stat','utf8');
   const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
   if(Number(fields[2])===pgid&&fields[0]!=='Z'&&fields[0]!=='X')return true;
  }catch(error){if(!['ENOENT','ESRCH','EACCES'].includes(error.code))throw error;}
 }
 return false;
}
export async function cleanupProcessGroup(child){
 if(process.platform!=='linux'||!child.pid)return;
 signalTree(child,'SIGKILL');
 const deadline=Date.now()+5000;
 while(livingGroup(child.pid)){
  if(Date.now()>deadline)throw Object.assign(Error('Process group did not terminate; service restart required'),{code:'CLEANUP_FAILED'});
  await sleep(20);
 }
}
/** SDK extension: own the real child lifecycle instead of relying on SDK grace timers. */
export function trackedSpawn({command,args,cwd,env,signal}){
 const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform==='linux'});
 // Custom SDK spawners must drain stderr themselves; do not retain credentials/output.
 child.stderr.on('data',()=>{});
 let exited=false,closed=false;
 const closePromise=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));
 child.on('error',()=>{}); // SDK also subscribes; avoid a startup error race.
 child.once('exit',()=>{exited=true;signalTree(child,'SIGKILL');});
 const abort=()=>signalTree(child,'SIGTERM');
 signal?.addEventListener('abort',abort,{once:true});
 if(signal?.aborted)abort();
 return {child,async finish(){
  signal?.removeEventListener('abort',abort);
  if(!closed&&!exited){
   signalTree(child,'SIGTERM');
   await Promise.race([closePromise,sleep(200)]);
   if(!closed)signalTree(child,'SIGKILL');
  }
  if(!closed){
   const deadline=Date.now()+5000;
   while(!closed){if(Date.now()>deadline)throw Object.assign(Error('SDK process did not exit; service restart required'),{code:'CLEANUP_FAILED'});await sleep(20);}
  }
  await cleanupProcessGroup(child);
 }};
}
