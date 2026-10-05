/** Local-only harness read model. This module has no server/HTTP dependency. */
import { mountSatellites, type HarnessStatusSource } from '@doty/avatar';
import type { Harness, HarnessActivity, HarnessStatus } from '@doty/harness-events';

const HARNESSES: readonly Harness[] = ['codex', 'opencode', 't3'];
const ACTIVITIES: readonly HarnessActivity[] = [
  'running', 'thinking', 'tool_calling', 'waiting_approval', 'idle', 'done', 'error', 'stale',
];
const RECENT_MS = 10 * 60_000;
const ACTIVE = new Set<HarnessActivity>(['running', 'thinking', 'tool_calling', 'waiting_approval']);

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

export function mountHarnessTeam(container: HTMLElement): { destroy(): void } {
  const store = createHarnessStore();
  const panel = document.getElementById('harness-details');
  const details = document.getElementById('harness-fields');
  const summary = document.getElementById('harness-summary');
  const close = document.getElementById('harness-close');
  let selected: HarnessStatus | undefined;
  let destroyed = false;
  let unlisten: (() => void) | undefined;

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
    if (panel) panel.hidden = false;
  }

  const satellites = mountSatellites(container, store.source, {
    size: 136,
    onSelect(status) { selected = status; renderDetails(); },
  });
  const unsubscribe = store.source.subscribe((statuses) => {
    // Match the satellite layer's extra rings, leaving the unchanged mascot
    // centered instead of clipping a growing team at the original orbit edge.
    const extent = 136 + Math.max(0, Math.ceil(statuses.length / 12) - 1) * 48;
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
        // cannot overwrite a newer status with the same last-activity timestamp.
        let hydrating = true;
        const buffered: unknown[] = [];
        const stop = await listen<unknown>('harness://status', ({ payload }) => {
          if (destroyed) return;
          if (hydrating) buffered.push(payload);
          else store.ingest(payload);
        });
        if (destroyed) { stop(); return; }
        unlisten = stop;
        try {
          const snapshot = await invoke<unknown>('harness_statuses');
          if (!destroyed && Array.isArray(snapshot)) {
            for (const status of snapshot) store.ingest(status);
          }
        } finally {
          hydrating = false;
          if (!destroyed) for (const payload of buffered) store.ingest(payload);
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
