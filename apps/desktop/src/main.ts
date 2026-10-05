/**
 * Doty desktop webview entry.
 *
 * The character is `@doty/avatar`, mounted on the shared `DotState` store.
 * While `GET /events` is live, server frames drive that same store. When the
 * server is unreachable the fake driver keeps the dot alive and the composer
 * queues outgoing text until the stream returns.
 *
 * The local harness watcher feeds the satellites AND, when a session finishes
 * or needs the user, a speech bubble plus an avatar reaction. Pending T3
 * questions are pinned at the end of the chat.
 */
import { mountAvatar } from '@doty/avatar';
import { createDotStore, startFakeDriver, type Connection, type DotStore } from '@doty/dot-state';
import { forgetToken, postMessage, rememberToken, resolveToken } from './api.js';
import { mountChat, type ChatMessage } from './chat.js';
import { openEventStream, type StreamStatus } from './sse.js';
import { applyFrame } from './wire.js';
import { mountHarnessTeam, type HarnessNotice, type HarnessResponse, type HarnessTeamOptions } from './harness.js';
import { subscribeQuestions } from './questions.js';
import {
  AUTO_CLOSE_RANGE,
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
const speechText = document.getElementById('speech-text');

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
  dotySize: settings.dotySize,
  onNotice: handleNotice,
  onResponse: handleResponse,
  onOrbitalSelect: () => {
    if (app?.classList.contains('collapsed')) void setPanelOpen(true);
  },
});

let avatar = mountAvatar(avatarMount, store, { size: settings.dotySize });

let token = resolveToken();
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

// Highest server seq that belongs to replay, captured from the `hello` cursor.
// Frames at or below it are history: they fill the chat but must not bubble.
let replayCursor = 0;

const chat = mountChat({
  serverUrl,
  lastSeq: () => stream?.lastSeq() ?? 0,
  send: (text) => postMessage(serverUrl, text, token),
  onServerUrl() {
    // Server changes go through the settings view.
  },
  onMessage: handleChatMessage,
});

// Mount the harness team after the chat so local agent responses can be
// appended to it as they arrive.
let harnessTeam = mountHarnessTeam(slotMount, harnessOptions());

// Pending T3 questions: pinned at the end of the chat, with a heads-up bubble.
const unsubscribeQuestions = subscribeQuestions((list) => {
  chat.setPendingQuestions(list);
  if (list.length === 0) return;
  const label = list.length === 1
    ? '1 hilo esperando respuesta'
    : `${list.length} hilos esperando respuesta`;
  store.dispatch({ type: 'activity', value: 'waiting_approval', label });
  store.dispatch({ type: 'emotion', value: 'curious' });
  showSpeechText('attention', `${label} en T3. Mira el chat de Doty para copiar tu respuesta.`);
});

stream = openEventStream({
  url: () => serverUrl,
  token: () => token,
  onUnauthorized: () => chat.showAuthError(),
  onFrame(frame) {
    if (frame.type === 'hello') {
      const cursor = readHelloCursor(frame.data);
      if (cursor !== undefined) replayCursor = cursor;
    }
    try {
      applyFrame(store, frame);
      const live = frame.seq === undefined || frame.seq > replayCursor;
      chat.ingest(frame, live);
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

/** The `hello` frame's `cursor`: highest seq at connect time (replay boundary). */
function readHelloCursor(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const cursor = (data as Record<string, unknown>).cursor;
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
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
  if (notice.kind !== 'done' || settings.showTaskFinishedBubble) showSpeech(notice);
}

/**
 * A watched thread produced an agent response — a final reply or a reasoning
 * block. Show it in Doty's chat, labelled with where it came from. The text is
 * local-only and is never POSTed to the server.
 */
function handleResponse(response: HarnessResponse): void {
  const note = response.project ? `${response.harness} · ${response.project}` : response.harness;
  chat.addHarnessResponse({
    key: `${response.harness}:${response.sessionId}:${response.ts}:${response.kind}`,
    text: response.text,
    note,
    kind: response.kind,
  });
}

/**
 * Mirror a live chat row as a dialogue bubble on the character, so messages are
 * visible even while the chat panel is closed. Replayed history never reaches
 * here (see `replayCursor` in the stream handler).
 */
function handleChatMessage(message: ChatMessage): void {
  const body = bubblePreview(message.text);
  if (!body) return;
  const kind = message.variant === 'reasoning'
    ? 'thinking'
    : message.role === 'user'
      ? 'user'
      : message.role === 'assistant' && message.tone !== 'error'
        ? 'reply'
        : 'error';
  showSpeechText(kind, `${speakerFor(message)}: ${body}`, 6_000);
}

function speakerFor(message: ChatMessage): string {
  if (message.role === 'user') return 'Tú';
  if (message.role === 'assistant') return message.note ?? 'Doty';
  return 'Aviso';
}

/** Flatten markdown into a short single-line preview for the speech bubble. */
function bubblePreview(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '• ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 500 ? `${flat.slice(0, 499)}…` : flat;
}

let speechTimer = 0;
let speechOpen = false;
let speechFitToken = 0;
const SPEECH_EDGE = 10;
/** Gap between the bubble's tail and the orbit area. */
const SPEECH_GAP = 10;
/** Top margin of the bubble inside the expanded window. */
const SPEECH_TOP = 4;

function showSpeech(notice: HarnessNotice): void {
  showSpeechText(notice.kind, notice.summary);
}

function showSpeechText(kind: string, text: string, durationMs = 12_000): void {
  if (!(speech instanceof HTMLElement)) return;
  speech.dataset.kind = kind;
  if (speechText instanceof HTMLElement) speechText.textContent = text;
  speech.hidden = false;
  speechOpen = true;
  void fitSpeechWindow(true);
  window.clearTimeout(speechTimer);
  speechTimer = window.setTimeout(() => hideSpeech(), durationMs);
}

/** Hide the bubble, shrinking the window back to the collapsed size. */
function hideSpeech(resize = true): void {
  window.clearTimeout(speechTimer);
  if (speech instanceof HTMLElement) speech.hidden = true;
  speechOpen = false;
  if (resize) void fitSpeechWindow(false);
}

/**
 * Grow (or shrink) the collapsed window so the whole bubble fits, keeping the
 * character at the same screen position. A vertical-only growth would cover the
 * character, so while a bubble is shown the character is anchored to the bottom
 * and the window extends upward.
 */
async function fitSpeechWindow(show: boolean): Promise<void> {
  if (!(speech instanceof HTMLElement)) return;
  // The panel owns the window geometry; just drop the collapsed layout flag.
  if (!IS_TAURI || panelOpen) {
    if (!show) app?.classList.remove('speech-open');
    return;
  }
  const token = ++speechFitToken;
  try {
    const [api, dpi] = await Promise.all([
      import('@tauri-apps/api/window'),
      import('@tauri-apps/api/dpi'),
    ]);
    if (token !== speechFitToken) return;
    const win = api.getCurrentWindow();
    const scale = await win.scaleFactor();
    // Measure the character before changing the layout so it does not jump.
    const local = characterLocalCenter();
    const pos = await win.outerPosition();
    const target = local
      ? { x: pos.x + local.x * scale, y: pos.y + local.y * scale }
      : { x: pos.x, y: pos.y };

    app?.classList.toggle('speech-open', show);

    const base = collapsedDims();
    let width = base.width;
    let height = base.height;
    if (show) {
      // The character is anchored to the bottom; size the window so the bubble
      // sits just above the orbit area instead of floating at the top.
      const slotH = avatarSlot instanceof HTMLElement
        ? Math.max(96, Math.ceil(avatarSlot.getBoundingClientRect().height))
        : Math.max(96, Math.round(settings.orbitSize));
      app?.style.setProperty('--slot-h', `${slotH}px`);
      const rect = speech.getBoundingClientRect();
      width = Math.max(base.width, Math.ceil(rect.width) + 2 * SPEECH_EDGE);
      height = Math.max(base.height, SPEECH_TOP + Math.ceil(rect.height) + SPEECH_GAP + slotH);
    }
    const monitor = await api.currentMonitor();
    if (monitor) {
      width = Math.min(width, Math.max(220, Math.floor(monitor.size.width / scale) - 16));
      height = Math.min(height, Math.max(220, Math.floor(monitor.size.height / scale) - 16));
    }
    await win.setSize(new dpi.PhysicalSize(Math.round(width * scale), Math.round(height * scale)));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (token !== speechFitToken) return;
    const baseLocal = characterBaseCenter();
    if (!baseLocal) return;
    const desiredX = Math.round(target.x - baseLocal.x * scale);
    const desiredY = Math.round(target.y - baseLocal.y * scale);
    let x = desiredX;
    let y = desiredY;
    let shiftX = 0;
    // Only clamp horizontally while growing: hiding restores the user's own
    // placement, and the bubble's height already fits the monitor in practice.
    if (monitor && show) {
      const winW = Math.round(width * scale);
      const cx = Math.min(Math.max(desiredX, monitor.position.x), monitor.position.x + monitor.size.width - winW);
      shiftX = (desiredX - cx) / scale;
      x = cx;
    }
    setDotyShift(shiftX, 0);
    await win.setPosition(new dpi.PhysicalPosition(x, y));
  } catch {
    // Window control unavailable; the bubble still shows in the webview.
  }
}

speech?.addEventListener('click', () => {
  hideSpeech(false);
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
const tokenField = document.getElementById('setting-token');
const orbitField = document.getElementById('setting-orbit');
const orbitalField = document.getElementById('setting-orbital');
const dotyField = document.getElementById('setting-doty');
const taskBubbleField = document.getElementById('setting-task-bubble');
const autoCloseField = document.getElementById('setting-auto-close');
const autoCloseValue = document.getElementById('setting-auto-close-value');
const orbitValue = document.getElementById('setting-orbit-value');
const orbitalValue = document.getElementById('setting-orbital-value');
const dotyValue = document.getElementById('setting-doty-value');

function showSettings(show: boolean): void {
  if (settingsPanel instanceof HTMLElement) settingsPanel.hidden = !show;
  if (chatPanel instanceof HTMLElement) chatPanel.hidden = show;
  if (show) {
    void setPanelOpen(true);
    clearAutoClose();
  } else {
    scheduleAutoClose();
  }
}

function applySettings(next: DotySettings): void {
  const previous = settings;
  settings = normalizeSettings(next);
  saveSettings(settings);

  if (previous.showTaskFinishedBubble && !settings.showTaskFinishedBubble
    && speech instanceof HTMLElement && speech.dataset.kind === 'done') {
    hideSpeech();
  }

  if (settings.dotySize !== previous.dotySize) {
    avatar.destroy();
    avatar = mountAvatar(avatarMount, store, { size: settings.dotySize });
  }
  const orbitChanged =
    settings.orbitSize !== previous.orbitSize || settings.dotySize !== previous.dotySize;
  if (orbitChanged || settings.orbitalSize !== previous.orbitalSize) {
    harnessTeam.destroy();
    harnessTeam = mountHarnessTeam(slotMount, harnessOptions());
  }
  if (orbitChanged && !panelOpen) void (speechOpen ? fitSpeechWindow(true) : applyCollapsedSize());
  if (settings.autoCloseSeconds !== previous.autoCloseSeconds) scheduleAutoClose();
  if (settings.serverUrl !== previous.serverUrl) {
    serverUrl = settings.serverUrl;
    stream?.restart();
  }
}

function autoCloseLabel(seconds: number): string {
  return seconds > 0 ? `${seconds}s` : 'off';
}

function syncSettingFields(): void {
  if (serverField instanceof HTMLInputElement) serverField.value = settings.serverUrl;
  if (tokenField instanceof HTMLInputElement) tokenField.value = token ?? '';
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
  if (taskBubbleField instanceof HTMLInputElement) {
    taskBubbleField.checked = settings.showTaskFinishedBubble;
  }
  if (autoCloseField instanceof HTMLInputElement) {
    autoCloseField.min = String(AUTO_CLOSE_RANGE.min);
    autoCloseField.max = String(AUTO_CLOSE_RANGE.max);
    autoCloseField.value = String(settings.autoCloseSeconds);
  }
  if (autoCloseValue) autoCloseValue.textContent = autoCloseLabel(settings.autoCloseSeconds);
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
tokenField?.addEventListener('change', () => {
  if (!(tokenField instanceof HTMLInputElement)) return;
  const next = tokenField.value.trim();
  if (next) {
    rememberToken(next);
    token = next;
  } else {
    forgetToken();
    token = null;
  }
  // Reconnect with the new credentials.
  stream?.restart();
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
taskBubbleField?.addEventListener('change', () => {
  if (taskBubbleField instanceof HTMLInputElement) {
    applySettings({ ...settings, showTaskFinishedBubble: taskBubbleField.checked });
  }
});
autoCloseField?.addEventListener('input', () => {
  if (autoCloseField instanceof HTMLInputElement && autoCloseValue) {
    autoCloseValue.textContent = autoCloseLabel(Number(autoCloseField.value));
  }
});
autoCloseField?.addEventListener('change', () => {
  if (autoCloseField instanceof HTMLInputElement) {
    applySettings({ ...settings, autoCloseSeconds: Number(autoCloseField.value) });
  }
});

// Auto-close on idle: any interaction inside the window resets the countdown.
for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) {
  window.addEventListener(type, () => {
    if (panelOpen) scheduleAutoClose();
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Window: collapse/expand + dragging
// ---------------------------------------------------------------------------

const PANEL = { width: 380, height: 560 };
let panelOpen = false;
let panelTransition = false;
let autoCloseTimer = 0;

/** (Re)start the idle auto-close countdown while the chat is open. */
function scheduleAutoClose(): void {
  window.clearTimeout(autoCloseTimer);
  const seconds = settings.autoCloseSeconds;
  if (!panelOpen || seconds <= 0 || settingsVisible()) return;
  autoCloseTimer = window.setTimeout(() => {
    if (panelOpen && !settingsVisible()) void setPanelOpen(false);
  }, seconds * 1000);
}

function clearAutoClose(): void {
  window.clearTimeout(autoCloseTimer);
}

/** True while the settings view is showing (auto-close does not apply to it). */
function settingsVisible(): boolean {
  return settingsPanel instanceof HTMLElement && !settingsPanel.hidden;
}

/** The collapsed window must fit the orbit area and the character. */
function collapsedDims(): { width: number; height: number } {
  const side = Math.max(
    220,
    Math.round(settings.orbitSize) + 44,
    Math.round(settings.dotySize) + 84,
  );
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

/** Character center in CSS pixels within the webview (0,0 = window top-left). */
function characterLocalCenter(): { x: number; y: number } | null {
  const el = avatar.element;
  if (!(el instanceof HTMLElement)) return null;
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// Offset of the character *inside* the window. Used when the window is clamped
// to the monitor: the window shifts to fit, the character shifts back so Doty
// stays at the same spot on screen. The bubble counter-shifts to stay centered.
let dotyShiftX = 0;
let dotyShiftY = 0;

function setDotyShift(x: number, y: number): void {
  dotyShiftX = x;
  dotyShiftY = y;
  app?.style.setProperty('--doty-shift-x', `${x}px`);
  app?.style.setProperty('--doty-shift-y', `${y}px`);
  if (speech instanceof HTMLElement) {
    speech.style.setProperty('--speech-shift-x', `${-x}px`);
    speech.style.setProperty('--speech-shift-y', `${-y}px`);
    speech.style.setProperty('--speech-tail-dx', `${x}px`);
  }
}

/** Character center with the clamp offset removed (its un-shifted position). */
function characterBaseCenter(): { x: number; y: number } | null {
  const local = characterLocalCenter();
  if (!local) return null;
  return { x: local.x - dotyShiftX, y: local.y - dotyShiftY };
}

async function setPanelOpen(open: boolean): Promise<void> {
  if (open === panelOpen || panelTransition) return;
  panelTransition = true;
  try {
    // Read the character position and native window data before the layout
    // changes. Otherwise the chat panel moves Doty before we can measure it.
    const localBefore = characterLocalCenter();
    type CurrentWindow = ReturnType<(typeof import('@tauri-apps/api/window'))['getCurrentWindow']>;
    let win: CurrentWindow | undefined;
    let dpi: typeof import('@tauri-apps/api/dpi') | undefined;
    let scale: number | undefined;
    let mon: { x: number; y: number; w: number; h: number } | undefined;
    let target: { x: number; y: number } | undefined;

    if (IS_TAURI) {
      try {
        const [api, dpiApi] = await Promise.all([
          import('@tauri-apps/api/window'),
          import('@tauri-apps/api/dpi'),
        ]);
        win = api.getCurrentWindow();
        dpi = dpiApi;
        scale = await win.scaleFactor();
        const [monitor, pos, size] = await Promise.all([
          api.currentMonitor(),
          win.outerPosition(),
          win.outerSize(),
        ]);
        mon = monitor
          ? { x: monitor.position.x, y: monitor.position.y, w: monitor.size.width, h: monitor.size.height }
          : { x: 0, y: 0, w: 1920 * scale, h: 1080 * scale };
        target = localBefore
          ? { x: pos.x + localBefore.x * scale, y: pos.y + localBefore.y * scale }
          : { x: pos.x + size.width / 2, y: pos.y + size.height / 2 };
      } catch {
        // The panel still opens in the webview if native window APIs fail.
      }
    }

    panelOpen = open;
    app?.classList.toggle('collapsed', !open);
    if (open) app?.classList.remove('speech-open');
    if (!open) showSettings(false);

    if (!IS_TAURI || !win || !dpi || !scale || !mon || !target) {
      if (open) {
        document.getElementById('composer-input')?.focus();
        scheduleAutoClose();
      } else {
        clearAutoClose();
      }
      return;
    }

    const currentWindow = win;
    const dpiApi = dpi;
    const scaleFactor = scale;
    const monitorBounds = mon;
    const screenTarget = target;
    const roomDown = monitorBounds.y + monitorBounds.h - screenTarget.y;
    const roomUp = screenTarget.y - monitorBounds.y;
    const goDown = roomDown >= roomUp;
    app?.classList.toggle('upward', open && !goDown);
    if (!open) app?.classList.remove('upward');

    // Wait for CSS and native resizing. Then place the window from the
    // character's new local position, so the character stays at screenTarget.
    const waitForLayout = async (): Promise<void> => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    const placeCharacterAtTarget = async (clampToMonitor: boolean): Promise<void> => {
      await waitForLayout();
      const local = characterBaseCenter();
      if (!local) return;
      const desiredX = Math.round(screenTarget.x - local.x * scaleFactor);
      const desiredY = Math.round(screenTarget.y - local.y * scaleFactor);
      let x = desiredX;
      let y = desiredY;
      let shiftX = 0;
      let shiftY = 0;
      if (clampToMonitor) {
        const size = await currentWindow.outerSize();
        const cx = Math.min(Math.max(desiredX, monitorBounds.x), monitorBounds.x + monitorBounds.w - size.width);
        const cy = Math.min(Math.max(desiredY, monitorBounds.y), monitorBounds.y + monitorBounds.h - size.height);
        shiftX = (desiredX - cx) / scaleFactor;
        shiftY = (desiredY - cy) / scaleFactor;
        x = cx;
        y = cy;
      }
      setDotyShift(shiftX, shiftY);
      await currentWindow.setPosition(new dpiApi.PhysicalPosition(x, y));
    };

    if (!open) {
      const dims = collapsedDims();
      await currentWindow.setSize(new dpiApi.PhysicalSize(
        Math.round(dims.width * scaleFactor),
        Math.round(dims.height * scaleFactor),
      ));
      await placeCharacterAtTarget(false);
      if (speechOpen) void fitSpeechWindow(true);
      clearAutoClose();
      return;
    }

    const width = Math.round(PANEL.width * scaleFactor);
    const panelHeight = Math.round(PANEL.height * scaleFactor);
    const height = Math.round(Math.min(panelHeight, Math.max(280 * scaleFactor, goDown ? roomDown : roomUp)));
    await currentWindow.setSize(new dpiApi.PhysicalSize(width, height));
    await placeCharacterAtTarget(true);
    document.getElementById('composer-input')?.focus();
    scheduleAutoClose();
  } catch {
    // Window control unavailable; the panel still toggles via CSS.
  } finally {
    panelTransition = false;
  }
}

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
if (IS_TAURI) void applyCollapsedSize();
let unlistenTraySettings: (() => void) | undefined;
let unlistenFocus: (() => void) | undefined;

if (IS_TAURI) {
  void import('@tauri-apps/api/event')
    .then(async ({ listen }) => {
      unlistenTraySettings = await listen('doty://settings', () => showSettings(true));
    })
    .catch(() => {
      // The tray Settings action still shows the main window if this listener fails.
    });

  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('stub_report'))
    .then((report) => {
      console.info('[doty] OS-integration stubs:', report);
    })
    .catch((error: unknown) => {
      console.warn('[doty] could not read stub_report:', error);
    });

  void import('@tauri-apps/api/window')
    .then(async ({ getCurrentWindow }) => {
      // Clicking another window closes the chat.
      unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused && panelOpen) void setPanelOpen(false);
      });

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
  unlistenTraySettings?.();
  unlistenFocus?.();
  clearAutoClose();
  stream?.stop();
  stopDriver?.();
  unsubscribeQuestions();
  harnessTeam.destroy();
  avatar.destroy();
});
