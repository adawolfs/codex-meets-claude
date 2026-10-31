import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
test('MCP exits on SIGTERM even when its parent leaves stdin open',{timeout:5000},async t=>{
 const child=spawn(process.execPath,['src/server.js'],{stdio:['pipe','pipe','pipe']});
 t.after(()=>{child.stdin.destroy();child.kill('SIGKILL');});
 const lines=createInterface({input:child.stdout});
 await new Promise(resolve=>{lines.once('line',resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+'\n');});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 child.kill('SIGTERM');
 let timer;
 const outcome=await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000)})]);
 clearTimeout(timer);assert.equal(outcome,true);
});
