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

function hsl(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360;
  return `hsl(${h.toFixed(1)} ${(clamp01(saturation) * 100).toFixed(1)}% ${(clamp01(lightness) * 100).toFixed(1)}%)`;
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

  const backdrop = svgElement('rect', { width: 100, height: 100, fill: '#222329' });
  const scene = svgElement('g', { 'data-part': 'head' });
  // Broad, uninterrupted color planes; no outlines, lighting or ornament rings.
  const hairBack = svgElement('path', {
    'data-part': 'hair-back',
    d: 'M 8 48 C 8 16 20 7 49 7 C 78 7 92 17 92 48 L 92 72 Q 91 94 69 94 L 30 94 Q 8 94 8 73 Z',
  });
  const skin = svgElement('path', {
    fill: '#fae4e2', 'data-part': 'face',
    d: 'M 20 42 Q 21 22 49 22 Q 79 22 81 44 L 80 65 C 79 83 66 92 50 92 C 32 92 20 81 19 65 Z',
  });
  const blush = [31, 70].map((cx) => svgElement('ellipse', {
    'data-part': 'blush', cx, cy: 70, rx: 7, ry: 4, fill: '#eab4c2',
  }));
  // Each eye is ONE round-capped solid black shape, including during a squint.
  const eyes = [38, 62].map(() => svgElement('path', {
    'data-part': 'eye', fill: 'none', stroke: '#000000', 'stroke-linecap': 'round',
  }));
  const hairUnder = svgElement('path', {
    'data-part': 'hair-lavender',
    d: 'M 49 8 C 33 7 27 21 25 33 Q 41 32 62 25 C 63 44 69 69 85 70 Q 91 70 94 63 C 84 67 76 52 73 32 Q 72 11 49 8 Z M 9 60 Q 13 78 25 88 L 30 94 Q 10 94 8 74 Z',
  });
  const hairPink = svgElement('path', {
    'data-part': 'hair-pink',
    d: 'M 49 7 C 27 6 12 16 9 35 C 5 52 10 65 23 70 Q 28 72 26 68 C 19 55 20 37 27 27 C 31 17 38 11 49 7 Z M 62 8 C 87 8 92 26 92 46 L 92 69 Q 92 91 69 94 L 69 88 C 84 80 85 65 83 56 C 71 53 67 32 62 8 Z',
  });
  const star = svgElement('path', {
    'data-part': 'star-clip', fill: '#ddd0ec',
    d: 'M 26 25 Q 27 24 28 26 L 31 31 L 37 32 Q 39 32 37 34 L 33 38 L 34 44 Q 34 46 32 45 L 26 42 L 21 45 Q 19 46 20 43 L 20 37 L 16 33 Q 15 31 18 31 L 23 30 Z',
  });
  scene.append(hairBack, skin, ...blush, ...eyes, hairUnder, hairPink, star);
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

    const hueShift = (a.hue - 340) * 0.12 + e.hueShift * 0.15;
    hairBack.setAttribute('fill', hsl(340 + hueShift, 0.52 * e.saturationMul, 0.81));
    hairPink.setAttribute('fill', hsl(340 + hueShift, 0.52 * e.saturationMul, 0.81));
    hairUnder.setAttribute('fill', hsl(305 + hueShift, 0.25 * e.saturationMul, 0.69));

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

    // Legacy speech field names are preserved for type compatibility, but drive
    // eye squint/width only. There is deliberately no mouth or nose in this SVG.
    const openness = clamp(a.eyeOpen + e.eyeOpen - s.mouthOpen * 0.4 - s.ripple * 0.18, 0.08, 1.45)
      * blinkFactor(elapsed, reduced);
    const squint = clamp01((0.7 - openness) / 0.55);
    const gazeY = (a.lookY + e.lookY) * 4;
    const gazeX = a.spinner * 3 + e.brow * 1.5
      + still * a.spinner * Math.sin(elapsed * 0.8) * 0.7;
    const curvature = squint * (e.smile < -0.2 ? 3 : -5) - e.smile * 0.8;
    eyes.forEach((eye, i) => {
      const cx = (i === 0 ? 38 : 62) + gazeX;
      const cy = 58 - gazeY;
      const halfX = squint * (5 + s.mouthWide);
      const halfY = 5.5 * openness * (1 - squint);
      eye.setAttribute('d', `M ${(cx - halfX).toFixed(3)} ${(cy - halfY).toFixed(3)} Q ${cx.toFixed(3)} ${(cy + curvature).toFixed(3)} ${(cx + halfX).toFixed(3)} ${(cy + halfY).toFixed(3)}`);
      eye.setAttribute('stroke-width', (7 - squint * 3.2).toFixed(3));
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
