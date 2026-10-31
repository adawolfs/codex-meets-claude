import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureClients,rollbackClients,bridgeConfig } from '../scripts/configure-clients.js';
import { serviceUnit } from '../scripts/install-service.js';
test('configuration update and rollback preserve unrelated edits and never copy credentials',t=>{
 const home=mkdtempSync(join(tmpdir(),'bridge-config-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 mkdirSync(join(home,'.codex'));writeFileSync(join(home,'.codex','config.toml'),'model = "keep"\n[mcp_servers.claude-bridge]\ncommand = "old"\n[mcp_servers.claude-bridge.env]\nCLAUDE_COMMAND="old-cli"\n[other]\nvalue=1\n');
 writeFileSync(join(home,'.claude.json'),JSON.stringify({oauthAccount:{id:'do-not-backup'},mcpServers:{'codex-bridge':{command:'old'},other:{command:'keep'}}}));
 const result=configureClients({home,platform:'linux',node:'/node',repo:'/repo'});
 const claude=JSON.parse(readFileSync(join(home,'.claude.json')));
 assert.equal(claude.mcpServers.other.command,'keep');assert.equal(claude.mcpServers['codex-bridge'].command,'/node');
 assert.ok(readFileSync(join(home,'.codex','config.toml'),'utf8').includes('[other]\nvalue=1'));
 const backup=readFileSync(result.backup,'utf8');assert.ok(!backup.includes('do-not-backup'));
 claude.newSetting=true;writeFileSync(join(home,'.claude.json'),JSON.stringify(claude));
 rollbackClients(result.backup);
 const restored=JSON.parse(readFileSync(join(home,'.claude.json')));assert.equal(restored.newSetting,true);assert.equal(restored.mcpServers['codex-bridge'].command,'old');
 assert.ok(readFileSync(join(home,'.codex','config.toml'),'utf8').includes('CLAUDE_COMMAND="old-cli"'));
});
test('Windows registration uses argument arrays and Linux paths; unsafe unit strings fail',()=>{
 const c=bridgeConfig({platform:'win32',node:'/node',repo:'/home/a/repo with spaces',provider:'claude',distro:'Ubuntu'});
 assert.equal(c.args[0],'-d');assert.ok(c.args.includes('/home/a/repo with spaces/src/launch.js'));assert.equal(c.args.at(-1),'claude');
 assert.throws(()=>serviceUnit({node:'/node\nbad',repo:'/repo',home:'/home/a',claude:'/claude',codex:'/codex',directory:'/state'}));
 const text=serviceUnit({node:'/node',repo:'/repo',home:'/home/a',claude:'/claude',codex:'/codex',directory:'/state'});
 assert.match(text,/KillMode=control-group/);assert.match(text,/Restart=on-failure/);
});


test('generated unit is accepted by the actual systemd parser',{skip:process.platform==='win32'},async t=>{
 const {execFileSync}=await import('node:child_process');
 const directory=mkdtempSync(join(tmpdir(),'bridge unit '));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const file=join(directory,'agent-bridge.service');
 writeFileSync(file,serviceUnit({node:process.execPath,repo:directory,home:directory,claude:'/bin/true',codex:'/bin/true',directory}));
 assert.doesNotThrow(()=>execFileSync('systemd-analyze',['--user','verify',file],{stdio:'pipe'}));
});

test('migration replaces indented TOML bridge tables after blank lines',t=>{
 const home=mkdtempSync(join(tmpdir(),'bridge-indent-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 mkdirSync(join(home,'.codex'));const path=join(home,'.codex','config.toml');
 const original='model="keep"\n\n  [mcp_servers.claude-bridge]\ncommand="old"\n\n  [mcp_servers.claude-bridge.env]\nCLAUDE_COMMAND="old-cli"\n\n[other]\nvalue=1\n';writeFileSync(path,original);
 writeFileSync(join(home,'.claude.json'),'{}');
 const result=configureClients({home,platform:'linux',node:'/node',repo:'/repo'});
 const output=readFileSync(path,'utf8');assert.equal((output.match(/\[mcp_servers\.claude-bridge\]/g)||[]).length,1);assert.ok(!output.includes('old-cli'));
 assert.equal(configureClients({home,platform:'linux',node:'/node',repo:'/repo'}).unchanged,true);
 rollbackClients(result.backup);assert.ok(readFileSync(path,'utf8').includes('  [mcp_servers.claude-bridge]'));
});
