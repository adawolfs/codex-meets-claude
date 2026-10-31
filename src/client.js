import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
export const stateDirectory = () => process.env.BRIDGE_STATE_DIR || join(homedir(),'.local','state','agent-bridge');
export class ServiceClient {
 constructor({directory=stateDirectory(),timeoutMs=15000}={}){this.socketPath=join(directory,'bridge.sock');this.timeoutMs=timeoutMs;}
 request(body){
  const bytes=Buffer.from(JSON.stringify(body));
  if(bytes.length>512000)return Promise.reject(Error('Request too large'));
  return new Promise((resolve,reject)=>{
   const req=httpRequest({socketPath:this.socketPath,path:'/v1/call',method:'POST',headers:{'content-type':'application/json','content-length':bytes.length},agent:false},res=>{
    let size=0;const chunks=[];
    res.on('data',chunk=>{size+=chunk.length;if(size>5000000){res.destroy(Error('Response too large'));return;}chunks.push(chunk);});
    res.on('error',reject);
    res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)reject(Error(result.error||'Service unavailable'));else resolve(result);}catch(error){reject(error);}});
   });
   req.on('error',reject);req.setTimeout(this.timeoutMs,()=>req.destroy(Object.assign(Error('Service request timed out'),{code:'ETIMEDOUT'})));req.end(bytes);
  });
 }
 async call(provider,action,args={}){
  const body={provider,action,args:action==='start'?{...args,requestId:args.requestId??randomUUID()}:args};
  for(let attempt=0;;attempt++){
   try{return await this.request(body);}
   catch(error){if(attempt>=1||!['ECONNRESET','EPIPE','ETIMEDOUT','ECONNREFUSED'].includes(error.code))throw error;await new Promise(r=>setTimeout(r,100));}
  }
 }
}
