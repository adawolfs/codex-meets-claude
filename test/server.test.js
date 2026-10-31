import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test('MCP preserves tools, exposes SDK event pages and survives malformed requests', {timeout:10000}, async t => {
 const child=spawn(process.execPath,['src/server.js'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe'],env:{...process.env,CLAUDE_COMMAND:'missing-claude-for-test'}});
 t.after(()=>child.kill());
 const lines=createInterface({input:child.stdout});const pending=new Map();let id=0;
 lines.on('line',line=>{const msg=JSON.parse(line);pending.get(msg.id)?.(msg);pending.delete(msg.id);});
 child.on('exit',()=>{for(const resolve of pending.values())resolve({error:{message:'server exited'}});pending.clear();});
 function ask(method,params={}){const next=++id;return new Promise(resolve=>{pending.set(next,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});}
 const init=await ask('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
 assert.equal(init.result.serverInfo.name,'codex-meets-claude');
 const tools=(await ask('tools/list')).result.tools.map(t=>t.name);
 assert.ok(tools.includes('claude_start'));assert.ok(tools.includes('claude_events'));
 const invalid=await ask('tools/call',{name:'claude_start',arguments:{prompt:''}});
 assert.equal(invalid.result.isError,true);
 const started=await ask('tools/call',{name:'claude_start',arguments:{prompt:'hello',cwd:process.cwd()}});
 const job=JSON.parse(started.result.content[0].text);
 assert.equal(job.status,'running');assert.equal(job.backend,'agent-sdk');
 const page=await ask('tools/call',{name:'claude_events',arguments:{jobId:job.id,after:0,limit:2}});
 assert.ok(Array.isArray(JSON.parse(page.result.content[0].text).events));
 const badPage=await ask('tools/call',{name:'claude_events',arguments:{jobId:job.id,after:-1}});
 assert.equal(badPage.result.isError,true);
 child.stdin.write('null\n[]\n5\n');
 assert.deepEqual((await ask('ping')).result,{});
 assert.equal((await ask('tools/call',null)).error.code,-32602);
 assert.equal((await ask('unknown')).error.code,-32601);
 child.stdin.end();
});
