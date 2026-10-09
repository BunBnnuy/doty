export class BrowserFailure extends Error {
  constructor(code, method, protocolCode) {
    super(code); this.code = code; this.method = method; this.protocolCode = protocolCode;
  }
}
export const transient = error => ['CDP_CONTEXT_LOST', 'CDP_DISCONNECTED', 'CDP_TIMEOUT', 'PAGE_LOADING', 'CDP_CONNECT_FAILED'].includes(error?.code);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function retryRead(read, sleep = pause) {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) { if (!transient(error) || attempt === 2) throw error; await sleep(250 * (attempt + 1)); }
  }
}

export class CDP {
  id = 0; pending = new Map(); connecting;
  constructor(fetchImpl = fetch, Socket = WebSocket) { this.fetch = fetchImpl; this.Socket = Socket; }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  async open() {
    let targets;
    try { targets = await (await this.fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5000) })).json(); }
    catch { throw new BrowserFailure('CDP_CONNECT_FAILED'); }
    const target = targets.find(t => t.type === 'page');
    if (!target) throw new BrowserFailure('CDP_CONNECT_FAILED');
    if (this.ws?.readyState === 1 && this.target === target.id) return;
    this.ws?.close(); this.target = target.id;
    const socket = new this.Socket(target.webSocketDebuggerUrl); this.ws = socket;
    socket.addEventListener('message', ({ data }) => {
      const answer = JSON.parse(data), pending = this.pending.get(answer.id);
      if (!pending || pending.socket !== socket) return;
      this.pending.delete(answer.id); clearTimeout(pending.timer);
      if (answer.error) {
        const message = answer.error.message || '';
        const code = /context.*(destroy|not found|cannot find)|cannot find.*context|frame.*(not found|detach)|navigat/i.test(message)
          ? 'CDP_CONTEXT_LOST' : 'CDP_COMMAND_FAILED';
        pending.reject(new BrowserFailure(code, pending.method, answer.error.code));
      } else pending.resolve(answer.result);
    });
    socket.addEventListener('close', () => {
      for (const [id, pending] of this.pending) {
        if (pending.socket !== socket) continue;
        clearTimeout(pending.timer); pending.reject(new BrowserFailure('CDP_DISCONNECTED', pending.method)); this.pending.delete(id);
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new BrowserFailure('CDP_CONNECT_FAILED')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new BrowserFailure('CDP_CONNECT_FAILED')); }, { once: true });
    });
  }
  async call(method, params = {}) {
    await this.connect();
    const id = ++this.id, socket = this.ws;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BrowserFailure('CDP_TIMEOUT', method)); }, 5000);
      this.pending.set(id, { resolve, reject, timer, socket, method });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new BrowserFailure('CDP_DISCONNECTED', method)); }
    });
  }
}

// DOM readiness plus a stable document, rather than a fixed navigation delay.
export async function waitForPage(cdp, timeoutMs = 12_000, expectedLoader) {
  const deadline = Date.now() + timeoutMs;
  let previous;
  while (Date.now() < deadline) {
    try {
      const { frameTree } = await cdp.call('Page.getFrameTree');
      const { executionContextId } = await cdp.call('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'doty-observation' });
      const result = await cdp.call('Runtime.evaluate', { contextId: executionContextId, returnByValue: true,
        expression: '({ready:document.readyState,url:location.href})' });
      const page = result.result?.value;
      const identity = `${frameTree.frame.loaderId}:${page?.url}`;
      if (!result.exceptionDetails && page && page.ready !== 'loading' && (!expectedLoader || frameTree.frame.loaderId === expectedLoader)) {
        if (previous === identity) return identity;
        previous = identity;
      } else previous = undefined;
    } catch (error) { if (!transient(error)) throw error; previous = undefined; }
    await pause(250);
  }
  throw new BrowserFailure('PAGE_LOADING');
}
