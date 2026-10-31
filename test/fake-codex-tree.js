import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
child.stdout.once('data',()=>{writeFileSync(join(process.argv.at(-1),'child.pid'),String(child.pid));process.stdout.write('{"type":"thread.started","thread_id":"tree-session"}\n');});
process.on('SIGTERM',()=>process.exit(0));
setInterval(()=>{},1000);
