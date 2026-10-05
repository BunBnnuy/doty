/**
 * DotState — the spine of Doty.
 *
 * The always-on runtime emits this; the avatar consumes it and nothing else.
 * The three axes are INDEPENDENT: an emotion change must not restart speech,
 * and an activity change must not clobber emotion. Every reducer branch below
 * mutates exactly one axis; that invariant is what makes morphing smooth.
 */

export type Activity =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'working'
  | 'speaking'
  | 'waiting_approval'
  | 'done'
  | 'error';

export type Emotion = 'neutral' | 'happy' | 'curious' | 'concerned' | 'focused';

/** Client-owned: the avatar visibly degrades when the link to the brain drops. */
export type Connection = 'online' | 'reconnecting' | 'offline';

export interface Speech {
  /** Opaque viseme id; the renderer maps it to a mouth/ripple shape. */
  viseme: string;
  /** 0..1 loudness. */
  energy: number;
}

export interface DotState {
  activity: Activity;
  emotion: Emotion;
  /** Drives mouth/ripple only. Independent of emotion. */
  speech?: Speech | null;
  /** 0..1, meaningful only while `activity === 'working'`. */
  progress?: number | null;
  /** Short human label, e.g. "Reading 3 sources…". */
  label?: string | null;
  connection?: Connection;
}

export const INITIAL_DOT_STATE: DotState = { activity: 'idle', emotion: 'neutral' };

export type DotEvent =
  | { type: 'activity'; value: Activity; label?: string | null }
  | { type: 'emotion'; value: Emotion }
  | { type: 'speech'; value: Speech | null }
  | { type: 'progress'; value: number | null }
  | { type: 'label'; value: string | null }
  | { type: 'connection'; value: Connection }
  | { type: 'reset' };

export function reduce(state: DotState, event: DotEvent): DotState {
  switch (event.type) {
    case 'activity':
      return {
        ...state,
        activity: event.value,
        ...(event.label !== undefined ? { label: event.label } : {}),
      };
    case 'emotion':
      return { ...state, emotion: event.value };
    case 'speech':
      return { ...state, speech: event.value };
    case 'progress':
      return { ...state, progress: event.value };
    case 'label':
      return { ...state, label: event.value };
    case 'connection':
      return { ...state, connection: event.value };
    case 'reset':
      return { ...INITIAL_DOT_STATE };
  }
}

export type Listener = (state: DotState) => void;

export interface DotStore {
  get(): DotState;
  dispatch(event: DotEvent): void;
  /** Calls the listener immediately with the current state, then on change. */
  subscribe(listener: Listener): () => void;
}

export function createDotStore(initial: DotState = INITIAL_DOT_STATE): DotStore {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    dispatch(event) {
      const next = reduce(state, event);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Demo driver: cycles plausible states so the character can be seen with no
 * backend at all. Returns a stop function.
 */
export function startFakeDriver(store: DotStore, intervalMs = 2200): () => void {
  const steps: DotEvent[] = [
    { type: 'activity', value: 'idle', label: null },
    { type: 'activity', value: 'listening', label: 'Listening…' },
    { type: 'activity', value: 'thinking', label: 'Thinking…' },
    { type: 'activity', value: 'working', label: 'Reading 3 sources…' },
    { type: 'progress', value: 0.66 },
    { type: 'emotion', value: 'curious' },
    { type: 'activity', value: 'speaking' },
    { type: 'speech', value: { viseme: 'AA', energy: 0.7 } },
    { type: 'emotion', value: 'happy' },
    { type: 'speech', value: null },
    { type: 'activity', value: 'done', label: 'Done' },
    { type: 'emotion', value: 'neutral' },
    { type: 'reset' },
  ];
  let i = 0;
  const timer = setInterval(() => {
    store.dispatch(steps[i % steps.length]!);
    i += 1;
  }, intervalMs);
  return () => clearInterval(timer);
}
