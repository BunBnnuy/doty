/**
 * Map a raw SSE frame onto the shared `DotState` store and the chat/run list.
 *
 * `data` is the JSON payload only — never a `ServerToClient` wrapper, and
 * never a full `ServerEvent` (`ts` is not on the wire). `connection` is
 * client-owned and is never taken from a frame.
 */

import type { Activity, DotStore, Emotion, Speech } from '@doty/dot-state';
import type { SseFrame } from './sse.js';

const ACTIVITIES: readonly Activity[] = [
  'idle',
  'listening',
  'thinking',
  'working',
  'speaking',
  'waiting_approval',
  'done',
  'error',
];

const EMOTIONS: readonly Emotion[] = ['neutral', 'happy', 'curious', 'concerned', 'focused'];

/** Event names that update the avatar and should not also become chat rows. */
const SILENT = new Set([
  'hello',
  'pong',
  'ping',
  'dot_state',
  'activity',
  'emotion',
  'speech',
  'progress',
  'label',
  'connection',
]);

export interface ChatLine {
  seq?: number;
  role: 'user' | 'assistant' | 'run';
  text: string;
  tone?: 'error';
}

export interface AppliedFrame {
  /** True when this frame changed an avatar axis. Chat should not invent activity on top. */
  droveAvatar: boolean;
  line: ChatLine | null;
}

export function applyFrame(store: DotStore, frame: SseFrame): AppliedFrame {
  const droveAvatar = projectFrame(store, frame);
  return { droveAvatar, line: toChatLine(frame) };
}

function projectFrame(store: DotStore, frame: SseFrame): boolean {
  if (frame.type === 'dot_state') {
    const state = readDotState(frame.data);
    if (!state) return false;
    store.dispatch({
      type: 'activity',
      value: state.activity,
      ...(state.label !== undefined ? { label: state.label } : {}),
    });
    store.dispatch({ type: 'emotion', value: state.emotion });
    if (state.speech !== undefined) store.dispatch({ type: 'speech', value: state.speech });
    if (state.progress !== undefined) store.dispatch({ type: 'progress', value: state.progress });
    return true;
  }

  if (frame.type === 'error') {
    const text = readText(frame.data);
    store.dispatch({ type: 'activity', value: 'error', label: text });
    return true;
  }

  return applyGranular(store, frame.type, frame.data);
}

interface ReadState {
  activity: Activity;
  emotion: Emotion;
  speech?: Speech | null;
  progress?: number | null;
  label?: string | null;
}

function readDotState(data: unknown): ReadState | null {
  const record = unwrapState(data);
  if (!record) return null;
  if (!isActivity(record.activity) || !isEmotion(record.emotion)) return null;
  const state: ReadState = { activity: record.activity, emotion: record.emotion };
  if ('label' in record) {
    const label = record.label;
    if (label === null || typeof label === 'string') state.label = label;
  }
  if ('speech' in record) {
    if (record.speech === null) state.speech = null;
    else {
      const speech = parseSpeech(record.speech);
      if (speech) state.speech = speech;
    }
  }
  if ('progress' in record) {
    const progress = record.progress;
    if (progress === null || typeof progress === 'number') state.progress = progress;
  }
  return state;
}

function unwrapState(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  // Wire payload is `DotStateEvent` (`{ state }`) or a bare `DotState`.
  if (isRecord(data.state) && typeof data.state.activity === 'string') return data.state;
  if (typeof data.activity === 'string') return data;
  return null;
}

function applyGranular(store: DotStore, type: string, data: unknown): boolean {
  const value = isRecord(data) && 'value' in data ? data.value : data;
  switch (type) {
    case 'activity': {
      if (!isActivity(value)) return false;
      const label = isRecord(data) ? data.label : undefined;
      store.dispatch({
        type: 'activity',
        value,
        ...(label === null || typeof label === 'string' ? { label } : {}),
      });
      return true;
    }
    case 'emotion': {
      if (!isEmotion(value)) return false;
      store.dispatch({ type: 'emotion', value });
      return true;
    }
    case 'speech': {
      if (value === null) {
        store.dispatch({ type: 'speech', value: null });
        return true;
      }
      const speech = parseSpeech(value);
      if (!speech) return false;
      store.dispatch({ type: 'speech', value: speech });
      return true;
    }
    case 'progress': {
      if (value === null || typeof value === 'number') {
        store.dispatch({ type: 'progress', value });
        return true;
      }
      return false;
    }
    case 'label': {
      if (value !== null && typeof value !== 'string') return false;
      store.dispatch({ type: 'label', value });
      return true;
    }
    default:
      return false;
  }
}

/** Events that carry the assistant's answer. Everything else is step noise. */
const ANSWER_EVENTS = new Set(['assistant', 'reply', 'response', 'assistant_message', 'final']);

export function toChatLine(frame: SseFrame): ChatLine | null {
  if (SILENT.has(frame.type)) return null;

  if (frame.type === 'message') {
    const text = readText(frame.data);
    if (!text) return null;
    const role = isRecord(frame.data) && frame.data.role === 'assistant' ? 'assistant' : 'user';
    return { seq: frame.seq, role, text };
  }

  if (ANSWER_EVENTS.has(frame.type)) {
    const text = readText(frame.data);
    if (!text) return null;
    // `assistant_message` (per turn) and `final` (run end) repeat the same text;
    // the chat panel drops the duplicate by text.
    return { seq: frame.seq, role: 'assistant', text };
  }

  if (frame.type === 'error') {
    const text = readText(frame.data) ?? 'Something went wrong';
    return { seq: frame.seq, role: 'run', text, tone: 'error' };
  }

  // model_step, tool_call, tool_result, observation, dot_state, run_started, …
  // are intentionally hidden: the chat shows only what you said and what Doty
  // answered.
  return null;
}

function summarize(frame: SseFrame): string | null {
  const text = readText(frame.data);
  if (text) return clip(`${frame.type} · ${text}`);
  if (isRecord(frame.data)) {
    const label = frame.data.label;
    if (typeof label === 'string' && label) return clip(`${frame.type} · ${label}`);
    const tool = frame.data.tool;
    const name = isRecord(tool) ? tool.name : tool;
    if (typeof name === 'string' && name) return clip(`${frame.type} · ${name}`);
  }
  return frame.type;
}

export function readText(data: unknown): string | null {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    return trimmed ? trimmed : null;
  }
  if (!isRecord(data)) return null;
  for (const key of ['text', 'message', 'content'] as const) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function parseSpeech(value: unknown): Speech | null {
  if (!isRecord(value) || typeof value.viseme !== 'string' || typeof value.energy !== 'number') {
    return null;
  }
  return { viseme: value.viseme, energy: value.energy };
}

function isActivity(value: unknown): value is Activity {
  return typeof value === 'string' && (ACTIVITIES as readonly string[]).includes(value);
}

function isEmotion(value: unknown): value is Emotion {
  return typeof value === 'string' && (EMOTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? `${flat.slice(0, 237)}…` : flat;
}
