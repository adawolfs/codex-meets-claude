// In-memory stand-in for an OpenCode service and client. `emit(event)` pushes onto the event
// stream (buffered until a subscriber exists); `emit(null)` ends it. Every subscription opens
// with `server.connected`, as the real stream does.
export function fakeOpenCode({ script = {} } = {}) {
  const spy = impl => { const fn = async input => { fn.calls.push(structuredClone(input)); return impl(input); }; fn.calls = []; return fn; };
  const subscribers = new Set(); let backlog = [];
  const stats = { opened: 0, closed: 0 };
  function subscribe() {
    const queue = [...(script.connected === false ? [] : [{ type: 'server.connected', data: {} }]), ...backlog]; backlog = [];
    let pending = null, done = false;
    const sub = { push(event) { if (done) return; if (pending) { const p = pending; pending = null; p(event); } else queue.push(event); } };
    const end = () => { if (done) return; done = true; subscribers.delete(sub); stats.closed++; pending?.(null); pending = null; };
    subscribers.add(sub); stats.opened++;
    const iterator = {
      async next() {
        if (done) return { done: true, value: undefined };
        const event = queue.length ? queue.shift() : await new Promise(resolve => { pending = resolve; });
        if (event === null) { end(); return { done: true, value: undefined }; }
        if (event instanceof Error) { end(); throw event; }
        return { done: false, value: structuredClone(event) };
      },
      async return() { end(); return { done: true, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }
  const call = (name, fallback) => input => (script[name] ?? fallback)(input);
  const client = {
    config: { get: spy(call('config.get', () => script.config ?? [])) },
    session: {
      create: spy(call('session.create', () => ({ id: script.sessionId ?? 's1' }))),
      update: spy(call('session.update', () => undefined)),
      switchModel: spy(call('session.switchModel', () => undefined)),
      prompt: spy(call('session.prompt', () => ({}))),
      interrupt: spy(call('session.interrupt', () => ({}))),
    },
    permission: { reply: spy(call('permission.reply', () => undefined)) },
    event: { subscribe: input => { client.event.subscribe.calls.push(input); return subscribe(); } },
  };
  client.event.subscribe.calls = [];
  const service = {
    ensure: spy(call('service.ensure', () => ({ url: 'http://bridge:secret@127.0.0.1:4096', auth: { type: 'basic', username: 'bridge', password: 'secret' } }))),
    headers: () => ({ authorization: 'Basic c2VjcmV0' }),
  };
  const emit = event => { if (!subscribers.size) backlog.push(event); for (const sub of subscribers) sub.push(event); };
  return { client, service, emit, stats, open: () => subscribers.size };
}
