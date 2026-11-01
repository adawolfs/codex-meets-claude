import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ServiceClient } from './client.js';
import { PROVIDERS } from './persistent-tools.js';
const exec=promisify(execFile);
async function ready(){
 const client=new ServiceClient({timeoutMs:1000});
 try{await client.call('claude','diagnostics');return;}catch{}
 try{await exec('systemctl',['--user','start','agent-bridge.service'],{timeout:30000,maxBuffer:8000});}
 catch{throw Error('Cannot start agent-bridge.service. Run scripts/install-service.js in WSL and check systemctl --user status agent-bridge.service.');}
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){try{await client.call('claude','diagnostics');return;}catch{await new Promise(r=>setTimeout(r,200));}}
 throw Error('Service did not become ready. Check journalctl --user -u agent-bridge.service.');
}
try {
 const mode=process.argv[2];
 if(!PROVIDERS.includes(mode)&&mode!=='status')throw Error('Use the name of the client being registered: claude, codex, opencode or status');
 await ready();
 if(mode==='status')console.log(JSON.stringify(await new ServiceClient().call('claude','diagnostics'),null,2));
 else{process.env.BRIDGE_CLIENT=mode;await import('./mcp-client.js');}
}catch(error){console.error(error.message);process.exitCode=1;}
