import { describe, expect, it } from 'vitest';
import { createHarnessStore, latestLineTs, newAssistantLines, newResponseLines, readHarnessStatus } from './harness.js';

const sample = { harness: 'codex', sessionId: 'same-id', status: 'thinking', lastActivityAt: 1_000, project: 'C:/repo' };
describe('local harness read model', () => {
  it('whitelists metadata and drops transcript text, tool args and unknown keys', () => {
    const clean = readHarnessStatus({ ...sample, text: 'PRIVATE', tool: { args: 'PRIVATE' }, extra: 'PRIVATE' });
    expect(clean).toEqual(sample);
    expect(JSON.stringify(clean)).not.toContain('PRIVATE');
    for (const bad of [null, [], { ...sample, harness: 'unknown' }, { ...sample, status: 'unknown' },
      { ...sample, lastActivityAt: Number.NaN }, { ...sample, lastActivityAt: -1 }, { ...sample, sessionId: '' }]) {
      expect(readHarnessStatus(bad)).toBeNull();
    }
  });
  it('keeps distinct harness/session keys and rejects backwards updates', () => {
    const store = createHarnessStore();
    store.ingest(sample);
    store.ingest({ ...sample, harness: 'opencode' });
    store.ingest({ ...sample, lastActivityAt: 500, status: 'error' });
    expect(store.all()).toHaveLength(2);
    expect(store.all()[0]?.status).toBe('thinking');
    store.ingest({ ...sample, status: 'stale' });
    expect(store.all()[0]?.status).toBe('stale');
  });
  it('retains all last statuses but only displays active or recent terminal sessions', () => {
    const store = createHarnessStore();
    store.ingest(sample);
    store.ingest({ ...sample, sessionId: 'finished', status: 'done' });
    store.ingest({ ...sample, sessionId: 'approval', status: 'waiting_approval' });
    expect(store.visible(2_000)).toHaveLength(3);
    expect(store.visible(1_000_000).map((s) => s.sessionId)).toEqual(['approval', 'same-id']);
    expect(store.all()).toHaveLength(3);
    let notifications = 0;
    const stop = store.source.subscribe(() => { notifications += 1; });
    store.refresh();
    expect(notifications).toBe(2);
    stop();
    store.refresh();
    expect(notifications).toBe(2);
  });
});

describe('new assistant responses', () => {
  const line = (kind: string, ts: number, text?: string) => ({ ts, kind, ...(text !== undefined ? { text } : {}) });

  it('selects only new, non-empty assistant lines, oldest first', () => {
    const lines = [
      line('assistant', 100, 'first'),
      line('user', 200, 'a question'),
      line('assistant', 300, '   '),
      line('assistant', 400, 'second'),
      line('assistant', 500, 'third'),
    ];
    expect(newAssistantLines(lines, 100).map((l) => l.text)).toEqual(['second', 'third']);
    expect(newAssistantLines(lines, 400).map((l) => l.text)).toEqual(['third']);
    expect(newAssistantLines(lines, 999)).toEqual([]);
  });

  it('tracks the newest activity timestamp for the watermark', () => {
    expect(latestLineTs([line('assistant', 10), line('tool_call', 42)], 0)).toBe(42);
    expect(latestLineTs([], 7)).toBe(7);
  });

  it('also selects reasoning lines, in order and skipping tool noise', () => {
    const lines = [
      line('assistant', 100, 'reply'),
      line('thinking', 200, 'pondering'),
      line('tool_call', 250),
      line('thinking', 300, 'still pondering'),
      line('thinking', 400, '   '),
    ];
    expect(newResponseLines(lines, 100).map((l) => `${l.kind}:${l.text}`)).toEqual([
      'thinking:pondering',
      'thinking:still pondering',
    ]);
  });
});
