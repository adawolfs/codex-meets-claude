import { createInterface } from 'node:readline';
import { JobManager } from './jobs.js';

const provider = process.env.BRIDGE_PROVIDER || 'claude';
const jobs = new JobManager({ provider });
const string = { type: 'string' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const startProperties = { prompt: string, cwd: string, sessionId: string, model: string };
if (provider === 'claude') Object.assign(startProperties, {
  permissionMode: { type: 'string', enum: ['plan', 'acceptEdits'] },
  maxTurns: { type: 'integer', minimum: 1, maximum: 1000 },
  maxBudgetUsd: { type: 'number', exclusiveMinimum: 0 },
});
const tools = [
  {
    name: provider + '_start',
    description: provider === 'claude'
      ? 'Start a Claude Agent SDK turn. Defaults to plan; acceptEdits permits edits. Extra permission requests are denied and reported. Returns a job ID.'
      : 'Start a read-only Codex task. Returns a job ID.',
    inputSchema: schema(startProperties, ['prompt', 'cwd']),
  },
  ...['status', 'cancel'].map(action => ({
    name: provider + '_' + action,
    description: action === 'status' ? 'Get job progress, session ID, final result and errors.' : 'Request cancellation of a running job.',
    inputSchema: schema({ jobId: string }, ['jobId']),
  })),
  { name: provider + '_list_jobs', description: 'List jobs retained by this server process.', inputSchema: schema({}) },
];
if (provider === 'claude') tools.push({
  name: 'claude_events',
  description: 'Read bounded SDK text/tool/status event pages after a cursor. No reasoning or tool inputs. truncated signals evicted history.',
  inputSchema: schema({
    jobId: string,
    after: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  }, ['jobId']),
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function call(name, args) {
  const tool = tools.find(tool => tool.name === name);
  if (!tool) throw new Error('unknown tool');
  if (!isObject(args)) throw new Error('arguments must be an object');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error('unknown argument: ' + key);
    const field = tool.inputSchema.properties[key], value = args[key];
    if (field.type === 'string' && typeof value !== 'string') throw new Error('invalid ' + key);
    if (field.type === 'integer' && !Number.isSafeInteger(value)) throw new Error('invalid ' + key);
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('invalid ' + key);
    if (field.enum && !field.enum.includes(value)) throw new Error('invalid ' + key);
    if (field.minimum !== undefined && value < field.minimum) throw new Error('invalid ' + key);
    if (field.maximum !== undefined && value > field.maximum) throw new Error('invalid ' + key);
    if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) throw new Error('invalid ' + key);
  }
  for (const key of tool.inputSchema.required) if (!Object.hasOwn(args, key) || args[key] === '') throw new Error('missing ' + key);
  if (name === provider + '_start') return jobs.start(args);
  if (name === provider + '_status') return jobs.status(args.jobId);
  if (name === provider + '_cancel') return jobs.cancel(args.jobId);
  if (name === 'claude_events') return jobs.events(args.jobId, { after: args.after, limit: args.limit });
  return jobs.list();
}

function respond(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function error(id, code, message) { respond({ jsonrpc: '2.0', id, error: { code, message } }); }
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { error(null, -32700, 'Parse error'); return; }
  if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    error(null, -32600, 'Invalid Request'); return;
  }
  if (!Object.hasOwn(request, 'id')) return;
  const { id, method, params = {} } = request;
  if (id !== null && typeof id !== 'string' && typeof id !== 'number') { error(null, -32600, 'Invalid ID'); return; }
  if (!isObject(params)) { error(id, -32602, 'Invalid params'); return; }
  let result;
  if (method === 'initialize') result = {
    protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'codex-meets-claude', version: '0.2.0' },
  };
  else if (method === 'ping') result = {};
  else if (method === 'tools/list') result = { tools };
  else if (method === 'tools/call') {
    try { result = { content: [{ type: 'text', text: JSON.stringify(call(params.name, params.arguments ?? {})) }] }; }
    catch (cause) { result = { isError: true, content: [{ type: 'text', text: cause.message }] }; }
  } else { error(id, -32601, 'Method not found'); return; }
  respond({ jsonrpc: '2.0', id, result });
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  lines.close();
  await jobs.shutdown();
}
lines.on('close', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
