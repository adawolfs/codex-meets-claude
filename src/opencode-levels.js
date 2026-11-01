export const LEVELS = ['read-only', 'edit', 'build'];
const rule = (action, resource, effect) => ({ action, resource, effect });
const READS = ['read', 'glob', 'grep', 'skill'];
const KNOWN = ['read', 'edit', 'glob', 'grep', 'shell', 'subagent', 'skill', 'question', 'webfetch', 'websearch', 'external_directory', 'execute', 'mcp_tool'];
const re = p => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's');
const resolve = (rules, action, resource) => rules.findLast(r => re(r.action).test(action) && re(r.resource).test(resource))?.effect;
// Intersection of two patterns: the pattern, null when empty, undefined when not expressible as one pattern.
const meet = (p, q) => p === q || q === '*' ? p : p === '*' ? q : !/[*?]/.test(p) ? (re(q).test(p) ? p : null) : !/[*?]/.test(q) ? (re(p).test(q) ? q : null) : undefined;

// Session rules are appended to the user's configuration, so a matching session allow beats a config deny.
// The user's configuration is therefore replayed in its own order after the level's rules: a deny is re-emitted
// verbatim, and a later allow/ask only restores the level's own effect inside its region (the level's rules
// intersected with it), never more. Where that intersection is not one pattern, a level deny is kept whole and a
// level allow is dropped, so the replay can only over-deny. Config allows are never copied as allows.
function replay(config, own) {
  if (config === undefined) return [];
  if (!Array.isArray(config)) throw TypeError('options.config must be an array of permission rules');
  const out = [];
  for (const r of config) {
    if (!r || typeof r.action !== 'string' || typeof r.resource !== 'string' || !['allow', 'deny', 'ask'].includes(r.effect)) throw TypeError('Malformed permission rule in options.config');
    if (r.effect === 'deny') out.push(rule(r.action, r.resource, 'deny'));
    else if (out.length) for (const l of own) {
      const action = meet(l.action, r.action), resource = meet(l.resource, r.resource);
      if (action === null || resource === null) continue;
      if (action === undefined || resource === undefined) { if (l.effect === 'deny') out.push({ ...l }); continue; }
      out.push(rule(action, resource, l.effect));
    }
  }
  return out;
}

export function levelRules(level, { bridgeServerName = 'agentbridge', config } = {}) {
  if (!LEVELS.includes(level)) throw Error(`Unknown permission level: ${level}`);
  const servers = new Set([bridgeServerName.replace(/[^a-zA-Z0-9_]/g, '_'), bridgeServerName]);
  // `ask` can never be answered in a delegated job, so nothing is left to it: unmatched actions, prompts and .env are denied.
  const own = [
    rule('*', '*', level === 'build' ? 'allow' : 'deny'),
    ...(level === 'build' ? [] : READS.map(a => rule(a, '*', 'allow'))),
    ...(level === 'edit' ? [rule('edit', '*', 'allow')] : []),
    ...[...servers].map(s => rule(`${s}_*`, '*', 'deny')),
    rule('question', '*', 'deny'),
    rule('external_directory', '*', 'deny'),
    rule('read', '*.env', 'deny'),
    rule('read', '*.env.*', 'deny'),
    rule('read', '*.env.example', 'allow'),
  ];
  const guard = replay(config, own);
  if (!guard.length) return own;
  const rules = [...own, ...guard];
  // Probe each action the config or the level names, on a generic resource and on each resource the config allows.
  const probes = (list, key) => [...new Set(list.filter(r => r.effect !== 'deny').map(r => r[key].replace(/[*?]/g, 'x')))];
  const actions = [...new Set([...KNOWN, ...probes(config, 'action')])], resources = ['/probe/x', ...probes(config, 'resource')];
  const can = list => actions.some(a => resources.some(x => resolve(list, a, x) === 'allow'));
  if (can(own) && !can(rules)) throw Error(`The OpenCode permission configuration denies every action the "${level}" level could allow, so a delegate would be unable to do anything. Allow at least one action in the configuration.`);
  return rules;
}
