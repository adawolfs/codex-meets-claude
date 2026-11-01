const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const str={type:'string'},cursor={type:'integer',minimum:0},limit={type:'integer',minimum:1,maximum:100};
export const PROVIDERS=['claude','codex','opencode'],LEVELS=['read-only','edit','build'];
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
 if(provider==='opencode')definitions.push(['cleanup','Remove the isolated worktree of a finished task.',schema({},[])]);
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
