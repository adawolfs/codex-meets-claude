import { readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,chmodSync,unlinkSync } from 'node:fs';
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
// Writes in order; if one fails, undoes the earlier ones that still hold exactly what was written, so edits made since survive.
function apply(steps){
  const done=[];
  try{for(const step of steps){atomic(step.path,step.next,step.old);done.push(step);}}
  catch(error){
   for(const step of done.reverse())try{if(readFileSync(step.path,'utf8')===step.next){if(step.old===null)unlinkSync(step.path);else atomic(step.path,step.old,step.next);}}catch{}
   throw error;
  }
}
const read=path=>existsSync(path)?readFileSync(path,'utf8'):null;
// The argument names the client being registered; each client is offered the tools of the other two.
export function bridgeConfig({platform=process.platform,node,repo,provider,distro='Ubuntu'}){
  const launch=repo.replaceAll('\\','/').replace(/\/$/,'')+'/src/launch.js';
  return {type:'stdio',command:platform==='win32'?'C:\\Windows\\System32\\wsl.exe':node,
  args:platform==='win32'?['-d',distro,'--',node,launch,provider]:[launch,provider]};
}
// Must be exactly this: every OpenCode permission level denies "agentbridge_<tool>", and any other name defeats that loop guard.
const OC='agentbridge';
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
// OpenCode's config may be JSONC. Rewriting it would drop comments and rollback cannot bring them back, so refuse instead.
function parseOpenCode(path,text){
  for(let i=0,str=false;i<text.length;i++){const c=text[i];
   if(str){if(c==='\\')i++;else if(c==='"')str=false;}
   else if(c==='"')str=true;
   else if(c==='/'&&(text[i+1]==='/'||text[i+1]==='*'))throw Error('OpenCode config contains comments, which rewriting would remove: '+path+'. Add the "'+OC+'" entry under mcp.servers by hand or remove the comments.');
  }
  let data;try{data=JSON.parse(text.trim()?text:'{}');}catch{throw Error('OpenCode config is not plain JSON (trailing commas?): '+path+'. Fix it or add the "'+OC+'" entry by hand.');}
  if(!plain(data)||(data.mcp!==undefined&&!plain(data.mcp))||(data.mcp?.servers!==undefined&&!plain(data.mcp.servers)))throw Error('OpenCode config has an unexpected shape: '+path);
  return data;
}
const dump=(data,text)=>JSON.stringify(data,null,/^(\t| +)"/m.exec(text)?.[1]??2)+'\n';
export function configureClients({home,xdg,platform=process.platform,node,repo,distro='Ubuntu'}){
  // The environment only decides the OpenCode directory when no home was given, so a test home never reaches a real config.
  if(home===undefined){home=homedir();xdg??=process.env.XDG_CONFIG_HOME;}
  if(!node?.startsWith('/')||!repo?.startsWith('/'))throw Error('Supply Linux node and repo paths');
  const codexPath=join(home,'.codex','config.toml'),claudePath=join(home,'.claude.json');
  const ocDir=join(xdg?.startsWith('/')?xdg:join(home,'.config'),'opencode'),ocJsonc=join(ocDir,'opencode.jsonc'),ocPath=existsSync(ocJsonc)?ocJsonc:join(ocDir,'opencode.json');
  const oldToml=read(codexPath),oldJson=read(claudePath),oldOc=read(ocPath);
  const data=JSON.parse(oldJson??'{}'),oc=parseOpenCode(ocPath,oldOc??''),parts=splitToml(oldToml??'');
  const args={platform,node,repo,distro},codex=bridgeConfig({...args,provider:'codex'}),claude=bridgeConfig({...args,provider:'claude'}),o=bridgeConfig({...args,provider:'opencode'});
  const open={type:'local',command:[o.command,...o.args]};
  const block='[mcp_servers.claude-bridge]\ncommand = '+JSON.stringify(codex.command)+'\nargs = '+JSON.stringify(codex.args)+'\nstartup_timeout_sec = 45\ntool_timeout_sec = 30\n\n';
  const current=data.mcpServers?.['codex-bridge']??null,currentOc=oc.mcp?.servers?.[OC]??null;
  if(parts.before===block&&JSON.stringify(current)===JSON.stringify(claude)&&JSON.stringify(currentOc)===JSON.stringify(open))return {unchanged:true};
  const backupDir=join(home,'.agent-bridge-backups');mkdirSync(backupDir,{recursive:true,mode:0o700});chmodSync(backupDir,0o700);
  const backup=join(backupDir,Date.now()+'-'+randomUUID()+'.json');
  // Save only the affected entries, never the whole account configuration.
  writeFileSync(backup,JSON.stringify({codexPath,claudePath,opencodePath:ocPath,beforeToml:parts.before,afterToml:block,beforeClaude:current,afterClaude:claude,beforeOpencode:currentOc,afterOpencode:open},null,2),{mode:0o600});
  mkdirSync(join(home,'.codex'),{recursive:true});mkdirSync(ocDir,{recursive:true});
  data.mcpServers??={};data.mcpServers['codex-bridge']=claude;
  oc.mcp??={};oc.mcp.servers??={};oc.mcp.servers[OC]=open;
  apply([{path:codexPath,old:oldToml,next:parts.rest.replace(/\s*$/,'')+'\n\n'+block},{path:claudePath,old:oldJson,next:JSON.stringify(data,null,2)+'\n'},{path:ocPath,old:oldOc,next:dump(oc,oldOc??'')}]);
  return {backup};
}
export function rollbackClients(backup){
  const b=JSON.parse(readFileSync(backup,'utf8'));
  const toml=readFileSync(b.codexPath,'utf8'),json=readFileSync(b.claudePath,'utf8'),data=JSON.parse(json),parts=splitToml(toml);
  // Backups made before OpenCode was a target carry no OpenCode entry and leave its config alone.
  const ocText=b.opencodePath?read(b.opencodePath):null,oc=ocText===null?null:parseOpenCode(b.opencodePath,ocText);
  if(b.opencodePath&&!oc)throw Error('Bridge registration changed since installation; inspect backup before restoring');
  if(parts.before!==b.afterToml||JSON.stringify(data.mcpServers?.['codex-bridge'])!==JSON.stringify(b.afterClaude)||(oc&&JSON.stringify(oc.mcp?.servers?.[OC])!==JSON.stringify(b.afterOpencode)))
   throw Error('Bridge registration changed since installation; inspect backup before restoring');
  if(b.beforeClaude===null)delete data.mcpServers['codex-bridge'];else data.mcpServers['codex-bridge']=b.beforeClaude;
  const steps=[{path:b.codexPath,old:toml,next:parts.rest.replace(/\s*$/,'')+'\n\n'+b.beforeToml},{path:b.claudePath,old:json,next:JSON.stringify(data,null,2)+'\n'}];
  if(oc){
   const {servers}=oc.mcp;
   if(b.beforeOpencode===null){delete servers[OC];if(!Object.keys(servers).length){delete oc.mcp.servers;if(!Object.keys(oc.mcp).length)delete oc.mcp;}}else servers[OC]=b.beforeOpencode;
   steps.push({path:b.opencodePath,old:ocText,next:dump(oc,ocText)});
  }
  apply(steps);
  return {restored:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='rollback')console.log(JSON.stringify(rollbackClients(process.argv[3])));
 else console.log(JSON.stringify(configureClients({node:process.argv[2],repo:process.argv[3],distro:process.argv[4]||'Ubuntu'})));
}
