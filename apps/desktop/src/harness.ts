/** Local-only harness read model. This module has no server/HTTP dependency. */
import { mountSatellites, type HarnessStatusSource } from '@doty/avatar';
import type { Harness, HarnessActivity, HarnessStatus } from '@doty/harness-events';

const HARNESSES: readonly Harness[] = ['codex', 'opencode', 't3'];
const ACTIVITIES: readonly HarnessActivity[] = [
  'running', 'thinking', 'tool_calling', 'waiting_approval', 'idle', 'done', 'error', 'stale',
];
const RECENT_MS = 2 * 60_000;
const STALE_RECENT_MS = 4 * 60_000;
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

/**
 * One agent response captured from a watched session. LOCAL ONLY: rendered in
 * the desktop chat, never sent to the server.
 */
export interface HarnessResponse {
  harness: Harness;
  sessionId: string;
  ts: number;
  kind: 'assistant' | 'thinking';
  text: string;
  project?: string;
  title?: string;
}

export interface HarnessTeamOptions {
  /** Square orbit area for the satellites, in CSS pixels. */
  orbitSize?: number;
  /** Diameter of each satellite dot, in CSS pixels. */
  dotSize?: number;
  /** Diameter of the character; the orbit grows to clear it. */
  dotySize?: number;
  onNotice?: (notice: HarnessNotice) => void;
  /** A watched session produced a new agent response (assistant text). */
  onResponse?: (response: HarnessResponse) => void;
  onOrbitalSelect?: (status: HarnessStatus) => void;
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

/** Kinds surfaced as chat rows: the agent's reply and its reasoning. */
const RESPONSE_KINDS = new Set(['assistant', 'thinking']);

/** Assistant replies and reasoning blocks with new text, strictly newer, oldest first. */
export function newResponseLines(lines: readonly ActivityLine[], watermark: number): ActivityLine[] {
  return lines
    .filter(
      (line) =>
        RESPONSE_KINDS.has(line.kind)
        && typeof line.text === 'string'
        && line.text.trim() !== ''
        && line.ts > watermark,
    )
    .sort((a, b) => a.ts - b.ts);
}

/** Assistant lines carrying new text, strictly newer than the watermark, oldest first. */
export function newAssistantLines(lines: readonly ActivityLine[], watermark: number): ActivityLine[] {
  return newResponseLines(lines, watermark).filter((line) => line.kind === 'assistant');
}

/** Highest timestamp across the batch, never below `fallback`. */
export function latestLineTs(lines: readonly ActivityLine[], fallback: number): number {
  let max = fallback;
  for (const line of lines) if (line.ts > max) max = line.ts;
  return max;
}

export function createHarnessStore() {
  const statuses = new Map<string, HarnessStatus>();
  const listeners = new Set<(statuses: readonly HarnessStatus[]) => void>();
  const key = (status: HarnessStatus) => JSON.stringify([status.harness, status.sessionId]);
  const visible = (now = Date.now()) => {
    const shown: HarnessStatus[] = [];
    for (const status of statuses.values()) {
      const keepFor = status.status === 'stale' ? STALE_RECENT_MS : RECENT_MS;
      if (ACTIVE.has(status.status) || now - status.lastActivityAt < keepFor) shown.push(status);
    }
    return shown.sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status))
      || b.lastActivityAt - a.lastActivityAt
      || key(a).localeCompare(key(b)));
  };
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

function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
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
  const taskEl = document.getElementById('harness-task');
  const whatHappenedEl = document.getElementById('harness-what-happened');
  const responseEl = document.getElementById('harness-response');
  const summary = document.getElementById('harness-summary');
  const close = document.getElementById('harness-close');
  const activity = new Map<string, ActivityLine[]>();
  const lastActivity = new Map<string, HarnessActivity>();
  const notified = new Set<string>();
  // Highest activity ts already surfaced as a chat response, per session. The
  // first snapshot of a session is treated as history so a fresh app launch does
  // not dump every past reply into the chat.
  const responseWatermark = new Map<string, number>();
  let selected: HarnessStatus | undefined;
  let destroyed = false;
  let unlisten: (() => void) | undefined;

  function ingestActivity(value: unknown): void {
    const batch = readActivityBatch(value);
    if (!batch) return;
    activity.set(sessionKey(batch.harness, batch.sessionId), batch.events);
    detectResponses(batch);
    if (selected && selected.harness === batch.harness && selected.sessionId === batch.sessionId) {
      renderDetails();
    }
  }

  /** Surface new agent responses from a session's activity snapshot, once each. */
  function detectResponses(batch: ActivityBatch): void {
    const key = sessionKey(batch.harness, batch.sessionId);
    const previous = responseWatermark.get(key);
    const latest = latestLineTs(batch.events, previous ?? 0);
    if (previous === undefined) {
      // First sight of this session: record its existing lines as history.
      responseWatermark.set(key, latest);
      return;
    }
    const fresh = newResponseLines(batch.events, previous);
    responseWatermark.set(key, latest);
    if (fresh.length === 0 || !options.onResponse) return;
    const status = store
      .all()
      .find((item) => item.harness === batch.harness && item.sessionId === batch.sessionId);
    for (const line of fresh) {
      if (typeof line.text !== 'string' || !line.text.trim()) continue;
      options.onResponse({
        harness: batch.harness,
        sessionId: batch.sessionId,
        ts: line.ts,
        kind: line.kind === 'thinking' ? 'thinking' : 'assistant',
        text: line.text,
        ...(status?.project !== undefined ? { project: status.project } : {}),
        ...(status?.title !== undefined ? { title: status.title } : {}),
      });
    }
  }

  /** Build a readable summary from local-only activity lines. */
  function sessionSummary(status: HarnessStatus): {
    task: string;
    whatHappened: string;
    response: string;
    hasResponse: boolean;
  } {
    const lines = activity.get(sessionKey(status.harness, status.sessionId)) ?? [];
    const tools = new Map<string, number>();
    let lastAssistant = '';
    let lastUser = '';
    let lastError = '';
    let userCount = 0;
    let assistantCount = 0;
    for (const line of lines) {
      if (line.kind === 'tool_call' && line.tool) tools.set(line.tool, (tools.get(line.tool) ?? 0) + 1);
      if (line.kind === 'error' && line.text?.trim()) lastError = line.text;
      if (line.kind === 'assistant') {
        assistantCount += 1;
        if (line.text?.trim()) lastAssistant = line.text;
      }
      if (line.kind === 'user') {
        userCount += 1;
        if (line.text?.trim()) lastUser = line.text;
      }
    }
    const task = lastUser
      ? oneLine(lastUser, 360)
      : status.title
        ? oneLine(status.title, 240)
        : 'No task text was captured.';
    const response = lastAssistant
      ? excerpt(lastAssistant, 1600)
      : 'No agent response text was captured.';
    const toolCount = [...tools.values()].reduce((sum, count) => sum + count, 0);
    const toolList = [...tools.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([name, count]) => `${name} × ${count}`)
      .join(', ');
    const outcome = status.status === 'error'
      ? status.harness === 't3'
        ? 'T3 reports errors and run interruptions with the same status. This data cannot tell which one occurred.'
        : lastError
          ? `Captured error detail: ${oneLine(lastError, 240)}`
          : 'The adapter reported an error. The status data does not include its cause.'
      : status.status === 'done'
        ? 'The session completed.'
        : status.status === 'stale'
          ? 'The session has had no activity for at least two minutes.'
          : status.status === 'waiting_approval'
            ? 'The session is waiting for approval.'
            : status.status === 'idle'
              ? 'The session is idle.'
              : 'The session is active.';
    const activitySummary = lines.length === 0
      ? 'The watcher captured status only; it captured no activity lines.'
      : toolCount > 0
        ? `Recorded ${toolCount} tool call${toolCount === 1 ? '' : 's'}: ${toolList}${tools.size > 5 ? ', and more' : ''}.`
        : userCount + assistantCount > 0
          ? `Captured ${userCount} user message${userCount === 1 ? '' : 's'} and ${assistantCount} agent message${assistantCount === 1 ? '' : 's'}, with no tool calls.`
          : `Captured ${lines.length} metadata event${lines.length === 1 ? '' : 's'}, but no task text, agent response, or tool calls.`;
    return { task, whatHappened: `${outcome} ${activitySummary}`, response, hasResponse: Boolean(lastAssistant) };
  }

  /** Keep the speech bubble concise; full local text stays in the details view. */
  function summarize(status: HarnessStatus): string {
    const summary = sessionSummary(status);
    const body = summary.hasResponse
      ? `Agent response: ${oneLine(summary.response, 140)}`
      : `Task: ${summary.task}`;
    return `${summary.whatHappened}\n${body}`;
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
    const summary = sessionSummary(selected);
    if (taskEl) taskEl.textContent = summary.task;
    if (whatHappenedEl) whatHappenedEl.textContent = summary.whatHappened;
    if (responseEl) responseEl.textContent = summary.response;
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

  // Only satellites doing work orbit the character: running / thinking /
  // tool-calling / waiting-for-approval. Terminal sessions (idle, done, error,
  // stale) stay in the store for notices and details, but their dot pops out.
  const activeSource: HarnessStatusSource = {
    subscribe(listener) {
      return store.source.subscribe((statuses) => {
        listener(statuses.filter((status) => ACTIVE.has(status.status)));
      });
    },
  };

  const satellites = mountSatellites(container, activeSource, {
    size: base,
    dotSize: baseDot,
    onSelect(status) {
      selected = status;
      renderDetails();
      options.onOrbitalSelect?.(status);
    },
  });
  const unsubscribe = store.source.subscribe((statuses) => {
    detect(statuses);
    const visibleKeys = new Set(statuses.map((status) => sessionKey(status.harness, status.sessionId)));
    for (const key of lastActivity.keys()) {
      if (visibleKeys.has(key)) continue;
      lastActivity.delete(key);
      notified.delete(`${key}:done`);
      notified.delete(`${key}:error`);
      notified.delete(`${key}:attention`);
    }
    const selectedKey = selected ? sessionKey(selected.harness, selected.sessionId) : undefined;
    for (const key of activity.keys()) {
      if (!visibleKeys.has(key) && key !== selectedKey) activity.delete(key);
    }
    const shown = statuses.filter((status) => ACTIVE.has(status.status));
    // Match the satellite layer's extra rings, leaving the unchanged mascot
    // centered instead of clipping a growing team at the original orbit edge.
    const extent = base + Math.max(0, Math.ceil(shown.length / 12) - 1) * 48;
    container.style.width = `${extent}px`;
    container.style.height = `${extent}px`;
    if (summary) {
      const activeCount = shown.length;
      const recentCount = statuses.length - activeCount;
      const errorCount = statuses.filter((status) => status.status === 'error').length;
      const parts = [
        ...(activeCount > 0 ? [`${activeCount} active`] : []),
        ...(recentCount > 0
          ? [`${recentCount} recent${errorCount > 0 ? ` (${errorCount} error${errorCount === 1 ? '' : 's'})` : ''}`]
          : []),
      ];
      summary.textContent = parts.length > 0
        ? `${parts.join(' · ')}${activeCount > 0 ? ' · click a dot' : ''}`
        : 'No current or recent harness sessions';
    }
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
