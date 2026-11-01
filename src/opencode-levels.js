export const LEVELS = ['read-only', 'edit', 'build'];
const rule = (action, resource, effect) => ({ action, resource, effect });
const READS = ['read', 'glob', 'grep', 'skill', 'webfetch', 'websearch'];

// Session rules are appended to the user's configuration, so a matching session allow beats a config deny.
// Config denies are therefore re-emitted last (and verbatim, so OpenCode does the pattern matching): the
// result can only subtract from a level, never add. A config allow or ask is never copied.
function guards(config) {
  if (config === undefined) return [];
  if (!Array.isArray(config)) throw TypeError('options.config must be an array of permission rules');
  return config.flatMap(r => {
    if (!r || typeof r.action !== 'string' || typeof r.resource !== 'string' || !['allow', 'deny', 'ask'].includes(r.effect)) throw TypeError('Malformed permission rule in options.config');
    return r.effect === 'deny' ? [rule(r.action, r.resource, 'deny')] : [];
  });
}

export function levelRules(level, { bridgeServerName = 'agent-bridge', config } = {}) {
  if (!LEVELS.includes(level)) throw Error(`Unknown permission level: ${level}`);
  const guard = guards(config);
  const servers = new Set([bridgeServerName.replace(/[^a-zA-Z0-9_]/g, '_'), bridgeServerName]);
  // `ask` can never be answered in a delegated job, so nothing is left to it: unmatched actions, prompts and .env are denied.
  return [
    rule('*', '*', level === 'build' ? 'allow' : 'deny'),
    ...(level === 'build' ? [] : READS.map(a => rule(a, '*', 'allow'))),
    ...(level === 'edit' ? [rule('edit', '*', 'allow')] : []),
    ...[...servers].map(s => rule(`${s}_*`, '*', 'deny')),
    rule('question', '*', 'deny'),
    rule('external_directory', '*', 'deny'),
    rule('read', '*.env', 'deny'),
    rule('read', '*.env.*', 'deny'),
    rule('read', '*.env.example', 'allow'),
    ...guard,
  ];
}
