import { writeFileSync,readFileSync,mkdirSync,existsSync,accessSync,constants } from 'node:fs';
import { join,dirname,resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stateDirectory } from '../src/client.js';
function quote(value,exec=false){
 if(typeof value!=='string'||/[\r\n\0]/.test(value))throw Error('Unsafe unit argument');
 const safe=value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%');
 return '"'+(exec?safe.replaceAll('$','$$'):safe)+'"';
}
// No OpenCode command: the service only attaches to a running OpenCode. One it started would sit in this unit's cgroup
// and die with every bridge restart (KillMode=control-group), taking the user's interactive turns with it.
export function serviceUnit({node,repo,home,claude,codex,directory}){
 const env={PATH:dirname(node)+':'+join(home,'.local','bin')+':/usr/local/bin:/usr/bin:/bin',CLAUDE_COMMAND:claude,CODEX_COMMAND:codex,BRIDGE_STATE_DIR:directory};
 return '[Unit]\nDescription=Codex Claude persistent agent bridge\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory='+quote(repo).slice(1,-1)+'\nExecStart='+quote(node,true)+' '+quote(join(repo,'src','service.js'),true)+'\n'+Object.entries(env).map(([k,v])=>'Environment='+quote(k+'='+v)).join('\n')+'\nUMask=0077\nKillMode=control-group\nTimeoutStopSec=30\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n';
}
// The bridge attaches to a running OpenCode service and never spawns one, so a missing binary must not block Claude and Codex;
// the check only tells the user OpenCode must be installed and started by them.
export function checkOpenCode(path,warn=console.error){
 try{accessSync(path,constants.X_OK);return true;}
 catch{warn('OpenCode not found at '+path+'; set OPENCODE_COMMAND if it lives elsewhere. Installing anyway: the bridge never starts OpenCode, and opencode_* jobs fail until you start it yourself.');return false;}
}
export function installService({node=process.execPath,repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),home=homedir(),claude=process.env.CLAUDE_COMMAND||join(home,'.local','bin','claude'),codex=process.env.CODEX_COMMAND||join(home,'.local','bin','codex'),opencode=process.env.OPENCODE_COMMAND||join(home,'.opencode','bin','opencode'),directory=stateDirectory()}={}){
 if(process.platform!=='linux')throw Error('Run installer in WSL/Linux');
 for(const path of [node,claude,codex])accessSync(path,constants.X_OK);
 checkOpenCode(opencode);
 const dir=join(home,'.config','systemd','user');mkdirSync(dir,{recursive:true});
 const path=join(dir,'agent-bridge.service'),text=serviceUnit({node,repo,home,claude,codex,directory});
 if(!existsSync(path)||readFileSync(path,'utf8')!==text){
  if(existsSync(path))writeFileSync(path+'.backup-'+Date.now(),readFileSync(path),{mode:0o600});
  writeFileSync(path,text,{mode:0o600});
 }
 execFileSync('systemctl',['--user','daemon-reload'],{stdio:'inherit'});
 // start is idempotent and deliberately does not restart active work.
 execFileSync('systemctl',['--user','enable','--now','agent-bridge.service'],{stdio:'inherit'});
 return {unit:path,directory};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(installService()));
