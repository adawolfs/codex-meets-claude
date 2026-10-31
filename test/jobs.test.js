import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JobManager} from '../src/jobs.js';
test('immediate SDK cancellation does not launch a query',async()=>{
 let launches=0;
 const m=new JobManager({query:()=>{launches++;throw Error('should not launch');}});
 const job=m.start({prompt:'test',cwd:process.cwd()});m.cancel(job.id);
 assert.equal((await m.wait(job.id)).status,'cancelled');assert.equal(launches,0);
});
test('retained SDK history is bounded without evicting active jobs',async()=>{
 const query=()=>(async function*(){yield {type:'result',subtype:'success',is_error:false,result:'ok',session_id:'one'};})();
 const m=new JobManager({query,maxJobs:1});
 const a=m.start({prompt:'a',cwd:process.cwd()});await m.wait(a.id);
 const b=m.start({prompt:'b',cwd:process.cwd()});await m.wait(b.id);
 assert.equal(m.list().length,1);assert.throws(()=>m.status(a.id),/not found/);
});
