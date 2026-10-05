import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventLog } from './log.js';

function appendN(log: InMemoryEventLog, n: number): number[] {
  const seqs: number[] = [];
  for (let i = 0; i < n; i += 1) {
    seqs.push(log.append({ type: 'tick', data: { i } }).seq);
  }
  return seqs;
}

describe('InMemoryEventLog', () => {
  it('assigns strictly increasing seq starting at 1 and tracks the cursor', () => {
    const log = new InMemoryEventLog();
    expect(log.cursor).toBe(0);
    expect(appendN(log, 3)).toEqual([1, 2, 3]);
    expect(log.cursor).toBe(3);
  });

  it('since(k) returns exactly the tail after k', () => {
    const log = new InMemoryEventLog();
    appendN(log, 5);

    expect(log.since(2).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(log.since(4).map((e) => e.seq)).toEqual([5]);
    expect(log.since(5)).toEqual([]);
  });

  it('since(0) replays the entire log', () => {
    const log = new InMemoryEventLog();
    appendN(log, 4);
    expect(log.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('preserves insertion order and payloads in a replay', () => {
    const log = new InMemoryEventLog();
    log.append({ type: 'a', data: { n: 1 }, ts: 100 });
    log.append({ type: 'b', data: { n: 2 }, ts: 200 });

    const replay = log.since(0);
    expect(replay).toEqual([
      { seq: 1, type: 'a', ts: 100, data: { n: 1 } },
      { seq: 2, type: 'b', ts: 200, data: { n: 2 } },
    ]);
  });

  it('defaults ts to the append time when omitted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
    try {
      const log = new InMemoryEventLog();
      const event = log.append({ type: 'tick', data: null });
      expect(event.ts).toBe(Date.parse('2026-10-05T12:00:00Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers live events to every subscriber in order', () => {
    const log = new InMemoryEventLog();
    const first: number[] = [];
    const second: number[] = [];

    log.subscribe((e) => first.push(e.seq));
    log.subscribe((e) => second.push(e.seq));

    appendN(log, 3);

    expect(first).toEqual([1, 2, 3]);
    expect(second).toEqual([1, 2, 3]);
  });

  it('stops delivering after unsubscribe', () => {
    const log = new InMemoryEventLog();
    const seen: number[] = [];
    const unsubscribe = log.subscribe((e) => seen.push(e.seq));

    appendN(log, 2);
    unsubscribe();
    appendN(log, 1);

    expect(seen).toEqual([1, 2]);
  });

  it('replays history then continues live without gaps or duplicates', () => {
    const log = new InMemoryEventLog();
    appendN(log, 3); // client saw 2, missed 3

    const replayed = log.since(2).map((e) => e.seq);
    const live: number[] = [];
    log.subscribe((e) => live.push(e.seq));
    appendN(log, 2);

    expect([...replayed, ...live]).toEqual([3, 4, 5]);
  });

  it('keeps the log consistent when a listener throws', () => {
    const log = new InMemoryEventLog();
    const seen: number[] = [];
    log.subscribe(() => {
      throw new Error('boom');
    });
    log.subscribe((e) => seen.push(e.seq));

    expect(() => log.append({ type: 'tick', data: null })).not.toThrow();
    expect(seen).toEqual([1]);
    expect(log.since(0)).toHaveLength(1);
  });
});
