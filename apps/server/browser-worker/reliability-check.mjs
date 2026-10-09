import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CDP, BrowserFailure, retryRead, waitForPage } from './reliability.mjs';

test('concurrent health and page calls share one Chromium connection', async () => {
  const sockets = [];
  class Socket extends EventTarget {
    readyState = 0;
    constructor() { super(); sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    send(raw) {
      const { id, method } = JSON.parse(raw);
      queueMicrotask(() => { const event = new Event('message'); event.data = JSON.stringify({ id, result: { method } }); this.dispatchEvent(event); });
    }
  }
  const cdp = new CDP(async () => ({ json: async () => [{ type: 'page', id: 'one', webSocketDebuggerUrl: 'ws://local' }] }), Socket);
  const results = await Promise.all([cdp.connect(), cdp.call('Page.getFrameTree'), cdp.call('Accessibility.getFullAXTree')]);
  assert.equal(sockets.length, 1);
  assert.equal(results[1].method, 'Page.getFrameTree');
  assert.equal(results[2].method, 'Accessibility.getFullAXTree');
});

test('page reads recover from a lost context, stop after three failures, and do not retry permanent errors', async () => {
  let calls = 0;
  assert.equal(await retryRead(async () => { if (++calls === 1) throw new BrowserFailure('CDP_CONTEXT_LOST'); return 'page'; }, async () => {}), 'page');
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(retryRead(async () => { calls++; throw new BrowserFailure('CDP_DISCONNECTED'); }, async () => {}));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryRead(async () => { calls++; throw new BrowserFailure('CDP_COMMAND_FAILED'); }, async () => {}));
  assert.equal(calls, 1);
});

test('navigation waits for the requested document and two ready observations', async () => {
  let sample = 0;
  const cdp = { async call(method) {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: sample++ < 1 ? 'old' : 'new' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    return { result: { value: { ready: sample < 3 ? 'loading' : 'interactive', url: 'https://example.org' } } };
  } };
  assert.equal(await waitForPage(cdp, 3000, 'new'), 'new:https://example.org');
  assert.equal(sample, 4);
});
