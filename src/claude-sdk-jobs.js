import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { trackedSpawn } from './process-tree.js';

const now = () => new Date().toISOString();
const bounded = (value, limit = 4000) => String(value ?? '').slice(0, limit);

/** One SDK query per turn. The SDK owns Claude processes and durable sessions. */
export class ClaudeSdkJobs {
  constructor({
    query = sdkQuery, command = process.env.CLAUDE_COMMAND,
    timeoutMs = 900_000, maxOutputBytes = 4_000_000,
    maxEvents = 256, maxConcurrent = 4, maxJobs = 100,
  } = {}) {
    for (const value of [timeoutMs, maxOutputBytes, maxEvents, maxConcurrent, maxJobs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Limits must be positive integers');
    }
    this.query = query;
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.maxEvents = maxEvents;
    this.maxConcurrent = maxConcurrent;
    this.maxJobs = maxJobs;
    this.jobs = new Map();
    this.closing = false;
  }

  start({ prompt, cwd, sessionId, model, permissionMode = 'plan', maxTurns = 50, maxBudgetUsd } = {}) {
    if (this.closing) throw new Error('Server is shutting down');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000)
      throw new Error('prompt must be a nonempty string of at most 100000 characters');
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !statSync(cwd).isDirectory())
      throw new Error('cwd must be an existing absolute directory');
    for (const [name, value] of [['sessionId', sessionId], ['model', model]]) {
      if (value !== undefined && (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value)))
        throw new Error('Invalid ' + name);
    }
    if (!['plan', 'acceptEdits'].includes(permissionMode)) throw new Error('Invalid permissionMode');
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000)
      throw new Error('maxTurns must be between 1 and 1000');
    if (maxBudgetUsd !== undefined && (typeof maxBudgetUsd !== 'number' || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0))
      throw new Error('maxBudgetUsd must be a positive finite number');
    const active = [...this.jobs.values()].filter(record => !record.settled);
    if (active.length >= this.maxConcurrent) throw new Error('Maximum concurrent jobs reached');
    if (sessionId && active.some(record => record.view.sessionId === sessionId))
      throw new Error('Session already has an active turn');
    while (this.jobs.size >= this.maxJobs) {
      const oldest = [...this.jobs.values()].find(record => record.settled);
      if (!oldest) throw new Error('Maximum retained jobs reached');
      this.jobs.delete(oldest.view.id);
    }
    const view = {
      id: randomUUID(), provider: 'claude', backend: 'agent-sdk', status: 'running',
      startedAt: now(), cwd, sessionId: sessionId ?? null, result: null, error: null,
      progress: { phase: 'starting', text: '', textTruncated: false, updatedAt: now() },
      permissionDenials: [], usage: null, costUsd: null,
    };
    const record = { view, controller: new AbortController(), events: [], sequence: 0, bytes: 0, settled: false };
    this.jobs.set(view.id, record);
    // Defer launch so immediate cancellation is observed before starting the SDK.
    record.done = Promise.resolve().then(() => this.run(record, { prompt, sessionId, model, permissionMode, maxTurns, maxBudgetUsd }));
    return this.snapshot(record);
  }

  async run(record, request) {
    const { view, controller } = record;
    let stream; const processes = [];
    const timer = setTimeout(() => this.stop(record, 'timed_out', 'Job exceeded its time limit'), this.timeoutMs);
    try {
      if (controller.signal.aborted) return;
      stream = this.query({
        prompt: request.prompt,
        options: {
          cwd: view.cwd,
          spawnClaudeCodeProcess: options => { const process = trackedSpawn(options); processes.push(process); return process.child; },
          ...(this.command ? { pathToClaudeCodeExecutable: this.command } : {}),
          ...(request.sessionId ? { resume: request.sessionId } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...(request.maxBudgetUsd !== undefined ? { maxBudgetUsd: request.maxBudgetUsd } : {}),
          maxTurns: request.maxTurns,
          permissionMode: request.permissionMode,
          allowDangerouslySkipPermissions: false,
          includePartialMessages: true,
          persistSession: true,
          abortController: controller,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project', 'local'],
          strictMcpConfig: true,
          mcpServers: {},
          disallowedTools: ['mcp__*'],
          canUseTool: async (toolName, _input, context) => {
            this.denial(record, toolName, context?.toolUseID);
            return { behavior: 'deny', message: 'This bridge cannot approve additional permissions. Ask the user in an interactive Claude session.' };
          },
        },
      });
      let gotResult = false;
      for await (const message of stream) {
        if (controller.signal.aborted) break;
        const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (messageBytes > this.maxOutputBytes) {
          this.stop(record, 'failed', 'SDK output exceeded the configured byte limit');
          break;
        }
        this.consume(record, message);
        if (message.type === 'result') { gotResult = true; break; }
      }
      if (!controller.signal.aborted && !gotResult)
        throw new Error('SDK stream ended without a result');
    } catch (error) {
      if (!controller.signal.aborted) {
        record.outcome = { status: 'failed', error: bounded(error.message || error) };
      }
    } finally {
      clearTimeout(timer);
      try { stream?.close?.(); } catch (error) {
        if (!controller.signal.aborted) record.outcome = { status: 'failed', error: 'SDK cleanup failed: ' + bounded(error.message) };
      }
      await Promise.all(processes.map(process => process.finish()));
      if (!controller.signal.aborted && record.outcome) Object.assign(view, record.outcome);
      view.finishedAt = now();
      view.progress.phase = view.status;
      view.progress.updatedAt = now();
      record.settled = true;
      this.event(record, 'finished', { status: view.status });
    }
  }

  consume(record, message) {
    const { view } = record;
    view.progress.updatedAt = now();
    if (message.type === 'system' && message.subtype === 'init') {
      if (typeof message.session_id === 'string') view.sessionId = message.session_id;
      view.progress.phase = 'running';
      this.event(record, 'session', { sessionId: view.sessionId });
    } else if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = String(event.delta.text ?? '');
        const combined = view.progress.text + text;
        view.progress.text = combined.slice(-16000);
        view.progress.textTruncated ||= combined.length > 16000;
        this.event(record, 'text', { text: bounded(text), truncated: text.length > 4000 });
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        this.event(record, 'tool', { name: bounded(event.content_block.name, 128) });
      }
    } else if (message.type === 'result') {
      if (typeof message.session_id === 'string') view.sessionId = message.session_id;
      view.usage = message.usage ?? null;
      view.costUsd = message.total_cost_usd ?? null;
      for (const denial of message.permission_denials ?? []) this.denial(record, denial.tool_name, denial.tool_use_id);
      if (message.subtype === 'success' && message.is_error === false && typeof message.result === 'string') {
        record.outcome = { status: 'completed', result: message.result };
        view.progress.phase = 'finishing';
      } else {
        record.outcome = { status: 'failed', error: bounded(message.result || message.errors?.join('; ') || message.subtype || 'Invalid SDK result') };
        view.progress.phase = 'finishing';
      }
    }
  }

  denial(record, toolName, toolUseId) {
    const item = { toolName: bounded(toolName, 128), toolUseId: bounded(toolUseId, 128) };
    if (!record.view.permissionDenials.some(d => d.toolName === item.toolName && d.toolUseId === item.toolUseId)) {
      record.view.permissionDenials.push(item);
      if (record.view.permissionDenials.length > 50) record.view.permissionDenials.shift();
      this.event(record, 'permission_denied', item);
    }
  }

  event(record, type, data) {
    record.events.push({ sequence: ++record.sequence, at: now(), type, ...data });
    if (record.events.length > this.maxEvents) record.events.shift();
  }

  get(id) {
    const record = this.jobs.get(id);
    if (!record) throw new Error('job not found');
    return record;
  }

  snapshot(record) { return structuredClone(record.view); }
  status(id) { return this.snapshot(this.get(id)); }
  list() { return [...this.jobs.values()].map(record => this.snapshot(record)); }
  async wait(id) { const record = this.get(id); await record.done; return this.snapshot(record); }

  events(id, { after = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a nonnegative integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
    const record = this.get(id);
    const events = record.events.filter(event => event.sequence > after).slice(0, limit);
    return structuredClone({
      events, nextCursor: events.at(-1)?.sequence ?? after,
      truncated: record.events.length > 0 && after < record.events[0].sequence - 1,
      hasMore: events.length > 0 && events.at(-1).sequence < record.sequence,
    });
  }

  stop(record, status, error = null) {
    if (record.view.status !== 'running') return;
    record.view.status = status;
    record.view.error = error;
    record.controller.abort();
  }

  cancel(id) {
    const record = this.get(id);
    this.stop(record, 'cancelled');
    return this.snapshot(record);
  }

  async shutdown() {
    this.closing = true;
    for (const record of this.jobs.values()) this.stop(record, 'cancelled');
    await Promise.all([...this.jobs.values()].map(record => record.done));
  }
}
