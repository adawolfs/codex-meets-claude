process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'stream-session'})+'\n');
for(let i=0;i<3000;i++)process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(1000)}})+'\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'complete'}})+'\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}})+'\n');
