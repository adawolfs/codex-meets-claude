import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const enabled = process.env.BRIDGE_LIVE_TEST === '1';
test('live SDK via official MCP client: start, events, resume and cancellation', { skip: !enabled, timeout: 120000 }, async t => {
  const client = new Client({ name: 'agent-bridge-smoke', version: '0.2.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('src/server.js')],
    env: Object.fromEntries(Object.entries({ ...process.env, BRIDGE_PROVIDER: 'claude' }).filter(([,v]) => typeof v === 'string')),
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  async function call(name, args) {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, response.content?.[0]?.text);
    return JSON.parse(response.content[0].text);
  }
  async function finished(id) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const job = await call('claude_status', {jobId:id});
      if (job.status !== 'running') return job;
      await new Promise(r => setTimeout(r, 200));
    }
    await call('claude_cancel', {jobId:id});
    throw Error('Live SDK test timed out');
  }
  const start = await call('claude_start', {prompt:'Reply only BRIDGE_OK. Do not use tools.',cwd:process.cwd(),maxTurns:2});
  const first = await finished(start.id);
  assert.equal(first.backend, 'agent-sdk');
  assert.equal(first.status, 'completed', first.error);
  assert.match(first.result, /BRIDGE_OK/);
  assert.ok(first.sessionId);
  const events = await call('claude_events', {jobId:start.id});
  assert.ok(events.events.some(e => e.type === 'session'));
  assert.ok(events.events.some(e => e.type === 'text'));
  const next = await call('claude_start', {prompt:'Reply only BRIDGE_RESUMED. Do not use tools.',cwd:process.cwd(),sessionId:first.sessionId,maxTurns:2});
  const second = await finished(next.id);
  assert.equal(second.status,'completed',second.error);
  assert.equal(second.sessionId,first.sessionId);
  assert.match(second.result,/BRIDGE_RESUMED/);
  const slow = await call('claude_start',{prompt:'Write a long numbered list of 500 software testing principles. Do not use tools.',cwd:process.cwd(),maxTurns:2});
  // Cancel after the real SDK subprocess initialized, not just before startup.
  const deadline = Date.now() + 30000;
  let observed;
  do {
    observed = await call('claude_status',{jobId:slow.id});
    if (observed.sessionId || observed.status !== 'running') break;
    await new Promise(r => setTimeout(r,100));
  } while(Date.now() < deadline);
  assert.ok(observed.sessionId,'SDK did not initialize');
  assert.equal(observed.status,'running','Task ended before cancellation could be exercised');
  await call('claude_cancel',{jobId:slow.id});
  const cancelled = await finished(slow.id);
  assert.equal(cancelled.status,'cancelled');
});
