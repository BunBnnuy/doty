/**
 * Renderer smoke tests.
 *
 * These do not test visual output (there is no DOM here); they guarantee that
 * `mountAvatar` drives every activity/emotion through the real SVG paint path
 * without throwing, that the wrapper attributes track state, that animation
 * frames run, and that `destroy` unsubscribes. A ~40-line fake DOM keeps this
 * dependency-free.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DotState } from '@doty/dot-state';
import { ACTIVITIES, EMOTIONS } from './mapping.js';
import { mountAvatar } from './index.js';
import type { DotStateSource } from './index.js';

class FakeNode {
  constructor(readonly tagName = 'div') {}
  readonly children: FakeNode[] = [];
  readonly attributes: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  textContent = '';
  setAttribute(key: string, value: string): void {
    this.attributes[key] = String(value);
  }
  getAttribute(key: string): string | null {
    return this.attributes[key] ?? null;
  }
  appendChild(child: FakeNode): FakeNode {
    this.children.push(child);
    return child;
  }
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  remove(): void {
    /* no parent tracking needed */
  }
}

function node(tagName?: string): FakeNode {
  return new FakeNode(tagName);
}

function descendants(root: FakeNode): FakeNode[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function parts(handle: ReturnType<typeof mountAvatar>, part: string): FakeNode[] {
  return descendants(handle.element as unknown as FakeNode).filter((child) => child.getAttribute('data-part') === part);
}

let rafQueue: Array<(time: number) => void> = [];

beforeAll(() => {
  Object.assign(globalThis, {
    document: {
      createElement: (tag: string) => node(tag),
      createElementNS: (_ns: string, tag: string) => node(tag),
    },
    window: {},
    requestAnimationFrame: (cb: (time: number) => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => { rafQueue = []; },
  });
});

beforeEach(() => {
  rafQueue = [];
  Object.assign(globalThis, { window: {} });
});

afterAll(() => {
  for (const key of ['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    Reflect.deleteProperty(globalThis, key);
  }
});

function makeSource(initial: DotState): { source: DotStateSource; emit: (state: DotState) => void; count: () => number } {
  const listeners = new Set<(state: DotState) => void>();
  return {
    source: {
      subscribe(listener) {
        listeners.add(listener);
        listener(initial);
        return () => listeners.delete(listener);
      },
    },
    emit(state) {
      for (const listener of listeners) listener(state);
    },
    count: () => listeners.size,
  };
}

describe('mountAvatar', () => {
  it('has exactly two black capsule eyes, two oval cheeks, flat hair and a star; no extra face marks', () => {
    const { source } = makeSource({ activity: 'idle', emotion: 'neutral' });
    const handle = mountAvatar(node() as unknown as HTMLElement, source, { reducedMotion: true, size: 48 });
    const tree = descendants(handle.element as unknown as FakeNode);
    const eyes = parts(handle, 'eye');
    expect(eyes).toHaveLength(2);
    for (const eye of eyes) {
      expect(eye.getAttribute('stroke')).toBe('#000000');
      expect(eye.getAttribute('stroke-linecap')).toBe('round');
      expect(eye.getAttribute('stroke-width')).toBe('7.000');
    }
    expect(eyes[0]?.getAttribute('d')).toBe('M 38.000 52.500 Q 38.000 58.000 38.000 63.500');
    expect(eyes[1]?.getAttribute('d')).toBe('M 62.000 52.500 Q 62.000 58.000 62.000 63.500');
    expect(parts(handle, 'blush')).toHaveLength(2);
    expect(parts(handle, 'blush').every((cheek) => cheek.tagName === 'ellipse')).toBe(true);
    expect(parts(handle, 'star-clip')).toHaveLength(1);
    expect(parts(handle, 'hair-pink')).toHaveLength(1);
    expect(parts(handle, 'hair-lavender')).toHaveLength(1);
    expect(tree.filter((child) => child.getAttribute('stroke') !== null)).toEqual(eyes);
    expect(tree.some((child) => ['filter', 'radialGradient', 'linearGradient', 'circle'].includes(child.tagName))).toBe(false);
    expect(tree.some((child) => /mouth|nose|brow|pupil|shine/.test(child.getAttribute('data-part') ?? ''))).toBe(false);
    expect(rafQueue).toHaveLength(0);
    handle.destroy();
  });

  it('paints distinct static activity and emotion poses, including speech energy, without adding face marks', () => {
    const { source } = makeSource({ activity: 'idle', emotion: 'neutral' });
    const handle = mountAvatar(node() as unknown as HTMLElement, source, { reducedMotion: true });
    const signature = () => JSON.stringify([
      parts(handle, 'head')[0]?.attributes,
      parts(handle, 'eye').map((eye) => eye.attributes),
      parts(handle, 'blush')[0]?.attributes,
      parts(handle, 'hair-pink')[0]?.attributes,
    ]);
    const activityPoses = ACTIVITIES.map((activity) => {
      handle.setState({ activity, emotion: 'neutral' });
      return signature();
    });
    expect(new Set(activityPoses).size).toBe(ACTIVITIES.length);
    const emotionPoses = EMOTIONS.map((emotion) => {
      handle.setState({ activity: 'idle', emotion });
      return signature();
    });
    expect(new Set(emotionPoses).size).toBe(EMOTIONS.length);
    handle.setState({ activity: 'speaking', emotion: 'neutral', speech: { viseme: 'AA', energy: 0 } });
    const quiet = signature();
    handle.setState({ activity: 'speaking', emotion: 'neutral', speech: { viseme: 'AA', energy: 1 } });
    expect(signature()).not.toBe(quiet);
    expect(parts(handle, 'eye')).toHaveLength(2);
    const loud = signature();
    handle.setState({ activity: 'speaking', emotion: 'neutral', speech: { viseme: 'AA', energy: 1 } });
    expect(signature()).toBe(loud); // reduced-motion pose is stable
    handle.destroy();
  });

  it('honors the system motion preference and stops/resumes on preference changes', () => {
    let reduce = true;
    let listener: (() => void) | undefined;
    let removed = false;
    Object.assign(globalThis, { window: { matchMedia: () => ({
      matches: reduce,
      addEventListener: (_type: string, cb: () => void) => { listener = cb; },
      removeEventListener: (_type: string, cb: () => void) => { removed = cb === listener; },
    }) } });
    const { source } = makeSource({ activity: 'working', emotion: 'focused' });
    const handle = mountAvatar(node() as unknown as HTMLElement, source);
    expect(rafQueue).toHaveLength(0);
    expect(parts(handle, 'eye')[0]?.getAttribute('d')).toBeTruthy();
    reduce = false;
    listener?.();
    expect(rafQueue).toHaveLength(1);
    reduce = true;
    listener?.();
    expect(rafQueue).toHaveLength(0);
    handle.destroy();
    expect(removed).toBe(true);
  });

  it('connection dims the head only and never alters eye geometry or speech', () => {
    const initial: DotState = { activity: 'speaking', emotion: 'happy', speech: { viseme: 'AA', energy: 0.7 } };
    const { source } = makeSource(initial);
    const handle = mountAvatar(node() as unknown as HTMLElement, source, { reducedMotion: true });
    const eyes = parts(handle, 'eye').map((eye) => ({ ...eye.attributes }));
    handle.setState({ ...initial, connection: 'offline' });
    expect(parts(handle, 'eye').map((eye) => eye.attributes)).toEqual(eyes);
    expect(parts(handle, 'head')[0]?.getAttribute('opacity')).toBe('0.55');
    expect(parts(handle, 'head')[0]?.style['filter']).toContain('saturate');
    handle.destroy();
  });

  it('mounts an SVG and tracks every activity/emotion via attributes', () => {
    const { source } = makeSource({ activity: 'idle', emotion: 'neutral' });
    const container = node() as unknown as HTMLElement;
    const handle = mountAvatar(container, source, { size: 200, reducedMotion: true });

    expect(handle.element.getAttribute('data-doty-avatar')).toBe('');
    expect(handle.element.children.length).toBe(1); // the <svg>
    expect(handle.element.getAttribute('data-activity')).toBe('idle');

    for (const activity of ACTIVITIES) {
      for (const emotion of EMOTIONS) {
        handle.setState({ activity, emotion });
        expect(handle.element.getAttribute('data-activity')).toBe(activity);
        expect(handle.element.getAttribute('data-emotion')).toBe(emotion);
      }
    }

    handle.destroy();
  });

  it('runs animation frames for each activity without throwing', () => {
    const { source, emit } = makeSource({ activity: 'idle', emotion: 'neutral' });
    const container = node() as unknown as HTMLElement;
    const handle = mountAvatar(container, source, { reducedMotion: false });
    expect(parts(handle, 'eye')[0]?.getAttribute('d')).toBeTruthy();

    let time = 0;
    for (const activity of ACTIVITIES) {
      emit({ activity, emotion: 'happy', speech: { viseme: 'AA', energy: 0.6 }, progress: 0.5 });
      for (let i = 0; i < 4; i += 1) {
        const frame = rafQueue.shift();
        if (!frame) break;
        time += 16;
        frame(time);
      }
    }

    expect(handle.element.getAttribute('data-activity')).toBe('error');
    handle.destroy();
  });

  it('unsubscribes and detaches on destroy', () => {
    const { source, count } = makeSource({ activity: 'thinking', emotion: 'curious' });
    const container = node() as unknown as HTMLElement;
    const handle = mountAvatar(container, source, { reducedMotion: true });
    expect(count()).toBe(1);
    handle.destroy();
    expect(count()).toBe(0);
  });
});
