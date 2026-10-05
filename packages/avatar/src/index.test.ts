/**
 * Renderer smoke tests.
 *
 * These do not test visual output (there is no DOM here); they guarantee that
 * `mountAvatar` drives every activity/emotion through the real SVG paint path
 * without throwing, that the wrapper attributes track state, that animation
 * frames run, and that `destroy` unsubscribes. A ~40-line fake DOM keeps this
 * dependency-free.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DotState } from '@doty/dot-state';
import { ACTIVITIES, EMOTIONS } from './mapping.js';
import { mountAvatar } from './index.js';
import type { DotStateSource } from './index.js';

class FakeNode {
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

function node(): FakeNode {
  return new FakeNode();
}

let rafQueue: Array<(time: number) => void> = [];

beforeAll(() => {
  Object.assign(globalThis, {
    document: {
      createElement: () => node(),
      createElementNS: () => node(),
    },
    window: {},
    requestAnimationFrame: (cb: (time: number) => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => undefined,
  });
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
