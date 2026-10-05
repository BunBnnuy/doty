/**
 * Chat / run panel: a message list plus a composer.
 *
 * Outgoing text is shown immediately, POSTed by the caller, and reconciled with
 * the SSE `message` echo (same `seq`, or the oldest in-flight row with the same
 * text). Messages that cannot reach the server stay queued and flush on reconnect.
 */

import type { Connection } from '@doty/dot-state';
import { isRetryableSend, normalizeServerUrl } from './api.js';
import type { SseFrame } from './sse.js';
import { toChatLine, type ChatLine } from './wire.js';

export interface ChatPanel {
  ingest(frame: SseFrame): void;
  setConnection(status: Connection): void;
  /** Drop the transcript (server URL changed; the replay will refill it). */
  clear(): void;
  /** Server log restarted. Forget seqs so the full replay can render again. */
  forgetHistory(): void;
  flush(): Promise<void>;
  showAuthError(): void;
}

export interface MountChatOptions {
  serverUrl: string;
  lastSeq: () => number;
  send: (text: string) => Promise<number | undefined>;
  onServerUrl: (url: string) => void;
}

interface Item {
  id: string;
  seq?: number;
  role: ChatLine['role'];
  text: string;
  status: 'pending' | 'queued' | 'sent' | 'error';
  /** Highest SSE seq observed when this outgoing row was created. */
  afterSeq: number;
  tone?: 'error';
  note?: string;
}

const EMPTY_COPY: Record<Connection, string> = {
  reconnecting: 'Connecting to the server…',
  online: 'Send a message to start.',
  offline: 'Server unreachable — demo dot is on. Messages queue until it returns.',
};

export function mountChat(options: MountChatOptions): ChatPanel {
  const list = requireElement<HTMLOListElement>('messages');
  const empty = requireElement<HTMLElement>('empty');
  const composer = requireElement<HTMLFormElement>('composer');
  const input = requireElement<HTMLInputElement>('composer-input');
  const serverForm = requireElement<HTMLFormElement>('server-form');
  const serverInput = requireElement<HTMLInputElement>('server-url');
  const serverDetails = document.getElementById('server-settings');

  const items: Item[] = [];
  const byId = new Map<string, { item: Item; element: HTMLLIElement }>();
  const seenSeq = new Set<number>();
  const queue: string[] = [];
  let localSeq = 0;
  let flushing = false;
  let connection: Connection = 'reconnecting';
  let activeServer = options.serverUrl;

  serverInput.value = options.serverUrl;
  renderEmpty();

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void sendOutgoing(text);
  });

  serverInput.addEventListener('input', () => {
    serverInput.setCustomValidity('');
  });

  serverForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const next = normalizeServerUrl(serverInput.value);
    if (!next) {
      serverInput.setCustomValidity('Enter an http(s) server URL');
      serverInput.reportValidity();
      return;
    }
    serverInput.setCustomValidity('');
    serverInput.value = next;
    if (next === activeServer) {
      options.onServerUrl(next);
      return;
    }
    activeServer = next;
    clear();
    options.onServerUrl(next);
  });

  function renderEmpty(): void {
    const show = items.length === 0;
    empty.hidden = !show;
    empty.textContent = EMPTY_COPY[connection];
  }

  function setConnection(status: Connection): void {
    connection = status;
    if (serverDetails instanceof HTMLDetailsElement) {
      serverDetails.open = status !== 'online';
    }
    renderEmpty();
  }

  function showAuthError(): void {
    const existing = items.find((item) => item.id === 'auth-error');
    if (existing) return;
    pushItem({
      id: 'auth-error',
      role: 'run',
      text: 'Authentication failed. Set a valid token with ?token=... and reload.',
      status: 'error',
      afterSeq: options.lastSeq(),
      tone: 'error',
      note: '401',
    });
  }

  async function sendOutgoing(text: string): Promise<void> {
    const item = pushItem({
      id: `local-${++localSeq}`,
      role: 'user',
      text,
      status: 'pending',
      afterSeq: options.lastSeq(),
    });
    try {
      const seq = await options.send(text);
      markSent(item.id, seq);
    } catch (error) {
      if (isRetryableSend(error)) {
        markQueued(item.id);
      } else {
        markFailed(item.id, errorText(error));
      }
    }
  }

  function pushItem(item: Item): Item {
    items.push(item);
    const element = renderItem(item);
    byId.set(item.id, { item, element });
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    list.append(element);
    if (stick || item.role === 'user') {
      list.scrollTop = list.scrollHeight;
    }
    renderEmpty();
    return item;
  }

  function renderItem(item: Item): HTMLLIElement {
    const element = document.createElement('li');
    element.className = `msg msg-${item.role}${item.tone === 'error' ? ' is-error' : ''}`;
    element.dataset.status = item.status;
    if (item.seq !== undefined) element.dataset.seq = String(item.seq);

    if (item.role === 'run') {
      const kind = document.createElement('span');
      kind.className = 'msg-kind';
      const splitAt = item.text.indexOf(' · ');
      kind.textContent = splitAt === -1 ? item.text : item.text.slice(0, splitAt);
      element.append(kind);
      if (splitAt !== -1) {
        const body = document.createElement('span');
        body.className = 'msg-text';
        body.textContent = item.text.slice(splitAt + 3);
        element.append(body);
      }
    } else {
      const body = document.createElement('span');
      body.className = 'msg-text';
      body.textContent = item.text;
      element.append(body);
    }

    const meta = document.createElement('span');
    meta.className = 'msg-meta';
    meta.textContent = item.note ?? statusLabel(item.status);
    if (item.status === 'sent' && !item.note) meta.hidden = true;
    element.append(meta);
    return element;
  }

  function paint(id: string): void {
    const row = byId.get(id);
    if (!row) return;
    const next = renderItem(row.item);
    row.element.replaceWith(next);
    row.element = next;
  }

  function markSent(id: string, seq?: number): void {
    const row = byId.get(id);
    if (!row || row.item.status === 'sent') {
      if (seq !== undefined) seenSeq.add(seq);
      return;
    }
    row.item.status = 'sent';
    row.item.note = undefined;
    if (seq !== undefined) {
      row.item.seq = seq;
      seenSeq.add(seq);
    }
    unqueue(id);
    paint(id);
  }

  function markQueued(id: string): void {
    const row = byId.get(id);
    if (!row || row.item.status === 'sent') return;
    row.item.status = 'queued';
    row.item.note = 'queued';
    if (!queue.includes(id)) queue.push(id);
    paint(id);
  }

  function markFailed(id: string, reason: string): void {
    const row = byId.get(id);
    if (!row) return;
    row.item.status = 'error';
    row.item.note = reason;
    unqueue(id);
    paint(id);
  }

  function unqueue(id: string): void {
    const index = queue.indexOf(id);
    if (index !== -1) queue.splice(index, 1);
  }

  function ingest(frame: SseFrame): void {
    const line = toChatLine(frame);
    if (!line) return;
    if (line.seq !== undefined && seenSeq.has(line.seq)) return;

    if (line.role === 'user') {
      // Attach the echo to the outgoing row. A row already marked sent (the
      // POST returned before the stream) still matches when it has no seq yet,
      // so the echo does not become a second bubble.
      const pending = items.find(
        (item) =>
          item.role === 'user' &&
          item.seq === undefined &&
          item.status !== 'error' &&
          item.text === line.text &&
          (line.seq === undefined || line.seq > item.afterSeq),
      );
      if (pending) {
        markSent(pending.id, line.seq);
        return;
      }
    }

    if (line.role === 'assistant') {
      const last = items[items.length - 1];
      if (last && last.role === 'assistant' && last.text === line.text) {
        if (line.seq !== undefined) seenSeq.add(line.seq);
        return;
      }
    }

    if (line.seq !== undefined) seenSeq.add(line.seq);
    pushItem({
      id: line.seq !== undefined ? `seq-${line.seq}` : `local-${++localSeq}`,
      seq: line.seq,
      role: line.role,
      text: line.text,
      status: 'sent',
      afterSeq: line.seq ?? options.lastSeq(),
      tone: line.tone,
    });
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length > 0) {
        const id = queue[0];
        if (!id) break;
        const row = byId.get(id);
        if (!row || row.item.status === 'sent') {
          queue.shift();
          continue;
        }
        row.item.status = 'pending';
        row.item.note = undefined;
        row.item.afterSeq = options.lastSeq();
        paint(id);
        try {
          const seq = await options.send(row.item.text);
          markSent(id, seq);
        } catch (error) {
          if (isRetryableSend(error)) {
            markQueued(id);
            break;
          }
          markFailed(id, errorText(error));
        }
      }
    } finally {
      flushing = false;
    }
  }

  function clear(): void {
    items.length = 0;
    byId.clear();
    seenSeq.clear();
    queue.length = 0;
    list.replaceChildren();
    renderEmpty();
  }

  /** Drop rendered history but keep outgoing rows the server has not accepted. */
  function forgetHistory(): void {
    const keep = items.filter((item) => item.role === 'user' && item.status !== 'sent');
    items.length = 0;
    for (const item of keep) items.push(item);
    byId.clear();
    seenSeq.clear();
    list.replaceChildren();
    for (const item of items) {
      const element = renderItem(item);
      byId.set(item.id, { item, element });
      list.append(element);
    }
    renderEmpty();
  }

  return { ingest, setConnection, clear, flush, forgetHistory, showAuthError };
}

function statusLabel(status: Item['status']): string {
  if (status === 'pending') return 'sending';
  if (status === 'queued') return 'queued';
  if (status === 'error') return 'failed';
  return '';
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'send failed';
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`Doty webview: #${id} is missing from index.html`);
  }
  return node as T;
}
