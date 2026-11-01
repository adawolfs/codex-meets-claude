import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, levelRules } from '../src/opencode-levels.js';

const glob = p => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's');
// OpenCode's documented matching: ordered, last match wins, `ask` when nothing matches.
const resolve = (rules, action, resource) => rules.findLast(r => glob(r.action).test(action) && glob(r.resource).test(resource))?.effect ?? 'ask';
const ACTIONS = ['read', 'edit', 'glob', 'grep', 'shell', 'subagent', 'skill', 'question', 'webfetch', 'websearch', 'external_directory', 'execute', 'agent_bridge_codex_start', 'other_tool'];
const cfg = (effect, action, resource = '*') => ({ action, resource, effect });

test('every level denies the bridge tools and answers every action', () => {
  for (const level of LEVELS) {
    const rules = levelRules(level, { bridgeServerName: 'agent-bridge' });
    assert.ok(rules.some(r => r.action.startsWith('agent_bridge') && r.effect === 'deny'));
    assert.ok(rules.some(r => r.action === '*' && r.resource === '*'));
    for (const action of [...ACTIONS, 'brand_new_action']) assert.notEqual(resolve(rules, action, '/p/x'), 'ask', `${level}: ${action}`);
    assert.equal(resolve(rules, 'agent_bridge_codex_start', '*'), 'deny');
    assert.equal(resolve(rules, 'agent_bridge_anything', '/p'), 'deny');
  }
});

test('levels narrow monotonically', () => {
  const effect = (level, action) => resolve(levelRules(level), action, 'x');
  assert.equal(effect('read-only', 'edit'), 'deny');
  assert.equal(effect('read-only', 'read'), 'allow');
  assert.equal(effect('edit', 'edit'), 'allow');
  assert.equal(effect('edit', 'shell'), 'deny');
  assert.equal(effect('build', 'shell'), 'allow');
  assert.equal(effect('read-only', 'shell'), 'deny');
  assert.equal(effect('build', 'edit'), 'allow');
  const rank = { deny: 0, allow: 1 };
  for (const action of ACTIONS) for (const [narrow, wide] of [['read-only', 'edit'], ['edit', 'build']])
    assert.ok(rank[effect(narrow, action)] <= rank[effect(wide, action)], `${narrow} must not exceed ${wide} on ${action}`);
});

test('every level denies prompts it cannot answer and .env reads', () => {
  for (const level of LEVELS) {
    const rules = levelRules(level);
    for (const action of ['question', 'external_directory']) assert.equal(resolve(rules, action, '/other'), 'deny', `${level}: ${action}`);
    assert.equal(resolve(rules, 'read', '/p/.env'), 'deny');
    assert.equal(resolve(rules, 'read', '/p/.env.local'), 'deny');
    assert.equal(resolve(rules, 'read', '/p/.env.example'), 'allow');
    assert.equal(resolve(rules, 'read', '/p/src/a.js'), 'allow');
  }
});

test('the bridge server name is sanitised like an MCP action prefix', () => {
  const rules = levelRules('build', { bridgeServerName: 'my bridge.v2' });
  assert.equal(resolve(rules, 'my_bridge_v2_codex_start', '*'), 'deny');
  assert.equal(resolve(levelRules('build'), 'agent_bridge_claude_start', '*'), 'deny');
});

test('unknown levels are rejected', () => {
  assert.throws(() => levelRules('root'));
  assert.throws(() => levelRules(undefined));
  assert.throws(() => levelRules('constructor'));
});

test('a config deny on an action the level allows degrades it to deny', () => {
  const rules = levelRules('edit', { config: [cfg('deny', 'edit')] });
  assert.equal(resolve(rules, 'edit', '/p/a.js'), 'deny');
  assert.equal(resolve(rules, 'read', '/p/a.js'), 'allow');
  assert.equal(resolve(levelRules('build', { config: [cfg('deny', 'shell')] }), 'shell', 'ls'), 'deny');
});

test('a config deny on a narrower resource than the level allow is respected', () => {
  const rules = levelRules('build', { config: [cfg('deny', 'edit', '/p/secrets/*')] });
  assert.equal(resolve(rules, 'edit', '/p/secrets/key'), 'deny');
  assert.equal(resolve(rules, 'edit', '/p/src/a.js'), 'allow');
  assert.equal(resolve(levelRules('edit', { config: [cfg('deny', '*', '/p/locked')] }), 'edit', '/p/locked'), 'deny');
});

test('a config deny wins even if a later config allow would have undone it', () => {
  const rules = levelRules('build', { config: [cfg('deny', 'edit'), cfg('allow', 'edit', '/p/*')] });
  assert.equal(resolve(rules, 'edit', '/p/a.js'), 'deny');
});

test('a config allow never widens a level deny', () => {
  const config = [cfg('allow', 'edit'), cfg('allow', 'shell'), cfg('allow', 'agent_bridge_codex_start'), cfg('allow', 'question'), cfg('allow', '*')];
  const ro = levelRules('read-only', { config });
  assert.equal(resolve(ro, 'edit', '/p/a'), 'deny');
  assert.equal(resolve(ro, 'shell', 'ls'), 'deny');
  assert.equal(resolve(levelRules('edit', { config }), 'shell', 'ls'), 'deny');
  for (const level of LEVELS) {
    const rules = levelRules(level, { config });
    assert.equal(resolve(rules, 'agent_bridge_codex_start', '*'), 'deny');
    assert.equal(resolve(rules, 'question', '*'), 'deny');
    assert.equal(resolve(rules, 'read', '/p/.env'), 'deny');
  }
});

test('the intersection only subtracts: no level ever gains an allow from the config', () => {
  const configs = [[], [cfg('deny', 'edit')], [cfg('allow', '*')], [cfg('deny', '*', '/p/x'), cfg('allow', 'shell')], [cfg('ask', 'read'), cfg('deny', 'grep', '*.js')]];
  for (const level of LEVELS) for (const config of configs) {
    const base = levelRules(level), rules = levelRules(level, { config });
    for (const action of ACTIONS) for (const resource of ['/p/x', '/p/a.js', '/p/.env']) {
      if (resolve(base, action, resource) === 'deny') assert.equal(resolve(rules, action, resource), 'deny');
      for (const c of config) if (c.effect === 'deny' && glob(c.action).test(action) && glob(c.resource).test(resource)) assert.equal(resolve(rules, action, resource), 'deny');
    }
  }
});

test('with no config the level own rules come through unchanged', () => {
  for (const level of LEVELS) {
    const own = levelRules(level);
    assert.deepEqual(levelRules(level, {}), own);
    assert.deepEqual(levelRules(level, { config: [] }), own);
    assert.deepEqual(levelRules(level, { config: [cfg('allow', 'edit'), cfg('ask', 'read')] }), own);
    assert.ok(own.every(r => Object.keys(r).sort().join() === 'action,effect,resource'));
  }
  assert.notEqual(levelRules('edit'), levelRules('edit'));
});

test('the config is not mutated and a malformed config fails closed', () => {
  const config = [cfg('deny', 'edit')], before = structuredClone(config);
  levelRules('build', { config });
  assert.deepEqual(config, before);
  for (const bad of ['x', {}, [null], [{ action: 'edit' }], [{ action: 'edit', resource: '*', effect: 'maybe' }]]) assert.throws(() => levelRules('build', { config: bad }));
});
