import { JobManager } from './jobs.js';
export function createRunner({ timeoutMs = 3600000, pollMs = 100, managerFactory = provider => new JobManager({provider,timeoutMs,maxJobs:1}) } = {}) {
  return async function run(provider,args,onUpdate,signal) {
    const manager=managerFactory(provider);
    const {requestId,parentJobId,...request}=args;
    const job=manager.start(request);let cursor=0,last='',failure;
    const cancel=()=>manager.cancel(job.id);
    signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();
    const publish=()=>{
      try {
        const view=manager.status(job.id);
        const json=JSON.stringify(view);
        let events=[];
        if(typeof manager.events==='function') {
          let page;
          do {page=manager.events(job.id,{after:cursor,limit:100});events.push(...page.events);cursor=page.nextCursor;}while(page.hasMore);
        }
        if(json!==last||events.length){onUpdate(view,events);last=json;}
      } catch(error) {failure=error;cancel();}
    };
    const timer=setInterval(publish,pollMs);
    try {
      const result=await manager.wait(job.id);
      publish();
      if(failure)throw failure;
      return result;
    } finally {
      clearInterval(timer);signal.removeEventListener('abort',cancel);
      await manager.shutdown();
    }
  };
}
