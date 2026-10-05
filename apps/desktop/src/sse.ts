/**
 * Raw SSE client for `GET /events`.
 *
 * The server speaks native SSE fields, not the `ServerToClient` wrapper and
 * not a full `ServerEvent` (there is no `ts` on the wire):
 *
 *   id:    <seq>            omitted on control frames such as `hello`
 *   event: <type>
 *   data:  <JSON payload>   this is `ServerEvent.data` only
 *
 * Comment lines (`: heartbeat`) are ignored. Reconnects send `Last-Event-ID`
 * so the server replays every record with `seq` strictly greater than it.
 */

export interface SseFrame {
  /** Parsed `id:` field. Absent on control frames (`hello` has no id). */
  seq?: number;
  /** `event:` field. Defaults to `message` when the field is omitted (SSE spec). */
  type: string;
  /**
   * JSON-parsed `data:` payload. A raw string when the payload is not JSON.
   * `null` when the field was empty or the JSON literal `null`.
   */
  data: unknown;
}

export interface SseParser {
  /** Feed the next decoded chunk. Complete frames are emitted immediately. */
  push(chunk: string): void;
  /** Flush a trailing frame that the server closed without a blank line. */
  end(): void;
}

export function createSseParser(onFrame: (frame: SseFrame) => void): SseParser {
  let buffer = '';
  let bomStripped = false;

  const consume = (flush: boolean): void => {
    if (!bomStripped) {
      buffer = buffer.replace(/^\uFEFF/, '');
      bomStripped = true;
    }
    // A trailing CR may be the first half of a CRLF split across chunks.
    const heldCr = !flush && buffer.endsWith('\r');
    const held = heldCr ? buffer.slice(0, -1) : buffer;
    const normalized = held.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = normalized.split('\n\n');
    buffer = (parts.pop() ?? '') + (heldCr ? '\r' : '');
    for (const block of parts) {
      const frame = parseBlock(block);
      if (frame) onFrame(frame);
    }
    if (flush && buffer.trim()) {
      const frame = parseBlock(buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
      buffer = '';
      if (frame) onFrame(frame);
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      consume(false);
    },
    end() {
      consume(true);
    },
  };
}

/** Parse one SSE block (no trailing blank line). Returns null for comments. */
export function parseBlock(block: string): SseFrame | null {
  let id: string | undefined;
  let eventName: string | undefined;
  const dataLines: string[] = [];
  let sawData = false;
  let sawEvent = false;

  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') {
      eventName = value;
      sawEvent = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawData = true;
    }
  }

  if (!sawData && !sawEvent) return null;

  const raw = dataLines.join('\n');
  let data: unknown = null;
  if (sawData && raw !== '') {
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      data = raw;
    }
  }

  const parsedId = id !== undefined && id !== '' ? Number.parseInt(id, 10) : Number.NaN;
  const frame: SseFrame = {
    type: eventName && eventName.length > 0 ? eventName : 'message',
    data,
  };
  if (Number.isFinite(parsedId)) frame.seq = parsedId;
  return frame;
}

export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onFrame);
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    reader.releaseLock();
  }
}

export type StreamStatus = 'online' | 'reconnecting' | 'offline';

export interface EventStream {
  stop(): void;
  /** Drop the socket and connect again. Resets the replay cursor (new server). */
  restart(): void;
  lastSeq(): number;
}

export interface EventStreamOptions {
  /** Origin of the online brain, no trailing path. Read on every attempt. */
  url: () => string;
  onFrame: (frame: SseFrame) => void;
  onStatus: (status: StreamStatus) => void;
  token?: () => string | null;
  onUnauthorized?: () => void;
  /**
   * The server's `hello.cursor` moved backwards (process restart, empty log).
   * The replay cursor is dropped; the next connect replays from the start.
   * Callers should forget seqs they have already rendered.
   */
  onReset?: () => void;
}

const OFFLINE_AFTER = 3;

/**
 * Connect to `GET /events` and keep the socket alive.
 *
 * The first failure (server down at launch) reports `offline` so the shell can
 * fall back to the fake driver immediately. After a live session, a short blip
 * stays `reconnecting` and preserves the last real state; repeated failures
 * fall through to `offline`.
 */
export function openEventStream(options: EventStreamOptions): EventStream {
  let stopped = false;
  let generation = 0;
  let lastSeq = 0;
  let everOpened = false;
  let failStreak = 0;
  let active: AbortController | null = null;

  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });

  async function run(gen: number): Promise<void> {
    while (!stopped && generation === gen) {
      const controller = new AbortController();
      active = controller;
      // Bounds only the handshake. A live stream must not be killed by this.
      const connectTimeout = setTimeout(() => controller.abort(), 8_000);
      let cursorReset = false;
      try {
        const headers: Record<string, string> = { accept: 'text/event-stream' };
        const token = options.token?.();
        if (token) headers.Authorization = `Bearer ${token}`;
        if (lastSeq > 0) headers['Last-Event-ID'] = String(lastSeq);
        const response = await fetch(eventsUrl(options.url()), {
          method: 'GET',
          headers,
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal,
        });
        clearTimeout(connectTimeout);
        if (!response.ok || !response.body) {
          if (response.status === 401) options.onUnauthorized?.();
          throw new Error(`GET /events failed: ${response.status}`);
        }
        everOpened = true;
        failStreak = 0;
        options.onStatus('online');
        // A single chunk can contain `hello` plus the replay that follows it.
        // Once a backwards cursor is detected, ignore the rest of this socket —
        // those seqs belong to a log we are about to re-read from the start.
        let ignoreRest = false;
        await readEventStream(
          response.body,
          (frame) => {
            if (ignoreRest) return;
            if (frame.type === 'hello') {
              const cursor = readHelloCursor(frame.data);
              if (cursor !== undefined && cursor < lastSeq) {
                lastSeq = 0;
                cursorReset = true;
                ignoreRest = true;
                options.onReset?.();
                controller.abort();
                return;
              }
            }
            if (frame.seq !== undefined && frame.seq > lastSeq) lastSeq = frame.seq;
            options.onFrame(frame);
          },
          controller.signal,
        );
        if (cursorReset && generation === gen && !stopped) continue;
        if (stopped || generation !== gen) return;
        failStreak += 1;
        options.onStatus(failStreak >= OFFLINE_AFTER ? 'offline' : 'reconnecting');
      } catch (error) {
        clearTimeout(connectTimeout);
        if (cursorReset && generation === gen && !stopped) continue;
        if (stopped || generation !== gen) return;
        if (isAbort(error) && generation !== gen) return;
        failStreak += 1;
        const unreachable = !everOpened || failStreak >= OFFLINE_AFTER;
        options.onStatus(unreachable ? 'offline' : 'reconnecting');
      }
      if (stopped || generation !== gen) return;
      try {
        await sleep(backoffMs(failStreak), controller.signal);
      } catch {
        if (stopped || generation !== gen) return;
      }
    }
  }

  void run(generation);

  return {
    stop() {
      stopped = true;
      generation += 1;
      active?.abort();
    },
    restart() {
      lastSeq = 0;
      everOpened = false;
      failStreak = 0;
      generation += 1;
      active?.abort();
      options.onStatus('reconnecting');
      void run(generation);
    },
    lastSeq: () => lastSeq,
  };
}

function eventsUrl(base: string): string {
  const url = new URL(base);
  url.pathname = '/events';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function readHelloCursor(data: unknown): number | undefined {
  if (!isRecord(data)) return undefined;
  const cursor = data.cursor;
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function backoffMs(streak: number): number {
  const step = Math.min(4, Math.max(0, streak - 1));
  const base = Math.min(8_000, 500 * 2 ** step);
  return base + Math.floor(Math.random() * 200);
}
