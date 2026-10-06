import { describe, expect, it } from 'vitest';
import { rowsToDrop } from './limit.js';

const sent = (count: number): string[] => Array.from({ length: count }, () => 'sent');

describe('chat row limit', () => {
  it('keeps everything under the cap', () => {
    expect(rowsToDrop(sent(10), 10)).toEqual([]);
    expect(rowsToDrop(sent(3), 10)).toEqual([]);
    expect(rowsToDrop([], 10)).toEqual([]);
  });

  it('drops the oldest rows, oldest first', () => {
    expect(rowsToDrop(sent(13), 10)).toEqual([0, 1, 2]);
  });

  it('never drops an in-flight send while sent rows can go', () => {
    const statuses = ['pending', ...sent(11)];
    const drop = rowsToDrop(statuses, 10);
    expect(drop).toEqual([1, 2]);
    expect(drop).not.toContain(0);
  });

  it('falls back to dropping any rows when none are sent', () => {
    expect(rowsToDrop(Array.from({ length: 12 }, () => 'queued'), 10)).toEqual([0, 1]);
  });

  it('treats a negative cap as unbounded', () => {
    expect(rowsToDrop(sent(5), -1)).toEqual([]);
  });
});
