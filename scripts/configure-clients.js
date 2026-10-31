import { readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,chmodSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const target=/^[\t ]*\[\s*mcp_servers\.(?:claude-bridge|"claude-bridge"|'claude-bridge')(?:\.[^\]]+)?\s*\]\s*(?:#.*)?$/;
function splitToml(text){
 const chunks=text.split(/(?=^[\t ]*\[[^\r\n]+\][\t ]*(?:#.*)?$)/m);
 return {before:chunks.filter(c=>target.test(c.split(/\r?\n/)[0])).join(''),rest:chunks.filter(c=>!target.test(c.split(/\r?\n/)[0])).join('')};
}
function atomic(path,content,expected){
 if(existsSync(path)&&readFileSync(path,'utf8')!==expected)throw Error('Configuration changed concurrently: '+path);
 const temp=path+'.agent-bridge-'+randomUUID();writeFileSync(temp,content,{mode:0o600});renameSync(temp,path);
}
export function bridgeConfig({platform=process.platform,node,repo,provider,distro='Ubuntu'}){
 const launch=repo.replaceAll('\\','/').replace(/\/$/,'')+'/src/launch.js';
 return {type:'stdio',command:platform==='win32'?'C:\\Windows\\System32\\wsl.exe':node,
 args:platform==='win32'?['-d',distro,'--',node,launch,provider]:[launch,provider]};
}
export function configureClients({home=homedir(),platform=process.platform,node,repo,distro='Ubuntu'}){
 if(!node?.startsWith('/')||!repo?.startsWith('/'))throw Error('Supply Linux node and repo paths');
 const codexPath=join(home,'.codex','config.toml'),claudePath=join(home,'.claude.json');
 const oldToml=existsSync(codexPath)?readFileSync(codexPath,'utf8'):'';
 const oldJson=existsSync(claudePath)?readFileSync(claudePath,'utf8'):'{}';
 const data=JSON.parse(oldJson),parts=splitToml(oldToml),codex=bridgeConfig({platform,node,repo,distro,provider:'claude'}),claude=bridgeConfig({platform,node,repo,distro,provider:'codex'});
 const block='[mcp_servers.claude-bridge]\ncommand = '+JSON.stringify(codex.command)+'\nargs = '+JSON.stringify(codex.args)+'\nstartup_timeout_sec = 45\ntool_timeout_sec = 30\n\n';
 const current=data.mcpServers?.['codex-bridge']??null;
 if(parts.before===block&&JSON.stringify(current)===JSON.stringify(claude))return {unchanged:true};
 const backupDir=join(home,'.agent-bridge-backups');mkdirSync(backupDir,{recursive:true,mode:0o700});chmodSync(backupDir,0o700);
 const backup=join(backupDir,Date.now()+'-'+randomUUID()+'.json');
 // Save only the affected entries, never the whole account configuration.
 writeFileSync(backup,JSON.stringify({codexPath,claudePath,beforeToml:parts.before,afterToml:block,beforeClaude:current,afterClaude:claude},null,2),{mode:0o600});
 mkdirSync(join(home,'.codex'),{recursive:true});
 atomic(codexPath,parts.rest.replace(/\s*$/,'')+'\n\n'+block,oldToml);
 data.mcpServers??={};data.mcpServers['codex-bridge']=claude;
 try{atomic(claudePath,JSON.stringify(data,null,2)+'\n',oldJson);}catch(error){
  const latest=readFileSync(codexPath,'utf8');if(splitToml(latest).before===block)atomic(codexPath,splitToml(latest).rest+'\n'+parts.before,latest);
  throw error;
 }
 return {backup};
}
export function rollbackClients(backup){
 const b=JSON.parse(readFileSync(backup,'utf8'));
 const toml=readFileSync(b.codexPath,'utf8'),json=readFileSync(b.claudePath,'utf8'),data=JSON.parse(json),parts=splitToml(toml);
 if(parts.before!==b.afterToml||JSON.stringify(data.mcpServers?.['codex-bridge'])!==JSON.stringify(b.afterClaude))
  throw Error('Bridge registration changed since installation; inspect backup before restoring');
 atomic(b.codexPath,parts.rest.replace(/\s*$/,'')+'\n\n'+b.beforeToml,toml);
 if(b.beforeClaude===null)delete data.mcpServers['codex-bridge'];else data.mcpServers['codex-bridge']=b.beforeClaude;
 atomic(b.claudePath,JSON.stringify(data,null,2)+'\n',json);
 return {restored:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='rollback')console.log(JSON.stringify(rollbackClients(process.argv[3])));
 else console.log(JSON.stringify(configureClients({node:process.argv[2],repo:process.argv[3],distro:process.argv[4]||'Ubuntu'})));
}
