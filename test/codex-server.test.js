import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test('Codex provider advertises only Codex tools and validates calls', async () => {
 const child=spawn(process.execPath,['src/server.js'],{cwd:process.cwd(),env:{...process.env,BRIDGE_PROVIDER:'codex'},stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout}); let id=0; const pending=new Map();
 lines.on('line',line=>{const msg=JSON.parse(line);pending.get(msg.id)?.(msg)});
 const ask=(method,params={})=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')});
 try {const names=(await ask('tools/list')).result.tools.map(t=>t.name);assert.ok(names.includes('codex_start'));assert.ok(names.includes('codex_status'));assert.ok(!names.includes('claude_start'));assert.equal((await ask('tools/call',{name:'codex_start',arguments:{prompt:''}})).result.isError,true)} finally {child.kill()}
});
