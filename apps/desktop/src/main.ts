/**
 * Doty desktop webview entry.
 *
 * The character is `@doty/avatar`, mounted on the shared `DotState` store.
 * While `GET /events` is live, server frames drive that same store. When the
 * server is unreachable the fake driver keeps the dot alive and the composer
 * queues outgoing text until the stream returns.
 */
import { mountAvatar } from '@doty/avatar';
import { createDotStore, startFakeDriver, type Connection, type DotStore } from '@doty/dot-state';
import { postMessage, rememberServerUrl, resolveServerUrl, resolveToken } from './api.js';
import { mountChat } from './chat.js';
import { openEventStream, type StreamStatus } from './sse.js';
import { applyFrame } from './wire.js';
import { mountHarnessTeam } from './harness.js';

const avatarHost = document.getElementById('avatar');
const label = document.getElementById('label');
const connectionEl = document.getElementById('connection');
const app = document.getElementById('app');
const stage = document.getElementById('stage');

if (!(avatarHost instanceof HTMLElement)) {
  throw new Error('Doty webview: #avatar element is missing from index.html');
}

const store = createDotStore();
store.dispatch({ type: 'connection', value: 'reconnecting' });

const avatar = mountAvatar(avatarHost, store, { size: 76 });
const avatarSlot = document.getElementById('avatar-slot');
const harnessTeam = avatarSlot instanceof HTMLElement ? mountHarnessTeam(avatarSlot) : undefined;

let serverUrl = resolveServerUrl();
const token = resolveToken();
let fallback = false;
let stopDriver: (() => void) | undefined;

store.subscribe((state) => {
  if (label) label.textContent = state.label ?? '';
  const connection = state.connection ?? 'online';
  if (app) app.dataset.connection = connection;
  if (connectionEl) {
    connectionEl.textContent = connection;
    connectionEl.dataset.connection = connection;
  }
  // The fake driver's `reset` step clears the client-owned connection field.
  if (fallback && state.connection !== 'offline') {
    store.dispatch({ type: 'connection', value: 'offline' });
  }
});

let stream: ReturnType<typeof openEventStream> | undefined;

const chat = mountChat({
  serverUrl,
  lastSeq: () => stream?.lastSeq() ?? 0,
  send: (text) => postMessage(serverUrl, text, token),
  onServerUrl(next) {
    rememberServerUrl(next);
    if (next === serverUrl) return;
    serverUrl = next;
    stream?.restart();
  },
});

stream = openEventStream({
  url: () => serverUrl,
  token: () => token,
  onUnauthorized: () => chat.showAuthError(),
  onFrame(frame) {
    try {
      applyFrame(store, frame);
      chat.ingest(frame);
    } catch (error) {
      console.warn('[doty] dropped a malformed event:', error);
    }
  },
  onStatus(status) {
    applyConnection(store, status);
  },
  onReset() {
    chat.forgetHistory();
  },
});

function applyConnection(target: DotStore, status: StreamStatus): void {
  const connection: Connection = status;
  chat.setConnection(connection);
  if (status === 'online') {
    disengageFallback();
    target.dispatch({ type: 'connection', value: 'online' });
    void chat.flush();
    return;
  }
  target.dispatch({ type: 'connection', value: connection });
  if (status === 'offline') engageFallback();
}

function engageFallback(): void {
  if (fallback) return;
  fallback = true;
  stopDriver = startFakeDriver(store);
  if (store.get().connection !== 'offline') {
    store.dispatch({ type: 'connection', value: 'offline' });
  }
}

function disengageFallback(): void {
  if (!fallback) return;
  // Clear the flag before `reset`, or the subscriber would force offline again.
  fallback = false;
  stopDriver?.();
  stopDriver = undefined;
  store.dispatch({ type: 'reset' });
}

window.addEventListener('beforeunload', () => {
  stream?.stop();
  stopDriver?.();
  harnessTeam?.destroy();
  avatar.destroy();
});

// Optional: report the state of the OS-integration stubs from the Rust side.
// Guarded so the same bundle also runs in a plain browser (`vite dev`).
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const COLLAPSED = { width: 220, height: 220 };
const PANEL = { width: 360, height: 520 };
const EDGE = 8;
const CHAR_ANCHOR = 72;
let panelOpen = false;
let charScreen: { x: number; y: number } | null = null;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

async function setPanelOpen(open: boolean): Promise<void> {
  if (open === panelOpen) return;
  panelOpen = open;
  app?.classList.toggle('collapsed', !open);

  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    if (open) document.getElementById('composer-input')?.focus();
    return;
  }

  try {
    const api = await import('@tauri-apps/api/window');
    const dpi = await import('@tauri-apps/api/dpi');
    const win = api.getCurrentWindow();
    const scale = await win.scaleFactor();
    const pos = await win.outerPosition();
    const cur = await win.outerSize();
    const monitor = await api.currentMonitor();
    const mon = monitor
      ? { x: monitor.position.x, y: monitor.position.y, w: monitor.size.width, h: monitor.size.height }
      : { x: 0, y: 0, w: 1920 * scale, h: 1080 * scale };

    const cw = COLLAPSED.width * scale;
    const ch = COLLAPSED.height * scale;
    const pw = PANEL.width * scale;
    const ph = PANEL.height * scale;
    const edge = EDGE * scale;
    const anchor = CHAR_ANCHOR * scale;

    if (!open) {
      // Collapse: keep the character where it is on screen.
      const cx = charScreen ? charScreen.x : pos.x + cur.width / 2;
      const cy = charScreen ? charScreen.y : pos.y + cur.height / 2;
      const left = clamp(cx - cw / 2, mon.x + edge, mon.x + mon.w - cw - edge);
      const top = clamp(cy - ch / 2, mon.y + edge, mon.y + mon.h - ch - edge);
      app?.classList.remove('upward');
      await win.setSize(new dpi.PhysicalSize(Math.round(cw), Math.round(ch)));
      await win.setPosition(new dpi.PhysicalPosition(Math.round(left), Math.round(top)));
      charScreen = { x: left + cw / 2, y: top + ch / 2 };
      return;
    }

    // Expand: keep the character fixed and grow the panel into the emptier side.
    const charX = charScreen ? charScreen.x : pos.x + cur.width / 2;
    const charY = charScreen ? charScreen.y : pos.y + cur.height / 2;
    const roomDown = mon.y + mon.h - charY;
    const roomUp = charY - mon.y;
    const goDown = roomDown >= roomUp;
    const avail = (goDown ? roomDown : roomUp) + anchor - edge;
    const height = Math.round(Math.min(ph, Math.max(260 * scale, avail)));

    app?.classList.toggle('upward', !goDown);

    const left = clamp(charX - pw / 2, mon.x + edge, mon.x + mon.w - pw - edge);
    const top = goDown
      ? clamp(charY - anchor, mon.y + edge, mon.y + mon.h - height - edge)
      : clamp(charY + anchor - height, mon.y + edge, mon.y + mon.h - height - edge);

    await win.setSize(new dpi.PhysicalSize(Math.round(pw), height));
    await win.setPosition(new dpi.PhysicalPosition(Math.round(left), Math.round(top)));
    charScreen = { x: left + pw / 2, y: goDown ? top + anchor : top + height - anchor };
    document.getElementById('composer-input')?.focus();
  } catch {
    // Window control unavailable; the panel still toggles via CSS.
  }
}

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

if (IS_TAURI) {
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('stub_report'))
    .then((report) => {
      console.info('[doty] OS-integration stubs:', report);
    })
    .catch((error: unknown) => {
      console.warn('[doty] could not read stub_report:', error);
    });

  // Character: drag to move the window, a plain click toggles the chat panel.
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => {
      stage?.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        const startX = event.clientX;
        const startY = event.clientY;
        let moved = false;
        const cleanup = (): void => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        const onMove = (move: MouseEvent): void => {
          if (moved) return;
          if (Math.hypot(move.clientX - startX, move.clientY - startY) > 5) {
            moved = true;
            cleanup();
            void getCurrentWindow().startDragging();
          }
        };
        const onUp = (): void => {
          const wasClick = !moved;
          cleanup();
          if (wasClick) void setPanelOpen(!panelOpen);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      // The expanded header doubles as a drag handle (its controls excepted).
      document.getElementById('presence')?.addEventListener('mousedown', (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest('input, textarea, select, button, a, summary')) {
          return;
        }
        void getCurrentWindow().startDragging();
      });
    })
    .catch(() => {
      // Tauri window API unavailable.
    });
} else {
  // Plain browser (vite dev): a click toggles the panel.
  stage?.addEventListener('click', () => void setPanelOpen(!panelOpen));
}
