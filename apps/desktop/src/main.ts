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

if (!(avatarHost instanceof HTMLElement)) {
  throw new Error('Doty webview: #avatar element is missing from index.html');
}

const store = createDotStore();
store.dispatch({ type: 'connection', value: 'reconnecting' });

const avatar = mountAvatar(avatarHost, store, { size: 76 });
avatar.element.setAttribute('data-tauri-drag-region', '');
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

if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('stub_report'))
    .then((report) => {
      console.info('[doty] OS-integration stubs:', report);
    })
    .catch((error: unknown) => {
      console.warn('[doty] could not read stub_report:', error);
    });
}
