/** Independent, local-metadata satellite layer. No transcript/event API. */
import type { Harness, HarnessActivity, HarnessStatus } from '@doty/harness-events';

export interface HarnessStatusSource {
  /** Immediately supplies the current visible sessions, then every change. */
  subscribe(listener: (statuses: readonly HarnessStatus[]) => void): () => void;
}

export interface SatellitesOptions {
  /** Square orbit area in CSS pixels. Center the avatar in this area. Default 136. */
  size?: number;
  /** Diameter of each satellite dot, in CSS pixels. Default 17. */
  dotSize?: number;
  reducedMotion?: boolean;
  onSelect?: (status: HarnessStatus) => void;
}

export interface SatellitesHandle {
  readonly element: HTMLElement;
  setStatuses(statuses: readonly HarnessStatus[]): void;
  destroy(): void;
}

const IDENTITY: Record<Harness, { color: string; mark: string }> = {
  codex: { color: '#86e3c3', mark: 'C' },
  opencode: { color: '#aaa0ff', mark: 'O' },
  t3: { color: '#77caff', mark: 'T' },
};
const ACTIVITY: Record<HarnessActivity, { color: string; mark: string; speed: number; pulse: number }> = {
  running: { color: '#e9e5ff', mark: '·', speed: 0.12, pulse: 0.04 },
  thinking: { color: '#c4b5fd', mark: '…', speed: 0.18, pulse: 0.1 },
  tool_calling: { color: '#6ee7f0', mark: '↻', speed: 0.32, pulse: 0.08 },
  waiting_approval: { color: '#ffca68', mark: '?', speed: 0, pulse: 0.12 },
  idle: { color: '#b6bac7', mark: '·', speed: 0.04, pulse: 0 },
  done: { color: '#86efac', mark: '✓', speed: 0.03, pulse: 0 },
  error: { color: '#ff8585', mark: '!', speed: 0, pulse: 0.06 },
  stale: { color: '#858997', mark: '–', speed: 0, pulse: 0 },
};

interface Satellite {
  status: HarnessStatus;
  button: HTMLButtonElement;
  dot: HTMLElement;
  badge: HTMLElement;
  angle: number;
  /** Already scaled out; awaiting removal. */
  removing?: boolean;
}

/**
 * Mount alongside (not inside) mountAvatar. The layer is absolute; its container
 * should be positioned and its avatar centered. Native buttons supply keyboard
 * selection and accessible descriptions even when motion is disabled.
 */
export function mountSatellites(
  container: HTMLElement,
  source: HarnessStatusSource,
  options: SatellitesOptions = {},
): SatellitesHandle {
  const size = Math.max(96, options.size ?? 136);
  const dotSize = Math.max(8, Math.round(options.dotSize ?? 17));
  const buttonSize = dotSize + 7;
  const badgeFont = Math.max(7, Math.round(dotSize * 0.55));
  const element = document.createElement('div');
  element.setAttribute('data-doty-satellites', '');
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Watched harness sessions');
  element.style.cssText = `position:absolute;inset:0;width:${size}px;height:${size}px;pointer-events:none;z-index:2;`;
  const style = document.createElement('style');
  style.textContent = `[data-doty-satellite]:focus-visible{outline:2px solid white!important;outline-offset:2px}
    [data-doty-satellite]:hover{filter:brightness(1.2)}
    [data-doty-satellite]:focus-visible [data-satellite-dot]{box-shadow:0 0 0 2px #fff}
    @keyframes doty-satellite-pop{0%{transform:scale(1);opacity:1}45%{transform:scale(1.45);opacity:1}100%{transform:scale(0);opacity:0}}
    @keyframes doty-satellite-fade{to{opacity:0}}
    [data-doty-satellite][data-popping]{pointer-events:none;animation:doty-satellite-fade 200ms ease-out forwards}
    [data-doty-satellite][data-popping] [data-satellite-dot]{animation:doty-satellite-pop 200ms ease-out forwards}
    [data-doty-satellite][data-popping] [data-satellite-badge]{animation:doty-satellite-fade 200ms ease-out forwards}`;
  element.append(style);
  const satellites = new Map<string, Satellite>();
  const motionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = options.reducedMotion ?? motionQuery?.matches ?? false;
  let destroyed = false;
  let raf = 0;
  let lastTime: number | undefined;
  let elapsed = 0;
  const POP_MS = 200;
  const popTimers = new Set<number>();

  /** Remove a satellite, scaling it out first unless motion is reduced. */
  function popOut(satellite: Satellite): void {
    if (satellite.removing) return;
    satellite.removing = true;
    const button = satellite.button;
    if (reduced || typeof window === 'undefined' || typeof window.setTimeout !== 'function') {
      button.remove();
      return;
    }
    button.setAttribute('data-popping', 'true');
    const timer = window.setTimeout(() => {
      popTimers.delete(timer);
      button.remove();
    }, POP_MS);
    popTimers.add(timer);
  }

  function paint(dt: number): void {
    const count = satellites.size;
    let index = 0;
    // Additional rings for larger teams; no sessions are silently capped.
    const rings = Math.ceil(count / 12);
    const extent = size + Math.max(0, rings - 1) * 48;
    element.style.width = `${extent}px`;
    element.style.height = `${extent}px`;
    for (const satellite of satellites.values()) {
      const ring = Math.floor(index / 12);
      const inRing = Math.min(12, count - ring * 12);
      const base = (index % 12) / inRing * Math.PI * 2 - Math.PI / 2;
      const radius = size / 2 - (buttonSize / 2 + 2) + ring * (buttonSize + 6);
      const activity = ACTIVITY[satellite.status.status];
      const paused = satellite.button.getAttribute('data-paused') === 'true';
      if (!paused) satellite.angle += dt * activity.speed;
      const angle = base + (reduced ? 0 : satellite.angle);
      const pulse = reduced ? 1 : 1 + Math.sin(elapsed * 4) * activity.pulse;
      const x = extent / 2 + Math.cos(angle) * radius;
      const y = extent / 2 + Math.sin(angle) * radius;
      if (!paused || reduced) satellite.button.style.transform = `translate(${(x - buttonSize / 2).toFixed(2)}px,${(y - buttonSize / 2).toFixed(2)}px)`;
      satellite.dot.style.transform = `scale(${pulse.toFixed(3)})`;
      satellite.dot.style.opacity = satellite.status.status === 'stale' ? '0.55' : '1';
      index += 1;
    }
    element.setAttribute('data-orbit-rings', String(rings));
  }

  function frame(now: number): void {
    raf = 0;
    if (destroyed || reduced || satellites.size === 0) return;
    const dt = lastTime === undefined ? 0 : Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    elapsed += dt;
    paint(dt);
    raf = requestAnimationFrame(frame);
  }

  function animate(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastTime = undefined;
    paint(0);
    if (!reduced && !destroyed && satellites.size > 0) raf = requestAnimationFrame(frame);
  }

  function update(statuses: readonly HarnessStatus[]): void {
    if (destroyed) return;
    const keys = new Set<string>();
    for (const status of statuses) {
      const key = JSON.stringify([status.harness, status.sessionId]);
      keys.add(key);
      let satellite = satellites.get(key);
      if (!satellite) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-doty-satellite', '');
        button.style.cssText = `position:absolute;top:0;left:0;width:${buttonSize}px;height:${buttonSize}px;padding:0;border:0;border-radius:50%;background:transparent;display:grid;place-items:center;pointer-events:auto;cursor:pointer;`;
        const dot = document.createElement('span');
        dot.setAttribute('data-satellite-dot', '');
        dot.setAttribute('aria-hidden', 'true');
        dot.style.cssText = `display:grid;place-items:center;width:${dotSize}px;height:${dotSize}px;border:2px solid;border-radius:50%;font:bold ${badgeFont}px/1 system-ui;`;
        const badge = document.createElement('span');
        badge.setAttribute('data-satellite-badge', '');
        badge.setAttribute('aria-hidden', 'true');
        badge.style.cssText = `position:absolute;right:-1px;bottom:-1px;font:bold ${badgeFont}px/1 system-ui;background:#141320;border-radius:4px;padding:1px;`;
        button.append(dot, badge);
        satellite = { status, button, dot, badge, angle: 0 };
        const selected = satellite;
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          options.onSelect?.(selected.status);
        });
        // Pause motion during pointing or keyboard focus to keep a moving target clickable.
        button.addEventListener('pointerenter', () => { button.setAttribute('data-paused', 'true'); });
        button.addEventListener('pointerleave', () => { button.removeAttribute('data-paused'); });
        button.addEventListener('focus', () => { button.setAttribute('data-paused', 'true'); });
        button.addEventListener('blur', () => { button.removeAttribute('data-paused'); });
        satellites.set(key, satellite);
        element.append(button);
      }
      satellite.status = status;
      satellite.button.setAttribute('data-harness', status.harness);
      satellite.button.setAttribute('data-status', status.status);
      const description = `${status.harness} · ${status.project ?? status.sessionId} · ${status.status.replace(/_/g, ' ')}`;
      satellite.button.setAttribute('aria-label', description);
      satellite.button.title = description;
      satellite.dot.style.background = IDENTITY[status.harness].color;
      satellite.dot.style.borderColor = ACTIVITY[status.status].color;
      satellite.dot.style.color = '#171522';
      satellite.dot.textContent = IDENTITY[status.harness].mark;
      satellite.badge.style.color = ACTIVITY[status.status].color;
      satellite.badge.textContent = ACTIVITY[status.status].mark;
    }
    for (const [key, satellite] of satellites) {
      if (!keys.has(key)) { satellites.delete(key); popOut(satellite); }
    }
    animate();
  }

  const onMotionChange = () => {
    reduced = options.reducedMotion ?? motionQuery?.matches ?? false;
    animate();
  };
  if (options.reducedMotion === undefined) motionQuery?.addEventListener('change', onMotionChange);
  const unsubscribe = source.subscribe(update);
  container.append(element);
  return {
    element,
    setStatuses: update,
    destroy() {
      destroyed = true;
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
        for (const timer of popTimers) window.clearTimeout(timer);
      }
      popTimers.clear();
      motionQuery?.removeEventListener('change', onMotionChange);
      satellites.clear();
      element.remove();
    },
  };
}
