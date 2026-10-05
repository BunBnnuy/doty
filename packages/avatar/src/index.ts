/**
 * @doty/avatar — the character.
 *
 * FROZEN INTERFACE (Wave 0). SA-1 implements the rendering behind it; the
 * desktop shell (SA-4) and the satellite-dot layer only ever call this.
 *
 * Framework-agnostic on purpose: the Tauri webview, a demo page, and tests all
 * use the same entry point.
 */

import type { DotState } from '@doty/dot-state';

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

/**
 * Mount the character into `container`.
 *
 * Wave 0 ships a minimal placeholder so the shell and demo can render before
 * SA-1 lands the real morphing character.
 */
export function mountAvatar(
  container: HTMLElement,
  source: DotStateSource,
  options: AvatarOptions = {},
): AvatarHandle {
  const size = options.size ?? 160;
  const el = document.createElement('div');
  el.setAttribute('data-doty-avatar', '');
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle at 35% 30%, #a855f7, #6d28d9);transition:opacity .3s ease;opacity:.9;`;

  const unsubscribe = source.subscribe((state) => {
    el.setAttribute('data-activity', state.activity);
    el.setAttribute('data-emotion', state.emotion);
    el.setAttribute('data-connection', state.connection ?? 'online');
    el.dataset['label'] = state.label ?? '';
    el.style.opacity = state.activity === 'idle' ? '0.75' : '1';
  });

  container.appendChild(el);

  return {
    element: el,
    setState(state) {
      el.setAttribute('data-activity', state.activity);
      el.setAttribute('data-emotion', state.emotion);
    },
    destroy() {
      unsubscribe();
      el.remove();
    },
  };
}

export type { DotState } from '@doty/dot-state';
