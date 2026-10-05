/** Local-only harness read model. This module has no server/HTTP dependency. */
import { mountSatellites, type HarnessStatusSource } from '@doty/avatar';
import type { Harness, HarnessActivity, HarnessStatus } from '@doty/harness-events';

const HARNESSES: readonly Harness[] = ['codex', 'opencode', 't3'];
const ACTIVITIES: readonly HarnessActivity[] = [
  'running', 'thinking', 'tool_calling', 'waiting_approval', 'idle', 'done', 'error', 'stale',
];
const RECENT_MS = 10 * 60_000;
const ACTIVE = new Set<HarnessActivity>(['running', 'thinking', 'tool_calling', 'waiting_approval']);

/** A session finished or needs the user. Built locally; nothing leaves the device. */
export interface HarnessNotice {
  kind: 'done' | 'error' | 'attention';
  harness: Harness;
  sessionId: string;
  project?: string;
  title?: string;
  summary: string;
}

export interface HarnessTeamOptions {
  /** Square orbit area for the satellites, in CSS pixels. */
  orbitSize?: number;
  /** Diameter of each satellite dot, in CSS pixels. */
  dotSize?: number;
  /** Diameter of the character; the orbit grows to clear it. */
  dotySize?: number;
  onNotice?: (notice: HarnessNotice) => void;
}

/** Whitelist metadata even if a malformed/native payload contains text/tool args. */
export function readHarnessStatus(value: unknown): HarnessStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(HARNESSES as readonly unknown[]).includes(record.harness)
    || !(ACTIVITIES as readonly unknown[]).includes(record.status)
    || typeof record.sessionId !== 'string' || !record.sessionId
    || typeof record.lastActivityAt !== 'number' || !Number.isFinite(record.lastActivityAt)
    || record.lastActivityAt < 0) return null;
  return {
    harness: record.harness as Harness,
    sessionId: record.sessionId,
    status: record.status as HarnessActivity,
    lastActivityAt: record.lastActivityAt,
    ...(typeof record.project === 'string' ? { project: record.project } : {}),
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
  };
}

/** One local activity line for a watched session. */
export interface ActivityLine {
  ts: number;
  kind: string;
  tool?: string;
  text?: string;
}

interface ActivityBatch {
  harness: Harness;
  sessionId: string;
  events: ActivityLine[];
}

function readActivityLine(value: unknown): ActivityLine | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts) || typeof record.kind !== 'string') {
    return null;
  }
  return {
    ts: record.ts,
    kind: record.kind,
    ...(typeof record.tool === 'string' ? { tool: record.tool } : {}),
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
  };
}

export function readActivityBatch(value: unknown): ActivityBatch | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(HARNESSES as readonly unknown[]).includes(record.harness)
    || typeof record.sessionId !== 'string' || !record.sessionId
    || !Array.isArray(record.events)) return null;
  const events: ActivityLine[] = [];
  for (const raw of record.events) {
    const line = readActivityLine(raw);
    if (line) events.push(line);
  }
  return { harness: record.harness as Harness, sessionId: record.sessionId, events };
}

export function createHarnessStore() {
  const statuses = new Map<string, HarnessStatus>();
  const listeners = new Set<(statuses: readonly HarnessStatus[]) => void>();
  const key = (status: HarnessStatus) => JSON.stringify([status.harness, status.sessionId]);
  const visible = (now = Date.now()) => [...statuses.values()]
    .filter((status) => ACTIVE.has(status.status) || now - status.lastActivityAt < RECENT_MS)
    .sort((a, b) => key(a).localeCompare(key(b)));
  const notify = () => { for (const listener of listeners) listener(visible()); };
  const source: HarnessStatusSource = {
    subscribe(listener) {
      listeners.add(listener);
      listener(visible());
      return () => { listeners.delete(listener); };
    },
  };
  return {
    source,
    visible,
    all: () => [...statuses.values()],
    refresh: notify,
    ingest(value: unknown) {
      const status = readHarnessStatus(value);
      if (!status) return;
      const previous = statuses.get(key(status));
      if (previous && previous.lastActivityAt > status.lastActivityAt) return;
      statuses.set(key(status), status);
      notify();
    },
  };
}

const sessionKey = (harness: Harness, sessionId: string): string => JSON.stringify([harness, sessionId]);

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function mountHarnessTeam(
  container: HTMLElement,
  options: HarnessTeamOptions = {},
): { destroy(): void } {
  const store = createHarnessStore();
  const base = Math.max(
    96,
    Math.round(options.orbitSize ?? 150),
    Math.round(options.dotySize ?? 76) + 40,
  );
  const baseDot = Math.max(8, Math.round(options.dotSize ?? 17));
  const panel = document.getElementById('harness-details');
  const details = document.getElementById('harness-fields');
  const activityEl = document.getElementById('harness-activity');
  const summary = document.getElementById('harness-summary');
  const close = document.getElementById('harness-close');
  const activity = new Map<string, ActivityLine[]>();
  const lastActivity = new Map<string, HarnessActivity>();
  const notified = new Set<string>();
  let selected: HarnessStatus | undefined;
  let destroyed = false;
  let unlisten: (() => void) | undefined;

  function ingestActivity(value: unknown): void {
    const batch = readActivityBatch(value);
    if (!batch) return;
    activity.set(sessionKey(batch.harness, batch.sessionId), batch.events);
    if (selected && selected.harness === batch.harness && selected.sessionId === batch.sessionId) {
      renderActivity(selected);
    }
  }

  /** Structural summary: no LLM, no content leaves the device. */
  function summarize(status: HarnessStatus): string {
    const lines = activity.get(sessionKey(status.harness, status.sessionId)) ?? [];
    const tools = new Map<string, number>();
    let lastAssistant = '';
    let lastUser = '';
    for (const line of lines) {
      if (line.kind === 'tool_call' && line.tool) tools.set(line.tool, (tools.get(line.tool) ?? 0) + 1);
      if (line.kind === 'assistant' && line.text) lastAssistant = line.text;
      if (line.kind === 'user' && line.text) lastUser = line.text;
    }
    const where = status.project ?? `${status.harness}:${status.sessionId.slice(0, 8)}`;
    const body = lastAssistant
      ? oneLine(lastAssistant, 140)
      : lastUser
        ? `task: ${oneLine(lastUser, 120)}`
        : 'no summary captured';
    const toolList = [...tools.entries()].map(([name, count]) => `${name}×${count}`).join(', ');
    return toolList ? `${body}\n(${where} · tools: ${toolList})` : `${body}\n(${where})`;
  }

  function detect(statuses: readonly HarnessStatus[]): void {
    for (const status of statuses) {
      const key = sessionKey(status.harness, status.sessionId);
      const previous = lastActivity.get(key);
      lastActivity.set(key, status.status);
      if (previous === undefined || previous === status.status) continue;
      const attention = status.status === 'waiting_approval';
      const finished = status.status === 'done' || status.status === 'error';
      if (!attention && !finished) {
        // Session is working again: allow a fresh notice for the next settle.
        notified.delete(`${key}:done`);
        notified.delete(`${key}:error`);
        notified.delete(`${key}:attention`);
        continue;
      }
      const noticeKey = `${key}:${status.status}`;
      if (notified.has(noticeKey)) continue;
      notified.add(noticeKey);
      options.onNotice?.({
        kind: status.status === 'error' ? 'error' : attention ? 'attention' : 'done',
        harness: status.harness,
        sessionId: status.sessionId,
        ...(status.project !== undefined ? { project: status.project } : {}),
        ...(status.title !== undefined ? { title: status.title } : {}),
        summary: summarize(status),
      });
    }
  }

  function renderActivity(status: HarnessStatus): void {
    if (!activityEl) return;
    activityEl.replaceChildren();
    const lines = activity.get(sessionKey(status.harness, status.sessionId)) ?? [];
    if (lines.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ha-empty';
      empty.textContent = 'No activity captured yet…';
      activityEl.append(empty);
      return;
    }
    for (const line of lines.slice(-60)) {
      const item = document.createElement('li');
      const kind = document.createElement('span');
      kind.className = 'ha-kind';
      kind.textContent = line.kind.replace(/_/g, ' ');
      item.append(kind);
      if (line.tool) {
        const tool = document.createElement('span');
        tool.className = 'ha-tool';
        tool.textContent = line.tool;
        item.append(tool);
      }
      if (line.text) {
        const text = document.createElement('span');
        text.className = 'ha-text';
        text.textContent = line.text;
        item.append(text);
      }
      const time = document.createElement('time');
      time.className = 'ha-time';
      time.textContent = new Date(line.ts).toLocaleTimeString();
      item.append(time);
      activityEl.append(item);
    }
    activityEl.scrollTop = activityEl.scrollHeight;
  }

  function renderDetails(): void {
    if (!selected || !details) return;
    selected = store.all().find((status) => status.harness === selected?.harness
      && status.sessionId === selected?.sessionId) ?? selected;
    details.replaceChildren();
    for (const [label, value] of [
      ['Harness', selected.harness],
      ['Session', selected.sessionId],
      ['Project', selected.project ?? 'Not provided by watcher'],
      ['Status', selected.status.replace(/_/g, ' ')],
      ['Last activity', new Date(selected.lastActivityAt).toLocaleString()],
    ]) {
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label ?? '';
      description.textContent = value ?? '';
      details.append(term, description);
    }
    renderActivity(selected);
    if (panel) panel.hidden = false;
  }

  const satellites = mountSatellites(container, store.source, {
    size: base,
    dotSize: baseDot,
    onSelect(status) { selected = status; renderDetails(); },
  });
  const unsubscribe = store.source.subscribe((statuses) => {
    detect(statuses);
    // Match the satellite layer's extra rings, leaving the unchanged mascot
    // centered instead of clipping a growing team at the original orbit edge.
    const extent = base + Math.max(0, Math.ceil(statuses.length / 12) - 1) * 48;
    container.style.width = `${extent}px`;
    container.style.height = `${extent}px`;
    if (summary) summary.textContent = statuses.length > 0
      ? `${statuses.length} watched session${statuses.length === 1 ? '' : 's'} · click a dot`
      : 'No active harness sessions';
    renderDetails();
  });
  const dismiss = () => { selected = undefined; if (panel) panel.hidden = true; };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
  close?.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
  const timer = window.setInterval(store.refresh, 15_000);

  if ('__TAURI_INTERNALS__' in window) {
    void (async () => {
      try {
        const [{ listen }, { invoke }] = await Promise.all([
          import('@tauri-apps/api/event'), import('@tauri-apps/api/core'),
        ]);
        if (destroyed) return;
        // Subscribe first, then hydrate. Buffer updates so a racing snapshot
        // cannot overwrite newer data with the same last-activity timestamp.
        let hydrating = true;
        const bufferedStatus: unknown[] = [];
        const bufferedActivity: unknown[] = [];
        const stopStatus = await listen<unknown>('harness://status', ({ payload }) => {
          if (destroyed) return;
          if (hydrating) bufferedStatus.push(payload);
          else store.ingest(payload);
        });
        const stopActivity = await listen<unknown>('harness://activity', ({ payload }) => {
          if (destroyed) return;
          if (hydrating) bufferedActivity.push(payload);
          else ingestActivity(payload);
        });
        if (destroyed) { stopStatus(); stopActivity(); return; }
        unlisten = () => { stopStatus(); stopActivity(); };
        try {
          const [statusSnapshot, activitySnapshot] = await Promise.all([
            invoke<unknown>('harness_statuses'),
            invoke<unknown>('harness_activity'),
          ]);
          if (!destroyed && Array.isArray(statusSnapshot)) {
            for (const status of statusSnapshot) store.ingest(status);
          }
          if (!destroyed && Array.isArray(activitySnapshot)) {
            for (const batch of activitySnapshot) ingestActivity(batch);
          }
        } finally {
          hydrating = false;
          if (!destroyed) {
            for (const payload of bufferedStatus) store.ingest(payload);
            for (const batch of bufferedActivity) ingestActivity(batch);
          }
        }
      } catch {
        // Do not log untrusted payloads or adapter error context.
        if (!destroyed && summary) summary.textContent = 'Local watcher unavailable';
      }
    })();
  } else if (summary) {
    summary.textContent = 'Harness dots are available in the desktop app';
  }

  return {
    destroy() {
      destroyed = true;
      unlisten?.();
      window.clearInterval(timer);
      unsubscribe();
      satellites.destroy();
      close?.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', onKey);
    },
  };
}
