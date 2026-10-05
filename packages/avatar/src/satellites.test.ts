import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessStatus } from '@doty/harness-events';
import { mountSatellites, type HarnessStatusSource } from './index.js';

class Node {
  children: Node[] = [];
  parent?: Node;
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  events = new Map<string, (event: { stopPropagation(): void }) => void>();
  textContent = '';
  constructor(readonly tag: string) {}
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  addEventListener(type: string, listener: (event: { stopPropagation(): void }) => void) {
    this.events.set(type, listener);
  }
  fire(type: string) { this.events.get(type)?.({ stopPropagation() {} }); }
}

let frames = new Map<number, (time: number) => void>();
let id = 0;
beforeEach(() => {
  frames = new Map();
  id = 0;
  vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag) });
  vi.stubGlobal('window', {});
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => { frames.delete(key); });
});
afterEach(() => { vi.unstubAllGlobals(); });
const status = (sessionId = 'one', activity: HarnessStatus['status'] = 'thinking'): HarnessStatus => ({
  harness: 'codex', sessionId, project: 'C:/repo', status: activity, lastActivityAt: 100,
});
function source(initial: readonly HarnessStatus[]) {
  const listeners = new Set<(statuses: readonly HarnessStatus[]) => void>();
  const source: HarnessStatusSource = {
    subscribe(listener) { listeners.add(listener); listener(initial); return () => { listeners.delete(listener); }; },
  };
  return { source, emit: (statuses: readonly HarnessStatus[]) => listeners.forEach((listener) => listener(statuses)), listeners };
}
function buttons(element: HTMLElement) {
  return (element as unknown as Node).children.filter((node) => node.tag === 'button');
}
function tick(time: number) {
  const [key, callback] = [...frames.entries()][0]!;
  frames.delete(key);
  callback(time);
}

describe('mountSatellites (additive avatar API)', () => {
  it('renders one keyed button per session, with accessible harness identity and status', () => {
    const feed = source([status(), { ...status(), harness: 'opencode' }, { ...status('t3'), harness: 't3' }]);
    const container = new Node('div');
    const handle = mountSatellites(container as unknown as HTMLElement, feed.source, { reducedMotion: true });
    expect(buttons(handle.element)).toHaveLength(3);
    expect(buttons(handle.element).map((node) => node.getAttribute('data-harness'))).toEqual(['codex', 'opencode', 't3']);
    expect(buttons(handle.element)[0]?.getAttribute('aria-label')).toContain('codex · C:/repo · thinking');
    expect(frames.size).toBe(0);
    handle.destroy();
    expect(feed.listeners.size).toBe(0);
    expect(container.children).toHaveLength(0);
  });

  it('updates status without replacing the button and selects its latest metadata', () => {
    const feed = source([status()]);
    const onSelect = vi.fn();
    const handle = mountSatellites(new Node('div') as unknown as HTMLElement, feed.source, { reducedMotion: true, onSelect });
    const button = buttons(handle.element)[0]!;
    const borders = new Set<string>();
    for (const activity of ['thinking', 'tool_calling', 'waiting_approval', 'done', 'error', 'stale'] as const) {
      feed.emit([status('one', activity)]);
      expect(buttons(handle.element)[0]).toBe(button);
      borders.add(button.children[0]!.style['borderColor']!);
      button.fire('click');
      expect(onSelect).toHaveBeenLastCalledWith(status('one', activity));
    }
    expect(borders.size).toBe(6);
    expect(button.children[0]?.style['opacity']).toBe('0.55');
    feed.emit([]);
    expect(buttons(handle.element)).toHaveLength(0);
    handle.destroy();
  });

  it('orbits, pauses a pointed-at dot, and cancels animation on destroy', () => {
    const feed = source([status()]);
    const handle = mountSatellites(new Node('div') as unknown as HTMLElement, feed.source, { reducedMotion: false });
    const button = buttons(handle.element)[0]!;
    const initial = button.style['transform'];
    tick(100);
    tick(200);
    expect(button.style['transform']).not.toBe(initial);
    button.fire('pointerenter');
    const paused = button.style['transform'];
    tick(300);
    expect(button.style['transform']).toBe(paused);
    button.fire('pointerleave');
    tick(400);
    expect(button.style['transform']).not.toBe(paused);
    handle.destroy();
    expect(frames.size).toBe(0);
  });

  it('follows runtime reduced-motion changes and removes its media-query listener', () => {
    let reduce = true;
    let changed: (() => void) | undefined;
    const remove = vi.fn();
    const query = { get matches() { return reduce; }, addEventListener: (_: string, cb: () => void) => { changed = cb; }, removeEventListener: remove };
    vi.stubGlobal('window', { matchMedia: () => query });
    const feed = source([status()]);
    const handle = mountSatellites(new Node('div') as unknown as HTMLElement, feed.source);
    expect(frames.size).toBe(0);
    reduce = false;
    changed?.();
    expect(frames.size).toBe(1);
    reduce = true;
    changed?.();
    expect(frames.size).toBe(0);
    handle.destroy();
    expect(remove).toHaveBeenCalledWith('change', changed);
  });

  it('never caps the team and ignores updates after destruction', () => {
    const feed = source([]);
    const handle = mountSatellites(new Node('div') as unknown as HTMLElement, feed.source, { reducedMotion: true });
    handle.setStatuses(Array.from({ length: 25 }, (_, i) => status(String(i))));
    expect(buttons(handle.element)).toHaveLength(25);
    expect(handle.element.getAttribute('data-orbit-rings')).toBe('3');
    handle.destroy();
    handle.setStatuses([status()]);
    expect(frames.size).toBe(0);
  });
});
