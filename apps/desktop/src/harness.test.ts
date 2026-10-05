import { describe, expect, it } from 'vitest';
import { createHarnessStore, readHarnessStatus } from './harness.js';

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
