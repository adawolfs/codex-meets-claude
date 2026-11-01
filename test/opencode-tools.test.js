import test from 'node:test';
import assert from 'node:assert/strict';
import { toolsFor } from '../src/persistent-tools.js';
import { validateStart } from '../src/coordinator.js';

test('opencode tools expose start, events and cleanup with level and worktree', () => {
  const names = toolsFor('opencode').map(t => t.name);
  assert.deepEqual(names.sort(), ['opencode_cancel','opencode_cleanup','opencode_diagnostics','opencode_events','opencode_list_jobs','opencode_start','opencode_status'].sort());
  const start = toolsFor('opencode').find(t => t.name === 'opencode_start');
  assert.deepEqual(start.inputSchema.properties.level.enum, ['read-only','edit','build']);
  assert.equal(start.inputSchema.properties.worktree.type, 'boolean');
  assert.equal(toolsFor('codex').some(t => t.name === 'codex_events'), false);
  assert.equal(toolsFor('claude').some(t => t.name === 'claude_cleanup'), false);
});

test('opencode start input is validated and defaults to the safe level', () => {
  const ok = validateStart('opencode', { prompt: 'x', cwd: '/tmp' });
  assert.equal(ok.level, 'read-only');
  assert.equal(ok.worktree, false);
  assert.equal(validateStart('opencode', { prompt: 'x', cwd: '/tmp', level: 'build' }).level, 'build');
  for (const bad of [{ level: 'root' }, { level: 1 }, { worktree: 'yes' }, { permissionMode: 'plan' }, { maxBudgetUsd: 1 }])
    assert.throws(() => validateStart('opencode', { prompt: 'x', cwd: '/tmp', ...bad }));
  assert.throws(() => validateStart('claude', { prompt: 'x', cwd: '/tmp', level: 'build' }));
});
