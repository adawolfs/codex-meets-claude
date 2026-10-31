import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('real persistent service: Claude survives disconnect, resumes; Codex completes',{skip:process.env.BRIDGE_LIVE_SERVICE!=='1',timeout:180000},async t=>{
 async function connect(provider){
  const command=process.platform==='win32'?'C:\\Windows\\System32\\wsl.exe':process.execPath;
  const args=process.platform==='win32'?['-d','Ubuntu','--',process.env.BRIDGE_WSL_NODE,process.env.BRIDGE_WSL_REPO+'/src/launch.js',provider]:[resolve('src/launch.js'),provider];
  const client=new Client({name:'persistent-smoke',version:'0.3.0'});
  await client.connect(new StdioClientTransport({command,args,stderr:'pipe'}));t.after(()=>client.close());return client;
 }
 async function call(c,name,args={}){const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,r.content[0].text);return JSON.parse(r.content[0].text);}
 async function until(c,provider,id,predicate){const deadline=Date.now()+60000;while(Date.now()<deadline){const j=await call(c,provider+'_status',{jobId:id});if(predicate(j))return j;await sleep(100);}throw Error('live task timed out');}
 const one=await connect('claude'),two=await connect('claude');
 const started=await call(one,'claude_start',{prompt:'Without using any tools, write a numbered list of 30 very short testing tips, then end with PERSISTENT_OK.',cwd:process.cwd(),maxTurns:2});
 const running=await until(two,'claude',started.id,j=>j.sessionId||!['queued','running'].includes(j.status));
 assert.equal(running.status,'running',running.error);
 await one.close();
 const result=await until(two,'claude',started.id,j=>!['queued','running'].includes(j.status));
 assert.equal(result.status,'completed',result.error);assert.match(result.result,/PERSISTENT_OK/);
 const next=await call(two,'claude_start',{prompt:'Reply only RESUMED_OK, without using tools.',cwd:process.cwd(),parentJobId:started.id,maxTurns:2});
 const resumed=await until(two,'claude',next.id,j=>!['queued','running'].includes(j.status));
 assert.equal(resumed.status,'completed',resumed.error);assert.equal(resumed.sessionId,result.sessionId);assert.match(resumed.result,/RESUMED_OK/);
 const codex=await connect('codex');
 const task=await call(codex,'codex_start',{prompt:'Reply only CODEX_OK. Do not use tools.',cwd:process.cwd()});
 const done=await until(codex,'codex',task.id,j=>!['queued','running'].includes(j.status));
 assert.equal(done.status,'completed',done.error);assert.match(done.result,/CODEX_OK/);
 t.diagnostic(JSON.stringify({claudeJob:started.id,resumedJob:next.id,codexJob:task.id}));
});
