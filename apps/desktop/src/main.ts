/**
 * Doty desktop webview entry.
 *
 * This is deliberately minimal: it subscribes to the shared `DotState` contract
 * and mirrors it onto a PLACEHOLDER dot element via `data-*` attributes. The
 * real `@doty/avatar` renderer is wired in during Wave 2 and will consume the
 * same store — nothing here is avatar-specific.
 */
import { createDotStore, startFakeDriver } from '@doty/dot-state';

const dot = document.getElementById('dot');
const label = document.getElementById('label');

if (!(dot instanceof HTMLElement)) {
  throw new Error('Doty webview: #dot element is missing from index.html');
}

const store = createDotStore();
// Fake driver so the floating dot is alive with no server/backends present.
const stopDriver = startFakeDriver(store);

store.subscribe((state) => {
  dot.dataset.activity = state.activity;
  dot.dataset.emotion = state.emotion;
  dot.dataset.connection = state.connection ?? 'online';

  if (typeof state.progress === 'number') {
    dot.dataset.progress = state.progress.toFixed(2);
    dot.style.setProperty('--progress', String(state.progress));
  } else {
    delete dot.dataset.progress;
    dot.style.removeProperty('--progress');
  }

  if (label) {
    label.textContent = state.label ?? '';
  }

  dot.setAttribute(
    'aria-label',
    `Doty is ${state.activity}${state.label ? `: ${state.label}` : ''}`,
  );
});

window.addEventListener('beforeunload', () => {
  stopDriver();
});

// Optional: report the state of the Wave 1 OS-integration stubs from the Rust
// side. Guarded so the same bundle also runs in a plain browser (`vite dev`).
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('stub_report'))
    .then((report) => {
      // eslint-disable-next-line no-console
      console.info('[doty] OS-integration stubs:', report);
    })
    .catch((error: unknown) => {
      console.warn('[doty] could not read stub_report:', error);
    });
}
