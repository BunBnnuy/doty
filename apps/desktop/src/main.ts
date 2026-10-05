/**
 * Doty desktop webview entry.
 *
 * The character is `@doty/avatar`, mounted on the shared `DotState` store.
 * While `GET /events` is live, server frames drive that same store. When the
 * server is unreachable the fake driver keeps the dot alive and the composer
 * queues outgoing text until the stream returns.
 *
 * The local harness watcher feeds the satellites AND, when a session finishes
 * or needs the user, a speech bubble plus an avatar reaction.
 */
import { mountAvatar } from '@doty/avatar';
import { createDotStore, startFakeDriver, type Connection, type DotStore } from '@doty/dot-state';
import { postMessage, resolveToken } from './api.js';
import { mountChat } from './chat.js';
import { openEventStream, type StreamStatus } from './sse.js';
import { applyFrame } from './wire.js';
import { mountHarnessTeam, type HarnessNotice, type HarnessTeamOptions } from './harness.js';
import {
  DOTY_RANGE,
  ORBITAL_RANGE,
  ORBIT_RANGE,
  loadSettings,
  normalizeSettings,
  saveSettings,
  type DotySettings,
} from './settings.js';

const avatarHost = document.getElementById('avatar');
const avatarSlot = document.getElementById('avatar-slot');
const label = document.getElementById('label');
const connectionEl = document.getElementById('connection');
const app = document.getElementById('app');
const stage = document.getElementById('stage');
const speech = document.getElementById('speech');

if (!(avatarHost instanceof HTMLElement) || !(avatarSlot instanceof HTMLElement)) {
  throw new Error('Doty webview: #avatar / #avatar-slot missing from index.html');
}
const avatarMount: HTMLElement = avatarHost;
const slotMount: HTMLElement = avatarSlot;

let settings: DotySettings = loadSettings();

const store = createDotStore();
store.dispatch({ type: 'connection', value: 'reconnecting' });

const harnessOptions = (): HarnessTeamOptions => ({
  orbitSize: settings.orbitSize,
  dotSize: settings.orbitalSize,
  onNotice: handleNotice,
});

let avatar = mountAvatar(avatarMount, store, { size: settings.dotySize });
let harnessTeam = mountHarnessTeam(slotMount, harnessOptions());

const token = resolveToken();
let serverUrl = settings.serverUrl;
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
  if (fallback && state.connection !== 'offline') {
    store.dispatch({ type: 'connection', value: 'offline' });
  }
});

let stream: ReturnType<typeof openEventStream> | undefined;

const chat = mountChat({
  serverUrl,
  lastSeq: () => stream?.lastSeq() ?? 0,
  send: (text) => postMessage(serverUrl, text, token),
  onServerUrl() {
    // Server changes go through the settings view.
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
  fallback = false;
  stopDriver?.();
  stopDriver = undefined;
  store.dispatch({ type: 'reset' });
}

// ---------------------------------------------------------------------------
// Session notices: speech bubble + avatar reaction
// ---------------------------------------------------------------------------

const REACTION: Record<HarnessNotice['kind'], { activity: 'done' | 'error' | 'waiting_approval'; emotion: 'happy' | 'concerned' | 'curious'; label: string }> = {
  done: { activity: 'done', emotion: 'happy', label: 'finished' },
  error: { activity: 'error', emotion: 'concerned', label: 'hit an error' },
  attention: { activity: 'waiting_approval', emotion: 'curious', label: 'needs you' },
};

function handleNotice(notice: HarnessNotice): void {
  const reaction = REACTION[notice.kind];
  store.dispatch({ type: 'activity', value: reaction.activity, label: `${notice.harness} ${reaction.label}` });
  store.dispatch({ type: 'emotion', value: reaction.emotion });
  showSpeech(notice);
}

let speechTimer = 0;
function showSpeech(notice: HarnessNotice): void {
  if (!(speech instanceof HTMLElement)) return;
  speech.dataset.kind = notice.kind;
  speech.textContent = notice.summary;
  speech.hidden = false;
  window.clearTimeout(speechTimer);
  speechTimer = window.setTimeout(() => {
    if (speech instanceof HTMLElement) speech.hidden = true;
  }, 12_000);
}

speech?.addEventListener('click', () => {
  if (speech instanceof HTMLElement) speech.hidden = true;
  void setPanelOpen(true);
});

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

const settingsToggle = document.getElementById('settings-toggle');
const settingsClose = document.getElementById('settings-close');
const settingsPanel = document.getElementById('settings');
const chatPanel = document.getElementById('panel');
const serverField = document.getElementById('setting-server');
const orbitField = document.getElementById('setting-orbit');
const orbitalField = document.getElementById('setting-orbital');
const dotyField = document.getElementById('setting-doty');
const orbitValue = document.getElementById('setting-orbit-value');
const orbitalValue = document.getElementById('setting-orbital-value');
const dotyValue = document.getElementById('setting-doty-value');

function showSettings(show: boolean): void {
  if (settingsPanel instanceof HTMLElement) settingsPanel.hidden = !show;
  if (chatPanel instanceof HTMLElement) chatPanel.hidden = show;
  if (show) void setPanelOpen(true);
}

function applySettings(next: DotySettings): void {
  const previous = settings;
  settings = normalizeSettings(next);
  saveSettings(settings);

  if (settings.dotySize !== previous.dotySize) {
    avatar.destroy();
    avatar = mountAvatar(avatarMount, store, { size: settings.dotySize });
  }
  if (settings.orbitSize !== previous.orbitSize || settings.orbitalSize !== previous.orbitalSize) {
    harnessTeam.destroy();
    harnessTeam = mountHarnessTeam(slotMount, harnessOptions());
    if (!panelOpen && settings.orbitSize !== previous.orbitSize) void applyCollapsedSize();
  }
  if (settings.serverUrl !== previous.serverUrl) {
    serverUrl = settings.serverUrl;
    stream?.restart();
  }
}

function syncSettingFields(): void {
  if (serverField instanceof HTMLInputElement) serverField.value = settings.serverUrl;
  if (orbitField instanceof HTMLInputElement) {
    orbitField.min = String(ORBIT_RANGE.min);
    orbitField.max = String(ORBIT_RANGE.max);
    orbitField.value = String(settings.orbitSize);
  }
  if (dotyField instanceof HTMLInputElement) {
    dotyField.min = String(DOTY_RANGE.min);
    dotyField.max = String(DOTY_RANGE.max);
    dotyField.value = String(settings.dotySize);
  }
  if (orbitalField instanceof HTMLInputElement) {
    orbitalField.min = String(ORBITAL_RANGE.min);
    orbitalField.max = String(ORBITAL_RANGE.max);
    orbitalField.value = String(settings.orbitalSize);
  }
  if (orbitValue) orbitValue.textContent = String(settings.orbitSize);
  if (orbitalValue) orbitalValue.textContent = String(settings.orbitalSize);
  if (dotyValue) dotyValue.textContent = String(settings.dotySize);
}
syncSettingFields();

settingsToggle?.addEventListener('click', () => {
  const hidden = settingsPanel instanceof HTMLElement ? settingsPanel.hidden : true;
  showSettings(Boolean(hidden));
});
settingsClose?.addEventListener('click', () => showSettings(false));

serverField?.addEventListener('change', () => {
  if (serverField instanceof HTMLInputElement) applySettings({ ...settings, serverUrl: serverField.value });
});
orbitField?.addEventListener('input', () => {
  if (orbitField instanceof HTMLInputElement && orbitValue) orbitValue.textContent = orbitField.value;
});
orbitField?.addEventListener('change', () => {
  if (orbitField instanceof HTMLInputElement) applySettings({ ...settings, orbitSize: Number(orbitField.value) });
});
orbitalField?.addEventListener('input', () => {
  if (orbitalField instanceof HTMLInputElement && orbitalValue) orbitalValue.textContent = orbitalField.value;
});
orbitalField?.addEventListener('change', () => {
  if (orbitalField instanceof HTMLInputElement) applySettings({ ...settings, orbitalSize: Number(orbitalField.value) });
});
dotyField?.addEventListener('input', () => {
  if (dotyField instanceof HTMLInputElement && dotyValue) dotyValue.textContent = dotyField.value;
});
dotyField?.addEventListener('change', () => {
  if (dotyField instanceof HTMLInputElement) applySettings({ ...settings, dotySize: Number(dotyField.value) });
});

// ---------------------------------------------------------------------------
// Window: collapse/expand + dragging
// ---------------------------------------------------------------------------

const PANEL = { width: 380, height: 560 };
const EDGE = 8;
const CHAR_ANCHOR = 72;
let panelOpen = false;
let charScreen: { x: number; y: number } | null = null;

/** The collapsed window must fit the orbit area, whatever the slider says. */
function collapsedDims(): { width: number; height: number } {
  const side = Math.max(220, Math.round(settings.orbitSize) + 44);
  return { width: side, height: side };
}

async function applyCollapsedSize(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    const api = await import('@tauri-apps/api/window');
    const dpi = await import('@tauri-apps/api/dpi');
    const scale = await api.getCurrentWindow().scaleFactor();
    const dims = collapsedDims();
    await api.getCurrentWindow().setSize(
      new dpi.PhysicalSize(Math.round(dims.width * scale), Math.round(dims.height * scale)),
    );
  } catch {
    // Window control unavailable.
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

async function setPanelOpen(open: boolean): Promise<void> {
  if (open === panelOpen) return;
  panelOpen = open;
  app?.classList.toggle('collapsed', !open);
  if (!open) showSettings(false);

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

    const cw = collapsedDims().width * scale;
    const ch = collapsedDims().height * scale;
    const pw = PANEL.width * scale;
    const ph = PANEL.height * scale;
    const edge = EDGE * scale;
    const anchor = CHAR_ANCHOR * scale;

    if (!open) {
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

    const charX = charScreen ? charScreen.x : pos.x + cur.width / 2;
    const charY = charScreen ? charScreen.y : pos.y + cur.height / 2;
    const roomDown = mon.y + mon.h - charY;
    const roomUp = charY - mon.y;
    const goDown = roomDown >= roomUp;
    const avail = (goDown ? roomDown : roomUp) + anchor - edge;
    const height = Math.round(Math.min(ph, Math.max(280 * scale, avail)));

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
if (IS_TAURI) void applyCollapsedSize();

if (IS_TAURI) {
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('stub_report'))
    .then((report) => {
      console.info('[doty] OS-integration stubs:', report);
    })
    .catch((error: unknown) => {
      console.warn('[doty] could not read stub_report:', error);
    });

  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => {
      stage?.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (target instanceof Element && target.closest('#speech, input, textarea, select, button, a, summary')) {
          return;
        }
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
  stage?.addEventListener('click', () => void setPanelOpen(!panelOpen));
}

window.addEventListener('beforeunload', () => {
  stream?.stop();
  stopDriver?.();
  harnessTeam.destroy();
  avatar.destroy();
});
