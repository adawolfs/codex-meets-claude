const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const str={type:'string'},cursor={type:'integer',minimum:0},limit={type:'integer',minimum:1,maximum:100};
export const PROVIDERS=['claude','codex','opencode'],LEVELS=['read-only','edit','build'];
// providerID/modelID with an optional #variant; claude and codex keep the plain identifier pattern.
export const OPENCODE_MODEL=/^([a-zA-Z0-9._-]{1,64})\/([a-zA-Z0-9._:/-]{1,192})(?:#([a-zA-Z0-9._-]{1,64}))?$/;
export function toolsFor(provider){
 if(!PROVIDERS.includes(provider))throw Error('Invalid provider');
 const start={prompt:str,cwd:str,sessionId:str,model:str,requestId:str,parentJobId:str};
 if(provider==='claude')Object.assign(start,{permissionMode:{type:'string',enum:['plan','acceptEdits']},maxTurns:{type:'integer',minimum:1,maximum:1000},maxBudgetUsd:{type:'number',exclusiveMinimum:0}});
 if(provider==='opencode')Object.assign(start,{level:{type:'string',enum:LEVELS},worktree:{type:'boolean'}});
 const definitions=[
 ['start','Queue a durable task. Reuse requestId to retry safely. parentJobId explicitly resumes a finished session; inspect interrupted work before resuming.',schema(start,['prompt','cwd'])],
 ['status','Get durable task status. queued/running are active; interrupted requires explicit recovery.',schema({jobId:str},['jobId'])],
 ['cancel',provider==='opencode'?'Cancel queued work or request active cancellation; finishedAt confirms cleanup. On a job whose OpenCode session could not be confirmed stopped, retries the interrupt; force:true releases its project and session without proof (the delegate may still be editing).':'Cancel queued work or request active cancellation; finishedAt confirms cleanup.',schema({jobId:str,...(provider==='opencode'?{force:{type:'boolean'}}:{})},['jobId'])],
 ['list_jobs','Page through durable job summaries. Use status for full results.',schema({after:cursor,limit})],
 ['diagnostics','Show service readiness, queue limits and executable availability without model inference.',schema({})],
 ];
 if(provider!=='codex')definitions.push(['events','Page bounded text/tool/session events. truncated means older history was evicted.',schema({jobId:str,after:cursor,limit},['jobId'])]);
 if(provider==='opencode')definitions.push(['cleanup','Remove a task worktree and its bridge/<jobId> branch, by the worktreeId from the job view or diagnostics. Refuses while a job still uses it; refuses one with changes or commits unless discard:true. Nothing is ever merged.',schema({worktreeId:str,discard:{type:'boolean'}},['worktreeId'])]);
 return definitions.map(([action,description,inputSchema])=>({name:provider+'_'+action,description,inputSchema}));
}
export function validateCall(provider,action,args){
 const tool=toolsFor(provider).find(t=>t.name===provider+'_'+action);
 if(!tool)throw Error('Unknown tool');
 if(!args||typeof args!=='object'||Array.isArray(args))throw Error('arguments must be an object');
 for(const key of Object.keys(args)){
  const field=tool.inputSchema.properties[key],value=args[key];
  if(!field)throw Error('Unknown argument: '+key);
  if(field.type==='string'&&(typeof value!=='string'||!value.length))throw Error('Invalid '+key);
  if(field.type==='integer'&&!Number.isSafeInteger(value))throw Error('Invalid '+key);
  if(field.type==='boolean'&&typeof value!=='boolean')throw Error('Invalid '+key);
  if(field.type==='number'&&(typeof value!=='number'||!Number.isFinite(value)))throw Error('Invalid '+key);
  if(field.minimum!==undefined&&value<field.minimum||field.maximum!==undefined&&value>field.maximum||field.exclusiveMinimum!==undefined&&value<=field.exclusiveMinimum||field.enum&&!field.enum.includes(value))throw Error('Invalid '+key);
 }
 for(const key of tool.inputSchema.required)if(!Object.hasOwn(args,key))throw Error('Missing '+key);
 return tool;
}
// What a client is offered: the tools of every provider but itself. A name resolves only if it is exactly one of them.
export function surface(client){
 if(!PROVIDERS.includes(client))throw Error('Invalid client');
 const tools=[],byName=new Map();
 for(const provider of PROVIDERS.filter(p=>p!==client))for(const tool of toolsFor(provider)){tools.push(tool);byName.set(tool.name,{provider,action:tool.name.slice(provider.length+1)});}
 return {tools,resolve:name=>typeof name==='string'?byName.get(name):undefined};
}
// MCP clientInfo.name values observed on the wire (Claude Code 2.1.316 and Codex 0.166.0, 2026-10-31). Exact matches only;
// an unlisted name, OpenCode included, is never treated as a mismatch.
const CLIENT_NAMES=new Map([['claude-code',['claude','Claude Code']],['codex-mcp-client',['codex','Codex']]]);
// Releases before 0.4.0 registered each client under the provider it served, so an old entry names the wrong client.
export function staleRegistration(registered,clientName){
 const known=typeof clientName==='string'?CLIENT_NAMES.get(clientName):undefined;
 if(!known||known[0]===registered)return null;
 return `agent-bridge: this server is registered as "${registered}" but is being run by ${known[1]}. The registration is stale: older versions registered each client under the provider it called, not under its own name. Re-run the installer (node scripts/configure-clients.js) so it is registered as "${known[0]}"; until then this client is offered the wrong tools.`;
}
