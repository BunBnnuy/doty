/**
 * @doty/avatar — the character.
 *
 * FROZEN INTERFACE (Wave 0). SA-1 implements the rendering behind it; the
 * desktop shell (SA-4) and the satellite-dot layer only ever call this.
 *
 * Framework-agnostic on purpose: the Tauri webview, a demo page, and tests all
 * use the same entry point.
 *
 * Implementation: a single inline SVG orb, updated on `requestAnimationFrame`.
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

/** Unique id prefix per instance so gradients/filters never collide. */
let instanceSeq = 0;

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

interface EyeParts {
  open: SVGGElement;
  sclera: SVGEllipseElement;
  pupil: SVGCircleElement;
  shine: SVGCircleElement;
  arc: SVGPathElement;
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
  const uid = `doty-${instanceSeq++}`;

  const svg = svgElement('svg', { viewBox: '0 0 100 100', width: '100%', height: '100%' });
  svg.style.display = 'block';
  svg.style.overflow = 'visible';

  const defs = svgElement('defs');
  const gradient = svgElement('radialGradient', { id: `${uid}-body`, cx: '35%', cy: '28%', r: '82%' });
  const stopTop = svgElement('stop', { offset: '0%' });
  const stopMid = svgElement('stop', { offset: '58%' });
  const stopBot = svgElement('stop', { offset: '100%' });
  gradient.append(stopTop, stopMid, stopBot);

  const blur = svgElement('filter', { id: `${uid}-blur`, x: '-70%', y: '-70%', width: '240%', height: '240%' });
  blur.append(svgElement('feGaussianBlur', { stdDeviation: '4' }));
  defs.append(gradient, blur);

  const scene = svgElement('g');

  const glow = svgElement('circle', { cx: 50, cy: 50, r: 34, filter: `url(#${uid}-blur)` });
  const aura = svgElement('circle', { cx: 50, cy: 50, r: 36, fill: 'none', 'stroke-width': 2 });
  const orb = svgElement('circle', {
    cx: 50,
    cy: 50,
    r: 30,
    fill: `url(#${uid}-body)`,
    stroke: 'rgba(255,255,255,0.28)',
    'stroke-width': 1,
  });
  const highlight = svgElement('ellipse', { cx: 40, cy: 35, rx: 10, ry: 7, fill: 'rgba(255,255,255,0.32)' });

  // Rings
  const spinner = svgElement('circle', {
    cx: 50,
    cy: 50,
    r: 37,
    fill: 'none',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-dasharray': '7 15',
    opacity: 0,
  });
  const progress = svgElement('circle', {
    cx: 50,
    cy: 50,
    r: 37,
    fill: 'none',
    'stroke-width': 2.5,
    'stroke-linecap': 'round',
    opacity: 0,
    transform: 'rotate(-90 50 50)',
  });

  // Orbiting satellite dots
  const orbit = svgElement('g', { opacity: 0 });
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2;
    orbit.append(
      svgElement('circle', {
        cx: (50 + Math.cos(angle) * 43).toFixed(2),
        cy: (50 + Math.sin(angle) * 43).toFixed(2),
        r: 1.6,
      }),
    );
  }

  // Speech ripples (two offset rings)
  const ripples = [0, 1].map(() =>
    svgElement('circle', { cx: 50, cy: 50, r: 32, fill: 'none', 'stroke-width': 1.5, opacity: 0 }),
  );

  // Face
  const face = svgElement('g');

  const makeEye = (cx: number): EyeParts => {
    const open = svgElement('g');
    const sclera = svgElement('ellipse', { cx, cy: 44, rx: 5, ry: 5.4, fill: '#ffffff' });
    const pupil = svgElement('circle', { cx, cy: 44, r: 2.5 });
    const shine = svgElement('circle', { cx: cx - 1.3, cy: 42.4, r: 0.9, fill: '#ffffff' });
    open.append(sclera, pupil, shine);
    const arc = svgElement('path', { fill: 'none', 'stroke-width': 1.8, 'stroke-linecap': 'round', d: '' });
    face.append(open, arc);
    return { open, sclera, pupil, shine, arc };
  };

  const leftEye = makeEye(40);
  const rightEye = makeEye(60);

  const leftBrow = svgElement('path', { fill: 'none', 'stroke-width': 1.4, 'stroke-linecap': 'round' });
  const rightBrow = svgElement('path', { fill: 'none', 'stroke-width': 1.4, 'stroke-linecap': 'round' });
  const mouth = svgElement('path', { 'stroke-width': 0.6, 'stroke-linejoin': 'round' });
  const blushLeft = svgElement('ellipse', { cx: 35, cy: 51, rx: 4, ry: 2.4, fill: 'hsl(350 90% 68%)', opacity: 0 });
  const blushRight = svgElement('ellipse', { cx: 65, cy: 51, rx: 4, ry: 2.4, fill: 'hsl(350 90% 68%)', opacity: 0 });
  face.append(leftBrow, rightBrow, mouth, blushLeft, blushRight);

  scene.append(glow, aura, orb, highlight, spinner, progress, orbit, ...ripples, face);
  svg.append(defs, scene);

  const progressCircumference = 2 * Math.PI * 37;
  progress.setAttribute('stroke-dasharray', `${progressCircumference} ${progressCircumference}`);

  // Monotonic animation clock + phase accumulators. These are never reset on
  // state change, so transitions never "restart".
  let elapsed = 0;
  let bobPhase = 0;
  let pulsePhase = 0;
  let spin = 0;

  function render(v: AvatarVisual, dt: number, reduced: boolean): void {
    const a = v.activity;
    const e = v.emotion;
    const s = v.speech;
    const c = v.connection;

    if (!reduced && dt > 0) {
      elapsed += dt;
      bobPhase += dt / Math.max(0.25, a.bobPeriod);
      pulsePhase += dt * a.pulseHz;
      spin += dt;
    }
    const still = reduced ? 0 : 1;

    const hue = a.hue + e.hueShift;
    const saturation = clamp01(a.saturation * e.saturationMul);
    const lightness = clamp01(a.lightness);
    const glowColor = hsl(hue, saturation, lightness);

    // Body gradient
    stopTop.setAttribute('stop-color', hsl(hue, saturation, Math.min(1, lightness + 0.22)));
    stopMid.setAttribute('stop-color', hsl(hue, saturation, lightness));
    stopBot.setAttribute('stop-color', hsl(hue, saturation, Math.max(0, lightness - 0.22)));

    // Connection degradation: desaturate + dim the whole scene.
    const desat = clamp01(c.desaturate);
    scene.style.filter = desat > 0 ? `saturate(${clamp01(1 - desat * 0.9)})` : '';
    const flicker = c.glitch > 0 && !reduced ? 0.88 + 0.12 * Math.abs(Math.sin(elapsed * 40)) : 1;
    svg.style.opacity = String(clamp01(c.opacity * flicker));

    // Breathing glow
    const pulse = Math.sin(pulsePhase * Math.PI * 2);
    glow.setAttribute('fill', glowColor);
    glow.setAttribute('opacity', String(clamp01(a.glow) * (1 - desat * 0.5)));
    glow.setAttribute('r', String(33 + still * (pulse * 1.6 + a.glow * 3)));

    aura.setAttribute('stroke', glowColor);
    aura.setAttribute('opacity', String(clamp01(a.aura) * (1 - desat * 0.5)));
    aura.setAttribute('stroke-width', String(1.2 + a.aura * 1.6));
    aura.setAttribute('r', String(36 + still * (pulse * 2.6 + a.aura * 2)));

    // Body transform: scale + stretch + bob + shake
    const bobY = still * Math.sin(bobPhase * Math.PI * 2) * a.bob * 100;
    const shakeX = still * Math.sin(elapsed * 47) * a.shake * 100;
    const sx = a.scale * a.stretchX;
    const sy = a.scale * a.stretchY;
    scene.setAttribute('transform', `translate(${(50 + shakeX).toFixed(3)} ${(50 + bobY).toFixed(3)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(-50 -50)`);

    // Progress + spinner rings
    spinner.setAttribute('opacity', String(clamp01(a.spinner)));
    spinner.setAttribute('stroke', hsl(hue, saturation, Math.min(1, lightness + 0.18)));
    spinner.setAttribute('transform', `rotate(${(still * spin * 120).toFixed(2)} 50 50)`);

    const progressValue = a.progress ?? 0;
    progress.setAttribute('opacity', String(clamp01(a.progressRing)));
    progress.setAttribute('stroke', glowColor);
    progress.setAttribute('stroke-dashoffset', String(progressCircumference * (1 - clamp01(progressValue))));

    // Orbit dots
    orbit.setAttribute('opacity', String(clamp01(a.orbit)));
    orbit.setAttribute('fill', hsl(hue, saturation, Math.min(1, lightness + 0.25)));
    orbit.setAttribute('transform', `rotate(${(still * -spin * 90).toFixed(2)} 50 50)`);

    // Ripples follow speech only.
    const pulseWave = still && s.ripple > 0 ? elapsed * 1.7 : 0;
    ripples.forEach((ring, i) => {
      const phase = ((pulseWave + i * 0.5) % 1 + 1) % 1;
      ring.setAttribute('r', String(32 + phase * 16));
      ring.setAttribute('stroke', glowColor);
      ring.setAttribute('opacity', String(clamp01(s.ripple) * (1 - phase) * 0.7));
    });

    // Face
    const faceColor = hsl(hue, Math.min(saturation, 0.5), 0.14);
    const openness = Math.max(0, Math.min(1.4, a.eyeOpen + e.eyeOpen)) * blinkFactor(elapsed, reduced);
    const gaze = a.lookY + e.lookY;
    const eyeR = 5.4 * Math.max(0.05, openness);
    const arcDirection = e.smile >= 0 ? 1 : -1;

    const renderEye = (parts: EyeParts, cx: number) => {
      const cy = 44 - clamp(gaze, -1, 1) * 3;
      parts.sclera.setAttribute('cy', cy.toFixed(3));
      parts.sclera.setAttribute('ry', eyeR.toFixed(3));
      parts.pupil.setAttribute('cy', (cy - clamp(gaze, -1, 1) * 0.6).toFixed(3));
      parts.pupil.setAttribute('r', (2.5 * Math.min(1, openness)).toFixed(3));
      parts.pupil.setAttribute('fill', faceColor);
      parts.shine.setAttribute('cy', (cy - 1.6).toFixed(3));
      parts.open.setAttribute('opacity', String(clamp01((openness - 0.2) / 0.5)));

      parts.arc.setAttribute('d', `M ${cx - 5} ${cy.toFixed(3)} Q ${cx} ${(cy - arcDirection * 3.4).toFixed(3)} ${cx + 5} ${cy.toFixed(3)}`);
      parts.arc.setAttribute('stroke', faceColor);
      parts.arc.setAttribute('opacity', String(1 - clamp01((openness - 0.2) / 0.5)));
    };

    renderEye(leftEye, 40);
    renderEye(rightEye, 60);

    // Brows
    const browTilt = e.brow;
    const browY = 36 - clamp(gaze, -1, 1) * 1.2;
    const leftBrowPath = `M 35.5 ${(browY + browTilt * 0.8).toFixed(2)} Q 40 ${(browY - browTilt * 2.4).toFixed(2)} 44.5 ${(browY - browTilt * 1.8).toFixed(2)}`;
    const rightBrowPath = `M 55.5 ${(browY - browTilt * 1.8).toFixed(2)} Q 60 ${(browY - browTilt * 2.4).toFixed(2)} 64.5 ${(browY + browTilt * 0.8).toFixed(2)}`;
    leftBrow.setAttribute('d', leftBrowPath);
    rightBrow.setAttribute('d', rightBrowPath);
    leftBrow.setAttribute('stroke', faceColor);
    rightBrow.setAttribute('stroke', faceColor);

    // Mouth: two quadratics sharing endpoints; smile bends the top up, open
    // pushes the bottom down.
    const mouthOpen = clamp01(s.mouthOpen);
    const mouthWide = clamp01(s.mouthWide);
    const curve = e.smile * 2.6;
    const halfWidth = 3.5 + mouthWide * 4.5;
    const top = 53 - curve - mouthOpen * 0.8;
    const bottom = 53 + 1.4 + curve + mouthOpen * 5.5;
    mouth.setAttribute(
      'd',
      `M ${(50 - halfWidth).toFixed(2)} 53 Q 50 ${top.toFixed(2)} ${(50 + halfWidth).toFixed(2)} 53 Q 50 ${bottom.toFixed(2)} ${(50 - halfWidth).toFixed(2)} 53 Z`,
    );
    mouth.setAttribute('fill', faceColor);
    mouth.setAttribute('stroke', faceColor);

    blushLeft.setAttribute('opacity', String(clamp01(e.blush) * 0.6));
    blushRight.setAttribute('opacity', String(clamp01(e.blush) * 0.6));
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
