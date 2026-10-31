import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JobManager} from '../src/jobs.js';
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('SDK reports completion only after iterator cleanup so immediate resume is possible',async(t)=>{
 const cleanup=gate(),release=gate(); t.after(()=>release.resolve());
 const query=()=> (async function*(){
   try { yield {type:'result',subtype:'success',is_error:false,result:'ok',session_id:'session-1'}; }
   finally {cleanup.resolve();await release.promise;}
 })();
 const m=new JobManager({query});
 const job=m.start({prompt:'test',cwd:process.cwd()});
 await cleanup.promise;
 assert.equal(m.status(job.id).status,'running');
 release.resolve();
 const result=await m.wait(job.id);assert.equal(result.status,'completed');
 const followup=m.start({prompt:'continue',cwd:process.cwd(),sessionId:result.sessionId});
 assert.equal((await m.wait(followup.id)).status,'completed');
});
