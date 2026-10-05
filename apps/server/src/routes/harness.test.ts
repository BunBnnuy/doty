import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

const message = {
  machine: 'PC-A',
  harness: 'codex',
  sessionId: 'sess-1',
  project: 'C:/repo',
  kind: 'thinking',
  text: 'checking the logs',
  ts: 1_700_000_000_000,
};

describe('harness sharing routes', () => {
  it('requires the bearer token and appends a validated harness_message', async () => {
    const { app, log } = buildApp({ token: 't' });
    try {
      const denied = await app.inject({ method: 'POST', url: '/harness-message', payload: message });
      expect(denied.statusCode).toBe(401);
      expect(log.since(0)).toEqual([]);

      const ok = await app.inject({
        method: 'POST',
        url: '/harness-message',
        headers: { authorization: 'Bearer t' },
        payload: message,
      });
      expect(ok.statusCode).toBe(202);
      const events = log.since(0);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('harness_message');
      expect(events[0]?.data).toMatchObject({ machine: 'PC-A', kind: 'thinking' });
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed notice and accepts a valid one', async () => {
    const { app } = buildApp({ token: 't' });
    try {
      const bad = await app.inject({
        method: 'POST',
        url: '/harness-notice',
        headers: { authorization: 'Bearer t' },
        payload: { machine: 'PC-A', harness: 'codex', sessionId: 's', kind: 'nope', ts: 1 },
      });
      expect(bad.statusCode).toBe(400);

      const ok = await app.inject({
        method: 'POST',
        url: '/harness-notice',
        headers: { authorization: 'Bearer t' },
        payload: { machine: 'PC-A', harness: 't3', sessionId: 's', kind: 'done', ts: 1 },
      });
      expect(ok.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });
});
