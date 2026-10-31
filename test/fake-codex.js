const args=process.argv.slice(2);
if (!args.includes('mcp_servers.claude-bridge.enabled=false') || !args.includes('read-only')) process.exit(3);
console.log(JSON.stringify({type:'thread.started',thread_id:args.includes('resume') ? args[args.indexOf('resume')+1] : 'session-1'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:args.at(-1)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
