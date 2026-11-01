// In-memory stand-in for an OpenCode service and client. `emit(event)` delivers to current
// subscribers and is dropped when there are none, as on the real SSE stream; `emit(null)` ends the
// streams and `emit(error)` makes them throw. `event.subscribe` is the strictest combination of the
// real client's two layers: an async generator that connects on the first next(), opens with
// `server.connected`, and whose return() waits for a pending next() (the raw generated client);
// it ends early only when the signal in its first argument aborts (OpenCode.make's shared stream).
export function fakeOpenCode({ script = {} } = {}) {
  const spy = impl => { const fn = async input => { fn.calls.push(structuredClone(input)); return impl(input); }; fn.calls = []; return fn; };
  const subscribers = new Set();
  const stats = { opened: 0, closed: 0 };
  const subscribe = ({ signal } = {}) => ({
    async* [Symbol.asyncIterator]() {
      const queue = []; let wake;
      const sub = { push(event) { queue.push(event); wake?.(); } };
      const abort = () => wake?.();
      subscribers.add(sub); stats.opened++;
      signal?.addEventListener('abort', abort);
      try {
        if (script.connected !== false) yield { type: 'server.connected', data: {} };
        while (true) {
          while (!queue.length) {
            if (signal?.aborted) throw new Error('This operation was aborted');
            await new Promise(resolve => { wake = resolve; });
            wake = undefined;
          }
          const event = queue.shift();
          if (event === null) return;
          if (event instanceof Error) throw event;
          yield structuredClone(event);
        }
      } finally {
        subscribers.delete(sub); stats.closed++;
        signal?.removeEventListener('abort', abort);
      }
    },
  });
  const emit = event => { for (const sub of subscribers) sub.push(event); };
  const call = (name, fallback) => input => (script[name] ?? fallback)(input);
  const client = {
    config: { get: spy(call('config.get', () => script.config ?? [])) },
    session: {
      create: spy(call('session.create', () => ({ id: script.sessionId ?? 's1' }))),
      get: spy(call('session.get', ({ sessionID }) => ({ id: sessionID, metadata: { agentbridge: { level: 'read-only' } } }))),
      switchModel: spy(call('session.switchModel', () => undefined)),
      prompt: spy(call('session.prompt', () => ({}))),
      // A real interrupt ends the running turn, which the stream reports.
      interrupt: spy(call('session.interrupt', ({ sessionID }) => { queueMicrotask(() => emit({ type: 'session.execution.interrupted', data: { sessionID, reason: 'user' } })); return {}; })),
    },
    permission: { reply: spy(call('permission.reply', () => undefined)) },
    event: { subscribe: (input, options) => { client.event.subscribe.calls.push({ signal: !!input?.signal, requestSignal: !!options?.signal }); return subscribe(input); } },
  };
  client.event.subscribe.calls = [];
  const service = {
    ensure: spy(call('service.ensure', () => ({ url: 'http://bridge:secret@127.0.0.1:4096', auth: { type: 'basic', username: 'bridge', password: 'secret' } }))),
    headers: () => ({ authorization: 'Basic c2VjcmV0' }),
  };
  return { client, service, emit, stats, open: () => subscribers.size };
}
