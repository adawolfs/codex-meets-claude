import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ServiceClient } from '../src/client.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('systemd kills orphan children on crash and recovery never replays active jobs',{skip:process.env.BRIDGE_SYSTEMD_TEST!=='1',timeout:30000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'bridge-systemd-')),unit='agent-bridge-test-'+process.pid;
 const control=(...args)=>execFileSync('systemctl',['--user',...args],{stdio:'pipe'});
 t.after(()=>{try{control('stop',unit);}finally{rmSync(directory,{recursive:true,force:true});}});
 execFileSync('systemd-run',['--user','--unit='+unit,'--property=Restart=on-failure','--property=RestartSec=1','--property=KillMode=control-group','--setenv=BRIDGE_STATE_DIR='+directory,process.execPath,resolve('test/systemd-fixture.js')],{stdio:'pipe'});
 const client=new ServiceClient({directory,timeoutMs:1000});
 async function until(fn){const end=Date.now()+10000;let error;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){error=e;}await sleep(100);}throw error||Error('condition timed out');}
 await until(()=>client.call('claude','diagnostics'));
 const j=await client.call('claude','start',{prompt:'crash test',cwd:process.cwd()});
 await until(async()=>((await client.call('claude','status',{jobId:j.id})).sessionId));
 const pid=Number(readFileSync(join(directory,'child.pid'),'utf8'));
 control('kill','--kill-whom=main','--signal=SIGKILL',unit);
 await until(async()=>((await client.call('claude','status',{jobId:j.id})).status==='interrupted'));
 await until(()=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}});
 assert.equal((await client.call('claude','list_jobs')).jobs.length,1);
 assert.equal((await client.call('claude','status',{jobId:j.id})).sessionId,'crash-session');
});
