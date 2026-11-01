import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync,chmodSync,symlinkSync,lstatSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureClients,rollbackClients,bridgeConfig,apply } from '../scripts/configure-clients.js';
import { serviceUnit,checkOpenCode } from '../scripts/install-service.js';
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

const ocSeed={$schema:'https://opencode.ai/config.json',plugins:['superpowers@git+https://github.com/obra/superpowers.git'],mcp:{servers:{other:{type:'local',command:['keep']}}}};
function fixture(t,{opencode=JSON.stringify(ocSeed,null,2)+'\n',name='opencode.json'}={}){
 const home=mkdtempSync(join(tmpdir(),'bridge-oc-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 mkdirSync(join(home,'.codex'));mkdirSync(join(home,'.config','opencode'),{recursive:true});
 writeFileSync(join(home,'.codex','config.toml'),'model = "keep"\n');writeFileSync(join(home,'.claude.json'),JSON.stringify({oauthAccount:{id:'do-not-backup'},mcpServers:{other:{command:'keep'}}}));
 if(opencode!==null)writeFileSync(join(home,'.config','opencode',name),opencode);
 return {home,codex:join(home,'.codex','config.toml'),claude:join(home,'.claude.json'),oc:join(home,'.config','opencode',name)};
}
const readJson=p=>JSON.parse(readFileSync(p,'utf8'));
test('registration adds the bridge to opencode and preserves unrelated config',t=>{
 const f=fixture(t);
 const result=configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'});
 const config=readJson(f.oc);
 assert.deepEqual(config.plugins,['superpowers@git+https://github.com/obra/superpowers.git']);assert.equal(config.$schema,'https://opencode.ai/config.json');
 assert.deepEqual(Object.keys(config),['$schema','plugins','mcp']);
 assert.equal(config.mcp.servers.other.command[0],'keep');
 assert.deepEqual(config.mcp.servers.agentbridge,{type:'local',command:['/node','/repo/src/launch.js','opencode']});
 assert.equal(config.mcp.servers['agent-bridge'],undefined);
 assert.equal(readJson(f.claude).mcpServers['codex-bridge'].args.at(-1),'claude');
 assert.match(readFileSync(f.codex,'utf8'),/args = \["\/repo\/src\/launch\.js","codex"\]/);
 const backup=readFileSync(result.backup,'utf8');assert.ok(!backup.includes('do-not-backup'));assert.ok(!backup.includes('superpowers'));
 assert.equal(configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'}).unchanged,true);
});
test('a symlinked config is written through to its target and stays a link, through rollback too; a broken link is refused',t=>{
 const f=fixture(t),dotfiles=join(f.home,'dotfiles');mkdirSync(dotfiles);
 for(const p of [f.oc,f.claude]){const real=join(dotfiles,p.split('/').pop());renameSync(p,real);symlinkSync(real,p);}
 const result=configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'});
 for(const p of [f.oc,f.claude])assert.ok(lstatSync(p).isSymbolicLink(),p+' was replaced by a regular file');
 assert.ok(readJson(join(dotfiles,'opencode.json')).mcp.servers.agentbridge);assert.ok(readJson(join(dotfiles,'.claude.json')).mcpServers['codex-bridge']);
 rollbackClients(result.backup);
 assert.ok(lstatSync(f.oc).isSymbolicLink());assert.equal(readJson(join(dotfiles,'opencode.json')).mcp.servers.agentbridge,undefined);
 const g=fixture(t,{opencode:null});symlinkSync(join(g.home,'missing.json'),join(g.home,'.config','opencode','opencode.json'));
 const toml=readFileSync(g.codex,'utf8');
 assert.throws(()=>configureClients({home:g.home,platform:'linux',node:'/node',repo:'/repo'}),/broken symlink/);
 assert.equal(readFileSync(g.codex,'utf8'),toml,'the earlier writes were unwound');assert.ok(lstatSync(join(g.home,'.config','opencode','opencode.json')).isSymbolicLink());
});
test('registration creates the opencode config when none exists and honours the config directory override',t=>{
 const f=fixture(t,{opencode:null}),xdg=join(f.home,'xdg');
 const result=configureClients({home:f.home,xdg,platform:'linux',node:'/node',repo:'/repo'});
 assert.deepEqual(readJson(join(xdg,'opencode','opencode.json')).mcp.servers.agentbridge.command,['/node','/repo/src/launch.js','opencode']);
 rollbackClients(result.backup);assert.equal(existsSync(join(f.home,'.config','opencode','opencode.json')),false);
 assert.deepEqual(readJson(join(xdg,'opencode','opencode.json')),{});
});
test('a Windows registration of opencode runs the launcher through wsl.exe',t=>{
 const f=fixture(t);configureClients({home:f.home,platform:'win32',node:'/node',repo:'/repo',distro:'Ubuntu'});
 assert.deepEqual(readJson(f.oc).mcp.servers.agentbridge.command,['C:\\Windows\\System32\\wsl.exe','-d','Ubuntu','--','/node','/repo/src/launch.js','opencode']);
});
test('rollback removes only the bridge entry from all three clients',t=>{
 const f=fixture(t),before=readFileSync(f.oc,'utf8');
 const result=configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'});
 const config=readJson(f.oc);assert.ok(config.mcp.servers.agentbridge);config.theme='later';config.mcp.servers.added={type:'local',command:['later']};writeFileSync(f.oc,JSON.stringify(config));
 const claude=readJson(f.claude);claude.newSetting=true;writeFileSync(f.claude,JSON.stringify(claude));
 writeFileSync(f.codex,readFileSync(f.codex,'utf8')+'[later]\nvalue=2\n');
 rollbackClients(result.backup);
 const restored=readJson(f.oc);
 assert.equal(restored.theme,'later');assert.equal(restored.mcp.servers.added.command[0],'later');assert.equal(restored.mcp.servers.other.command[0],'keep');assert.equal(restored.mcp.servers.agentbridge,undefined);
 assert.equal(readJson(f.claude).newSetting,true);assert.equal(readJson(f.claude).mcpServers['codex-bridge'],undefined);
 assert.ok(readFileSync(f.codex,'utf8').includes('[later]\nvalue=2'));assert.ok(!readFileSync(f.codex,'utf8').includes('claude-bridge'));
 assert.deepEqual(JSON.parse(before),ocSeed);
});
test('rollback restores a previous opencode entry and prunes containers it created',t=>{
 const f=fixture(t,{opencode:JSON.stringify({mcp:{servers:{agentbridge:{type:'local',command:['old']}}}})});
 const result=configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'});
 assert.equal(readJson(f.oc).mcp.servers.agentbridge.command[0],'/node');
 rollbackClients(result.backup);assert.deepEqual(readJson(f.oc).mcp.servers.agentbridge,{type:'local',command:['old']});
 const g=fixture(t,{opencode:JSON.stringify({theme:'x'})});
 const made=configureClients({home:g.home,platform:'linux',node:'/node',repo:'/repo'});assert.ok(readJson(g.oc).mcp.servers.agentbridge);
 rollbackClients(made.backup);assert.deepEqual(readJson(g.oc),{theme:'x'});
});
test('rollback refuses to overwrite a later change to the opencode entry and changes nothing',t=>{
 const f=fixture(t),result=configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'});
 const config=readJson(f.oc);config.mcp.servers.agentbridge.command.push('--mine');writeFileSync(f.oc,JSON.stringify(config));
 const toml=readFileSync(f.codex,'utf8'),claude=readFileSync(f.claude,'utf8');
 assert.throws(()=>rollbackClients(result.backup),/changed since installation/);
 assert.equal(readFileSync(f.codex,'utf8'),toml);assert.equal(readFileSync(f.claude,'utf8'),claude);assert.ok(readJson(f.oc).mcp.servers.agentbridge.command.includes('--mine'));
});
test('a rollback of a backup made before opencode existed leaves the opencode config alone',t=>{
 const f=fixture(t),result=configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'});
 assert.ok(readJson(f.oc).mcp.servers.agentbridge);
 const old=readJson(result.backup);for(const k of ['opencodePath','beforeOpencode','afterOpencode'])delete old[k];
 writeFileSync(result.backup,JSON.stringify(old));const oc=readFileSync(f.oc,'utf8');
 rollbackClients(result.backup);assert.equal(readFileSync(f.oc,'utf8'),oc);assert.equal(readJson(f.claude).mcpServers['codex-bridge'],undefined);
});
test('a JSONC config with comments is not silently stripped',t=>{
 const text='{\n  // my note\n  "theme": "x", /* keep */\n  "plugins": []\n}\n';
 const f=fixture(t,{opencode:text,name:'opencode.jsonc'});
 const toml=readFileSync(f.codex,'utf8'),claude=readFileSync(f.claude,'utf8');
 assert.throws(()=>configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'}),/comment/);
 assert.equal(readFileSync(f.oc,'utf8'),text);assert.equal(readFileSync(f.codex,'utf8'),toml);assert.equal(readFileSync(f.claude,'utf8'),claude);
 assert.equal(existsSync(join(f.home,'.agent-bridge-backups')),false);
});
test('slashes and comment markers inside JSON strings are not comments, and a clean opencode.jsonc is used',t=>{
 const f=fixture(t,{opencode:'{"u":"https://x.test//y /* z */","e":"a\\"//b"}',name:'opencode.jsonc'});
 configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'});
 const config=readJson(f.oc);assert.equal(config.u,'https://x.test//y /* z */');assert.equal(config.e,'a"//b');assert.ok(config.mcp.servers.agentbridge);
});
test('an opencode config that is not plain JSON, or has an unexpected shape, is refused untouched',t=>{
 for(const text of ['{"a":1,}','{"mcp":[]}','{"mcp":{"servers":"x"}}','[]']){
  const f=fixture(t,{opencode:text}),toml=readFileSync(f.codex,'utf8');
  assert.throws(()=>configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'}),/opencode/i,text);
  assert.equal(readFileSync(f.oc,'utf8'),text);assert.equal(readFileSync(f.codex,'utf8'),toml);
 }
});
test('rollback refuses an opencode config that gained comments',t=>{
 const f=fixture(t),result=configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'});
 const text='// mine\n'+readFileSync(f.oc,'utf8');writeFileSync(f.oc,text);
 assert.throws(()=>rollbackClients(result.backup),/comment/);assert.equal(readFileSync(f.oc,'utf8'),text);assert.ok(readJson(f.claude).mcpServers['codex-bridge']);
});
test('rollback refuses when the opencode config has been deleted',t=>{
 const f=fixture(t),result=configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'});rmSync(f.oc);
 assert.throws(()=>rollbackClients(result.backup),/changed since installation/);assert.ok(readJson(f.claude).mcpServers['codex-bridge']);
});
test('a failed opencode write unwinds the codex and claude writes',{skip:process.platform==='win32'||process.getuid?.()===0},t=>{
 const f=fixture(t),toml=readFileSync(f.codex,'utf8'),claude=readFileSync(f.claude,'utf8'),oc=readFileSync(f.oc,'utf8'),dir=join(f.home,'.config','opencode');
 // a read-only directory fails the opencode write after the codex and claude writes succeeded
 chmodSync(dir,0o500);
 try{assert.throws(()=>configureClients({home:f.home,platform:'linux',node:'/node',repo:'/repo'}),/EACCES/);}finally{chmodSync(dir,0o700);}
 assert.equal(readFileSync(f.claude,'utf8'),claude);assert.equal(readFileSync(f.codex,'utf8'),toml);assert.equal(readFileSync(f.oc,'utf8'),oc);
});
test('the unit never carries an OpenCode command: the service attaches and never spawns one',()=>{
 const a={node:'/node',repo:'/repo',home:'/home/a',claude:'/claude',codex:'/codex',directory:'/state'};
 assert.doesNotMatch(serviceUnit({...a,opencode:'/home/a/.opencode/bin/opencode'}),/OPENCODE_COMMAND|opencode/);
 assert.equal(serviceUnit({...a,opencode:'/x'}),serviceUnit(a));
});
test('a missing OpenCode binary warns on stderr and does not block, a present one is silent',()=>{
 const seen=[];assert.equal(checkOpenCode('/no/such/opencode',m=>seen.push(m)),false);
 assert.equal(seen.length,1);assert.match(seen[0],/\/no\/such\/opencode/);assert.match(seen[0],/OPENCODE_COMMAND/);
 assert.equal(checkOpenCode(process.execPath,m=>seen.push(m)),true);assert.equal(seen.length,1);
});
test('a failed undo is reported with the files still modified and the backup, and does not stop the other undos',{skip:process.platform==='win32'||process.getuid?.()===0},t=>{
 const d=mkdtempSync(join(tmpdir(),'bridge-apply-'));t.after(()=>{chmodSync(join(d,'a'),0o700);rmSync(d,{recursive:true,force:true});});
 for(const n of ['a','b','c'])mkdirSync(join(d,n));
 for(const n of ['a','b','c'])writeFileSync(join(d,n,'f'),'old-'+n);
 // locking a/ while step 2 is prepared makes the undo of step 1 fail after step 1 succeeded
 const steps=[{path:join(d,'a','f'),old:'old-a',next:'new-a'},{path:join(d,'b','f'),old:'old-b',get next(){chmodSync(join(d,'a'),0o500);return 'new-b';}},{path:join(d,'c','f'),old:'DIFFERENT',next:'new-c'}];
 assert.throws(()=>apply(steps,'/backups/x.json'),e=>/changed concurrently/.test(e.message)&&e.message.includes(join(d,'a','f'))&&/EACCES/.test(e.message)&&e.message.includes('/backups/x.json')&&!e.message.includes(join(d,'b','f')));
 assert.equal(readFileSync(join(d,'b','f'),'utf8'),'old-b');assert.equal(readFileSync(join(d,'a','f'),'utf8'),'new-a');
});
test('an undo that finds the file edited since leaves it and says so',t=>{
 const d=mkdtempSync(join(tmpdir(),'bridge-apply-'));t.after(()=>rmSync(d,{recursive:true,force:true}));
 for(const n of ['a','b','c'])writeFileSync(join(d,n),'old-'+n);
 const steps=[{path:join(d,'a'),old:'old-a',next:'new-a'},{path:join(d,'b'),old:'old-b',get next(){writeFileSync(join(d,'a'),'user edit');return 'new-b';}},{path:join(d,'c'),old:'X',next:'n'}];
 assert.throws(()=>apply(steps,'/b.json'),e=>/edited since, left as is/.test(e.message)&&e.message.includes(join(d,'a'))&&e.message.includes('/b.json'));
 assert.equal(readFileSync(join(d,'a'),'utf8'),'user edit');assert.equal(readFileSync(join(d,'b'),'utf8'),'old-b');
});
test('a clean undo adds nothing to the error',t=>{
 const d=mkdtempSync(join(tmpdir(),'bridge-apply-'));t.after(()=>rmSync(d,{recursive:true,force:true}));
 writeFileSync(join(d,'a'),'old-a');writeFileSync(join(d,'c'),'old-c');
 assert.throws(()=>apply([{path:join(d,'a'),old:'old-a',next:'new-a'},{path:join(d,'c'),old:'X',next:'n'}],'/b.json'),e=>!/Could not restore/.test(e.message));
 assert.equal(readFileSync(join(d,'a'),'utf8'),'old-a');
});
