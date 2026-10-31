import { startService } from '../src/service.js';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const service=await startService({runner:async(_provider,_args,onUpdate,signal)=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 writeFileSync(join(process.env.BRIDGE_STATE_DIR,'child.pid'),String(child.pid));
 onUpdate({sessionId:'crash-session'},[]);
 await new Promise(resolve=>signal.addEventListener('abort',()=>{child.kill();child.once('close',resolve);},{once:true}));
 return {status:'cancelled'};
}});
process.on('SIGTERM',()=>void service.close());
