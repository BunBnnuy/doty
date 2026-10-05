import { describe, expect, it } from 'vitest';
import { buildApp, constantTimeTokenMatch } from './app.js';

describe('bearer authentication', () => {
  it('rejects POST /message without a bearer token and accepts the configured token', async () => {
    const { app, log } = buildApp({ token: 'test-secret' });
    try {
      const denied = await app.inject({ method: 'POST', url: '/message', payload: { text: 'hi' } });
      expect(denied.statusCode).toBe(401);
      expect(log.since(0)).toEqual([]);

      const accepted = await app.inject({
        method: 'POST',
        url: '/message',
        headers: { authorization: 'Bearer test-secret' },
        payload: { text: 'hi' },
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toMatchObject({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('also protects the SSE endpoint and compares tokens through the fixed-length path', async () => {
    const { app } = buildApp({ token: 'a-longer-secret' });
    try {
      const denied = await app.inject({ method: 'GET', url: '/events' });
      expect(denied.statusCode).toBe(401);
      expect(constantTimeTokenMatch('a-longer-secret', 'a-longer-secret')).toBe(true);
      // Different input lengths still reach timingSafeEqual using SHA-256 digests.
      expect(constantTimeTokenMatch('x', 'a-longer-secret')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('keeps routes open when no token is configured (development fallback)', async () => {
    const { app } = buildApp({ token: '' });
    try {
      const response = await app.inject({ method: 'POST', url: '/message', payload: { text: 'hi' } });
      expect(response.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });
});
