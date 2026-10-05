import { describe, expect, it } from 'vitest';
import { createDotStore, reduce, INITIAL_DOT_STATE } from './index.js';

describe('DotState axis independence', () => {
  it('emotion change preserves speech and activity', () => {
    const state = {
      activity: 'speaking' as const,
      emotion: 'neutral' as const,
      speech: { viseme: 'AA', energy: 0.5 },
    };
    const next = reduce(state, { type: 'emotion', value: 'happy' });
    expect(next.speech).toEqual(state.speech);
    expect(next.activity).toBe('speaking');
  });

  it('activity change preserves emotion', () => {
    const state = { activity: 'idle' as const, emotion: 'concerned' as const };
    expect(reduce(state, { type: 'activity', value: 'thinking' }).emotion).toBe('concerned');
  });

  it('reset returns to the initial state', () => {
    const store = createDotStore();
    store.dispatch({ type: 'activity', value: 'error' });
    store.dispatch({ type: 'reset' });
    expect(store.get()).toEqual(INITIAL_DOT_STATE);
  });

  it('subscribers fire immediately then on change', () => {
    const store = createDotStore();
    const seen: string[] = [];
    const off = store.subscribe((s) => seen.push(s.activity));
    store.dispatch({ type: 'activity', value: 'working' });
    off();
    store.dispatch({ type: 'activity', value: 'done' });
    expect(seen).toEqual(['idle', 'working']);
  });
});
