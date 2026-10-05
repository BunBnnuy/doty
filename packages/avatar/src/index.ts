/**
 * @doty/avatar — the character.
 *
 * FROZEN INTERFACE (Wave 0). SA-1 implements the rendering behind it; the
 * desktop shell (SA-4) and the satellite-dot layer only ever call this.
 *
 * Framework-agnostic on purpose: the Tauri webview, a demo page, and tests all
 * use the same entry point.
 *
 * Implementation: a flat inline SVG mascot, updated on `requestAnimationFrame`.
 * There are no image assets and no runtime dependencies beyond the frozen
 * `@doty/dot-state` contract. All state → visual decisions live in the pure
 * `./mapping` module; this file only paints them.
 */

import type { DotState } from '@doty/dot-state';
import {
  clamp01,
  deriveVisual,
  stepVisual,
  type AvatarVisual,
} from './mapping.js';

export interface DotStateSource {
  /** Calls `listener` immediately with the current state, then on every change. */
  subscribe(listener: (state: DotState) => void): () => void;
}

export interface AvatarOptions {
  /** Overrides the `prefers-reduced-motion` media query when set. */
  reducedMotion?: boolean;
  /** Base size in CSS pixels. Defaults to 160. */
  size?: number;
}

export interface AvatarHandle {
  readonly element: HTMLElement;
  /** Force-set the state (useful for tests / static screenshots). */
  setState(state: DotState): void;
  destroy(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  }
  return node;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface Renderer {
  readonly svg: SVGSVGElement;
  render(visual: AvatarVisual, dt: number, reduced: boolean): void;
}

/**
 * Build the SVG once and return a render function. All element lookups happen
 * here, never per frame.
 */
function createRenderer(): Renderer {
  const svg = svgElement('svg', { viewBox: '0 0 100 100', width: '100%', height: '100%' });
  svg.style.display = 'block';
  svg.style.overflow = 'hidden';
  svg.setAttribute('aria-hidden', 'true');

  const backdrop = svgElement('rect', { width: 100, height: 100, fill: '#292929' });
  const scene = svgElement('g', { 'data-part': 'head' });
  // Mirror broad silhouettes, not dozens of tiny strands: readable even at 48px.
  const tails = [false, true].map((mirror) => {
    const side = svgElement('g', { transform: mirror ? 'translate(100 0) scale(-1 1)' : '' });
    const tail = svgElement('g', { 'data-part': 'twintail' });
    tail.append(svgElement('path', {
      fill: '#dedde3',
      d: 'M 25 26 C 13 22 9 35 11 51 C 13 65 3 71 7 82 C 9 90 18 92 12 95 C 23 97 28 89 23 80 C 17 69 30 66 27 51 C 25 40 30 32 25 26 Z',
    }), svgElement('path', {
      fill: '#efedf1',
      d: 'M 24 28 C 14 35 17 49 17 58 C 17 68 8 73 12 83 C 15 89 20 91 17 94 C 26 90 21 83 20 79 C 16 68 28 64 24 51 C 21 41 28 31 24 28 Z',
    }));
    side.append(tail);
    scene.append(side);
    return tail;
  });
  const hairBack = svgElement('path', {
    'data-part': 'hair-back', fill: '#dedde3',
    d: 'M 23 46 C 22 27 33 17 50 17 C 68 17 79 29 77 48 L 76 64 Q 74 74 66 78 L 34 78 Q 23 72 23 60 Z',
  });
  const skin = svgElement('path', {
    fill: '#f8f1e9', 'data-part': 'face',
    d: 'M 29 42 Q 29 28 50 28 Q 71 28 71 42 L 71 55 C 71 69 62 76 50 76 C 38 76 29 68 29 55 Z',
  });
  const blush = [35, 65].map((cx) => svgElement('ellipse', {
    'data-part': 'blush', cx, cy: 62, rx: 4.7, ry: 2.9, fill: '#f3bfc6',
  }));
  // Each eye is ONE round-capped solid black shape, including during a squint.
  const eyes = [41, 59].map(() => svgElement('path', {
    'data-part': 'eye', fill: 'none', stroke: '#000000', 'stroke-linecap': 'round',
  }));
  const fringe = svgElement('g', { 'data-part': 'hair-front' });
  fringe.append(svgElement('path', {
    fill: '#efedf1',
    d: 'M 50 18 C 33 16 24 29 25 47 C 25 58 28 64 33 65 C 28 60 30 53 31 47 C 38 43 42 35 44 30 C 43 42 47 50 54 52 C 51 47 54 40 54 33 C 58 41 64 47 70 49 C 71 58 69 62 66 65 C 75 62 77 51 75 40 C 73 25 63 17 50 18 Z',
  }), svgElement('path', {
    fill: '#d1cfd8',
    d: 'M 49 22 C 43 31 44 43 51 48 C 46 39 50 32 49 22 Z',
  }));
  const ahoge = svgElement('path', {
    'data-part': 'ahoge', fill: '#efedf1',
    d: 'M 49 21 C 54 12 53 6 47 7 C 39 8 36 14 37 19 C 34 12 39 5 46 4 C 58 2 60 15 49 21 Z',
  });
  scene.append(hairBack, skin, ...blush, ...eyes, fringe, ahoge);
  const horns = [false, true].map((mirror) => {
    const side = svgElement('g', { transform: mirror ? 'translate(100 0) scale(-1 1)' : '' });
    const bow = svgElement('path', {
      'data-part': 'bow', fill: '#19191d',
      d: 'M 24 30 Q 18 26 18 32 L 18 36 Q 20 37 24 34 Q 28 38 30 36 L 29 31 Q 28 28 24 30 Z M 23 33 L 19 41 L 23 40 L 25 34 L 27 41 L 30 39 L 26 33 Z',
    });
    const horn = svgElement('g', { 'data-part': 'horn' });
    horn.append(svgElement('path', {
      fill: '#fbf7f3',
      d: 'M 24 31 C 16 31 17 23 21 20 C 25 17 25 14 24 10 C 30 14 32 23 27 25 C 25 26 23 25 22 24 C 21 28 26 28 28 26 C 29 29 27 31 24 31 Z',
    }), svgElement('path', {
      'data-part': 'horn-tip', fill: '#f3d2d6',
      d: 'M 24 12 C 28 16 29 21 27 23 C 27 19 25 18 24 12 Z',
    }));
    side.append(bow, horn);
    scene.append(side);
    return horn;
  });
  svg.append(backdrop, scene);

  // Monotonic animation clock + phase accumulators. These are never reset on
  // state change, so transitions never "restart".
  let elapsed = 0;
  let bobPhase = 0;
  let pulsePhase = 0;

  function render(v: AvatarVisual, dt: number, reduced: boolean): void {
    const a = v.activity;
    const e = v.emotion;
    const s = v.speech;
    const c = v.connection;

    if (!reduced && dt > 0) {
      elapsed += dt;
      bobPhase += dt / Math.max(0.25, a.bobPeriod);
      pulsePhase += dt * a.pulseHz;
    }
    const still = reduced ? 0 : 1;

    // Connection degradation: desaturate + dim the whole scene.
    const desat = clamp01(c.desaturate);
    scene.style.filter = desat > 0 ? `saturate(${clamp01(1 - desat * 0.9)})` : '';
    // A slow, quiet connection fade; the backdrop itself stays charcoal.
    const flicker = 1 - still * c.glitch * 0.08 * (0.5 + 0.5 * Math.sin(elapsed * 3));
    scene.setAttribute('opacity', String(clamp01(c.opacity * flicker)));

    const pulse = Math.sin(pulsePhase * Math.PI * 2);
    const bobY = still * Math.sin(bobPhase * Math.PI * 2) * a.bob * 100;
    // Activity pulse and speech emphasis compose without resetting either clock.
    const breath = 1 + still * pulse * a.glow * 0.012;
    const speechPulse = still * s.ripple * Math.sin(elapsed * 11) * 0.008;
    const progressLift = (a.progress ?? 0) * 0.012;
    const sx = a.scale * a.stretchX * (breath + speechPulse + progressLift);
    const sy = a.scale * a.stretchY * (breath - speechPulse + progressLift);
    const tilt = -a.lookY * 7 + e.brow * 7;
    scene.setAttribute('transform', `translate(50 ${(50 + bobY).toFixed(3)}) rotate(${tilt.toFixed(3)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(-50 -50)`);

    // Separate secondary motion, with a deterministic resting pose when reduced.
    const sway = still * Math.sin(elapsed * 1.8) * (0.5 + a.glow * 0.8 + s.ripple * 0.4);
    tails.forEach((tail, i) => tail.setAttribute('transform', `rotate(${(sway * (i === 0 ? 1 : -1)).toFixed(3)} 24 30)`));
    horns.forEach((horn, i) => horn.setAttribute('transform', `rotate(${(sway * 0.3 * (i === 0 ? 1 : -1)).toFixed(3)} 24 29)`));
    fringe.setAttribute('transform', `rotate(${(sway * 0.18).toFixed(3)} 50 22)`);
    ahoge.setAttribute('transform', `rotate(${(sway * 1.2).toFixed(3)} 49 21)`);

    // Legacy speech field names are preserved for type compatibility, but drive
    // eye squint/width only. There is deliberately no mouth or nose in this SVG.
    const openness = clamp(a.eyeOpen + e.eyeOpen - s.mouthOpen * 0.4 - s.ripple * 0.18, 0.08, 1.45)
      * blinkFactor(elapsed, reduced);
    const squint = clamp01((0.7 - openness) / 0.55);
    const gazeY = (a.lookY + e.lookY) * 4;
    const gazeX = a.spinner * 3 + e.brow * 1.5
      + still * a.spinner * Math.sin(elapsed * 0.8) * 0.7;
    // A happy squint arches upward; concern bends the same two shapes down.
    const curvature = squint * (e.smile < -0.2 ? 3 : -5) - e.smile * 0.8;
    eyes.forEach((eye, i) => {
      const cx = (i === 0 ? 41 : 59) + gazeX;
      const cy = 55 - gazeY;
      const halfX = squint * (3.7 + s.mouthWide);
      const halfY = 3 * openness * (1 - squint);
      eye.setAttribute('d', `M ${(cx - halfX).toFixed(3)} ${(cy - halfY).toFixed(3)} Q ${cx.toFixed(3)} ${(cy + curvature).toFixed(3)} ${(cx + halfX).toFixed(3)} ${(cy + halfY).toFixed(3)}`);
      eye.setAttribute('stroke-width', (3.8 - squint * 1.8).toFixed(3));
    });
    for (const cheek of blush) cheek.setAttribute('opacity', String(clamp01(0.48 + e.blush * 0.4 + s.ripple * 0.08)));
  }

  return { svg, render };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Smooth periodic blink; always 1 when motion is reduced. */
function blinkFactor(elapsed: number, reduced: boolean): number {
  if (reduced) return 1;
  const cycle = (elapsed % 5.2) / 5.2;
  if (cycle <= 0.94) return 1;
  const p = (cycle - 0.94) / 0.06;
  return 0.12 + 0.88 * (1 - Math.sin(p * Math.PI));
}

/**
 * Mount the character into `container`.
 */
export function mountAvatar(
  container: HTMLElement,
  source: DotStateSource,
  options: AvatarOptions = {},
): AvatarHandle {
  const size = options.size ?? 160;

  const element = document.createElement('div');
  element.setAttribute('data-doty-avatar', '');
  element.setAttribute('role', 'img');
  element.style.cssText = `position:relative;display:inline-block;width:${size}px;height:${size}px;line-height:0;`;

  const renderer = createRenderer();
  element.appendChild(renderer.svg);

  let reduced = options.reducedMotion ?? prefersReducedMotion();
  let target = deriveVisual({ activity: 'idle', emotion: 'neutral' });
  let current = target;
  let running = false;
  let lastTime = 0;
  let raf = 0;

  const paint = (visual: AvatarVisual, dt: number) => renderer.render(visual, dt, reduced);

  function frame(now: number): void {
    const dt = lastTime > 0 ? Math.min(0.1, (now - lastTime) / 1000) : 0;
    lastTime = now;
    current = stepVisual(current, target, dt, reduced);
    paint(current, dt);
    raf = requestAnimationFrame(frame);
  }

  function start(): void {
    if (running || reduced) return;
    running = true;
    lastTime = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop(): void {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function describe(state: DotState): string {
    const bits: string[] = [state.activity.replace(/_/g, ' '), state.emotion];
    if (state.speech) bits.push('speaking');
    if (state.connection && state.connection !== 'online') bits.push(state.connection);
    return `Doty avatar: ${bits.join(', ')}`;
  }

  function update(state: DotState): void {
    element.setAttribute('data-activity', state.activity);
    element.setAttribute('data-emotion', state.emotion);
    element.setAttribute('data-connection', state.connection ?? 'online');
    element.dataset['label'] = state.label ?? '';
    element.setAttribute('aria-label', describe(state));
    target = deriveVisual(state);
    if (reduced) {
      current = target;
      paint(current, 0);
    }
  }

  const unsubscribe = source.subscribe(update);
  // Paint immediately even with motion enabled (no blank first frame).
  current = target;
  paint(current, 0);
  start();

  // React to the media query at runtime.
  let motionQuery: MediaQueryList | null = null;
  const onMotionChange = () => {
    reduced = options.reducedMotion ?? prefersReducedMotion();
    if (reduced) {
      stop();
      current = target;
      paint(current, 0);
    } else {
      start();
    }
  };
  if (options.reducedMotion === undefined && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    motionQuery.addEventListener?.('change', onMotionChange);
  }

  container.appendChild(element);

  return {
    element,
    setState(state) {
      update(state);
    },
    destroy() {
      unsubscribe();
      stop();
      motionQuery?.removeEventListener?.('change', onMotionChange);
      element.remove();
    },
  };
}

export type { DotState } from '@doty/dot-state';
// Additive layer; the character renderer and mountAvatar contract stay untouched.
export { mountSatellites } from './satellites.js';
export type { HarnessStatusSource, SatellitesHandle, SatellitesOptions } from './satellites.js';
