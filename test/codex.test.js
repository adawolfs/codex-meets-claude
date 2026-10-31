import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { JobManager } from '../src/jobs.js';

test('Codex runs and resumes with its JSONL session and final message', async () => {
  const manager = new JobManager({ provider: 'codex', command: process.execPath, prefix: ['test/fake-codex.js'] });
  const first = await manager.wait(manager.start({ prompt: 'hello', cwd: process.cwd() }).id);
  assert.equal(first.status, 'completed'); assert.equal(first.sessionId, 'session-1'); assert.equal(first.result, 'hello');
  const second = await manager.wait(manager.start({ prompt: 'again', cwd: process.cwd(), sessionId: first.sessionId }).id);
  assert.equal(second.status, 'completed'); assert.equal(second.sessionId, first.sessionId); assert.equal(second.result, 'again');
});
test('Codex rejects invalid access modes', () => {
  const manager = new JobManager({provider:'codex'});
  assert.throws(() => manager.start({prompt:'hello',cwd:process.cwd(),permissionMode:'bypass'}));
});
