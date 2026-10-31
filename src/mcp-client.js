import { StringDecoder } from 'node:string_decoder';
import { ServiceClient } from './client.js';
import { toolsFor,validateCall } from './persistent-tools.js';
const provider=process.env.BRIDGE_PROVIDER||'claude',tools=toolsFor(provider),client=new ServiceClient();
let pending='',inflight=0,closed=false;
const decoder=new StringDecoder('utf8');
process.stdout.on('error',()=>process.exit(0));
const respond=message=>{if(!closed)process.stdout.write(JSON.stringify(message)+'\n');};
const failure=(id,code,message)=>respond({jsonrpc:'2.0',id,error:{code,message}});
async function handle(line){
 let r;
 try{r=JSON.parse(line);}catch{failure(null,-32700,'Parse error');return;}
 if(!r||Array.isArray(r)||r.jsonrpc!=='2.0'||typeof r.method!=='string'){failure(null,-32600,'Invalid Request');return;}
 if(!Object.hasOwn(r,'id'))return;
 if(r.id!==null&&typeof r.id!=='string'&&typeof r.id!=='number'){failure(null,-32600,'Invalid ID');return;}
 if(inflight>=64){failure(r.id,-32000,'Too many requests');return;}
 inflight++;
 try{
  const params=r.params??{};if(!params||typeof params!=='object'||Array.isArray(params))throw Error('Invalid params');
  let result;
  if(r.method==='initialize')result={protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(params.protocolVersion)?params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'agent-bridge-persistent',version:'0.3.0'}};
  else if(r.method==='ping')result={};
  else if(r.method==='tools/list')result={tools};
  else if(r.method==='tools/call'){
   try{
    const name=params.name;
    if(typeof name!=='string'||!name.startsWith(provider+'_'))throw Error('Unknown tool');
    const action=name.slice(provider.length+1),args=params.arguments??{};validateCall(provider,action,args);
    const value=await client.call(provider,action,args);
    result={content:[{type:'text',text:JSON.stringify(value)}]};
   }catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
  }else{failure(r.id,-32601,'Method not found');return;}
  respond({jsonrpc:'2.0',id:r.id,result});
 }catch(error){failure(r.id,-32602,error.message);}finally{inflight--;}
}
process.stdin.on('data',chunk=>{
 pending+=decoder.write(chunk);
 let index;
 while((index=pending.indexOf('\n'))!==-1){
  const line=pending.slice(0,index);pending=pending.slice(index+1);
  if(Buffer.byteLength(line)>512000){failure(null,-32600,'Request too large');continue;}
  void handle(line);
 }
 if(Buffer.byteLength(pending)>512000){failure(null,-32600,'Request too large');process.stdin.destroy();closed=true;}
});
process.stdin.on('end',()=>{closed=true;});
process.once('SIGTERM',()=>process.exit(0));process.once('SIGINT',()=>process.exit(0));
