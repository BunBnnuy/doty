import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { SecretBox, STATE_TTL_MS } from './crypto.js';
import { GmailClient } from './google.js';
import { GraphClient } from './microsoft.js';
import { EmailService } from './service.js';
import { InMemoryIntegrationStore } from './store.js';
import { htmlToText } from './text.js';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('SecretBox', () => {
  it('seals and opens values with AES-256-GCM', () => {
    const box = new SecretBox(KEY_A);
    const sealed = box.encrypt('refresh-token-123');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('refresh-token-123');
    expect(box.decrypt(sealed)).toBe('refresh-token-123');
    expect(() => new SecretBox(KEY_B).decrypt(sealed)).toThrow();
  });

  it('detects tampering and rejects short keys', () => {
    const box = new SecretBox(KEY_A);
    const parts = box.encrypt('secret').split('.');
    const forged = [parts[0], parts[1], parts[2], Buffer.from('forged').toString('base64url')].join('.');
    expect(() => box.decrypt(forged)).toThrow();
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow('32 bytes');
  });

  it('signs, expires and rejects forged oauth state', () => {
    const box = new SecretBox(KEY_A);
    const state = box.signState({ provider: 'google', nonce: 'n' }, 1_000);
    expect(box.verifyState(state, 1_000 + STATE_TTL_MS - 1)).toMatchObject({
      provider: 'google',
      nonce: 'n',
    });
    expect(box.verifyState(state, 1_000 + STATE_TTL_MS + 1)).toBeUndefined();
    expect(box.verifyState(`${state}x`, 1_500)).toBeUndefined();
    expect(box.verifyState('no-dot', 1_500)).toBeUndefined();
  });
});

describe('text helpers', () => {
  it('converts html bodies to readable plain text', () => {
    const text = htmlToText('<p>Hola&nbsp;<b>mundo</b></p><script>evil()</script><br>línea 2');
    expect(text).toContain('Hola mundo');
    expect(text).not.toContain('evil');
    expect(text).toContain('línea 2');
    expect(htmlToText('<p>a</p><p>b</p>')).toBe('a\nb');
  });
});

describe('GmailClient', () => {
  it('lists and reads messages with the injected fetch', async () => {
    const internalDateMs = Date.UTC(2026, 9, 6, 10, 30);
    const headers = [
      { name: 'Subject', value: 'Asunto de prueba' },
      { name: 'From', value: '"Ana Pérez" <ana@example.com>' },
      { name: 'To', value: 'yo@example.com, Dos <dos@example.com>' },
    ];
    const meta = {
      labelIds: ['UNREAD'],
      snippet: 'Resumen…',
      internalDate: String(internalDateMs),
      payload: { headers },
    };
    const full = {
      ...meta,
      payload: {
        mimeType: 'multipart/alternative',
        headers,
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('Cuerpo en texto').toString('base64url') } },
        ],
      },
    };
    const fakeFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1' }] });
      if (url.includes('format=full')) return json(full);
      return json(meta);
    });

    const client = new GmailClient('access-token', fakeFetch);
    const summaries = await client.list({ query: 'is:unread', limit: 5 });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 'm1',
      provider: 'google',
      subject: 'Asunto de prueba',
      from: { name: 'Ana Pérez', address: 'ana@example.com' },
      date: new Date(internalDateMs).toISOString(),
      unread: true,
    });
    expect(summaries[0]?.to).toHaveLength(2);
    expect(String(fakeFetch.mock.calls[0]?.[0])).toContain('q=is%3Aunread');

    const message = await client.read('m1');
    expect(message.body).toContain('Cuerpo en texto');
  });
});

describe('GraphClient', () => {
  it('lists and reads messages with the injected fetch', async () => {
    const summarized = {
      id: 'g1',
      subject: 'Hola',
      from: { emailAddress: { name: 'Bob', address: 'bob@x.com' } },
      toRecipients: [{ emailAddress: { address: 'me@x.com' } }],
      receivedDateTime: '2026-10-06T10:00:00Z',
      bodyPreview: 'prev',
      isRead: false,
    };
    const fakeFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/me/messages/g1')) {
        return json({ ...summarized, body: { contentType: 'html', content: '<p>Hola <b>mundo</b></p>' } });
      }
      return json({ value: [summarized] });
    });

    const client = new GraphClient('token', fakeFetch);
    const summaries = await client.list({ query: 'factura', limit: 3 });
    expect(summaries[0]).toMatchObject({
      id: 'g1',
      provider: 'microsoft',
      from: { name: 'Bob', address: 'bob@x.com' },
      unread: true,
    });
    expect(String(fakeFetch.mock.calls[0]?.[0])).toContain('%24search=%22factura%22');

    const message = await client.read('g1');
    expect(message.body).toBe('Hola mundo');
  });
});

describe('EmailService (microsoft)', () => {
  const base = 1_800_000_000_000;

  function build() {
    let now = base;
    const box = new SecretBox(KEY_A);
    const store = new InMemoryIntegrationStore();
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) {
        const refresh = String(init?.body ?? '').includes('grant_type=refresh_token');
        return json({
          access_token: refresh ? 'access-refreshed' : 'access-1',
          refresh_token: refresh ? 'refresh-2' : 'refresh-1',
          expires_in: 3600,
          scope: 'Mail.Read User.Read',
        });
      }
      if (url.includes('/me/messages')) return json({ value: [] });
      if (url.includes('graph.microsoft.com/v1.0/me?')) return json({ mail: 'jesus@corpogafi.com' });
      throw new Error(`unexpected fetch ${url}`);
    });
    const service = new EmailService({
      store,
      box,
      microsoft: {
        clientId: 'client',
        clientSecret: 'secret',
        tenantId: 'tenant-1',
        redirectUri: 'https://doty.killbunny.top/integrations/microsoft/callback',
      },
      fetchImpl: fakeFetch,
      now: () => now,
    });
    return { service, store, box, advance: (ms: number) => { now += ms; } };
  }

  it('walks connect → callback → status, storing only sealed tokens', async () => {
    const { service, store, box } = build();
    const url = service.connectUrl('microsoft');
    expect(url).toContain('login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize');
    const state = new URL(url).searchParams.get('state');
    expect(state).toBeTruthy();

    const result = await service.handleCallback('microsoft', 'the-code', state ?? '');
    expect(result.account).toBe('jesus@corpogafi.com');
    const row = await store.get('microsoft');
    expect(row?.sealedTokens.startsWith('v1.')).toBe(true);
    expect(box.decrypt(row?.sealedTokens ?? '')).toContain('refresh-1');

    const statuses = await service.statuses();
    expect(statuses.find((status) => status.provider === 'microsoft')).toMatchObject({
      configured: true,
      connected: true,
      account: 'jesus@corpogafi.com',
    });
  });

  it('rejects a forged state', async () => {
    const { service } = build();
    await expect(service.handleCallback('microsoft', 'code', 'forged.state')).rejects.toThrow('state');
  });

  it('refreshes expired access tokens and persists rotated refresh tokens', async () => {
    const { service, store, box, advance } = build();
    const url = service.connectUrl('microsoft');
    const state = new URL(url).searchParams.get('state') ?? '';
    await service.handleCallback('microsoft', 'code', state);
    advance(2 * 60 * 60 * 1000); // access token expired
    await service.list('microsoft', { limit: 5 });
    const row = await store.get('microsoft');
    expect(box.decrypt(row?.sealedTokens ?? '')).toContain('refresh-2');
  });

  it('reports configured-but-not-connected and unconfigured providers', async () => {
    const { service } = build();
    const statuses = await service.statuses();
    expect(statuses.find((status) => status.provider === 'google')).toMatchObject({
      configured: false,
      connected: false,
    });
    expect(() => service.connectUrl('google')).toThrow('not configured');
  });
});

describe('integration routes', () => {
  it('guards API routes and serves the public callback', async () => {
    const service = {
      statuses: vi.fn(async () => []),
      connectUrl: vi.fn(() => 'https://provider.example/authorize'),
      handleCallback: vi.fn(async () => ({ account: 'a@b.c' })),
      disconnect: vi.fn(async () => true),
      list: vi.fn(async () => []),
      read: vi.fn(async () => {
        throw new Error('read is not exercised in this test');
      }),
    };
    const { app, log } = buildApp({ token: 'test-token', email: service });
    try {
      expect((await app.inject({ method: 'GET', url: '/integrations' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/email/list' })).statusCode).toBe(401);

      const status = await app.inject({
        method: 'GET',
        url: '/integrations',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(status.statusCode).toBe(200);

      const connect = await app.inject({
        method: 'POST',
        url: '/integrations/google/connect',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(connect.statusCode).toBe(200);
      expect(connect.json()).toEqual({ url: 'https://provider.example/authorize' });

      const callback = await app.inject({
        method: 'GET',
        url: '/integrations/google/callback?code=c&state=s',
      });
      expect(callback.statusCode).toBe(200);
      expect(callback.headers['content-type']).toContain('text/html');
      expect(log.since(0).some((event) => event.type === 'integration_connected')).toBe(true);

      const missingState = await app.inject({
        method: 'GET',
        url: '/integrations/google/callback?code=c',
      });
      expect(missingState.statusCode).toBe(400);

      const unknownProvider = await app.inject({
        method: 'POST',
        url: '/integrations/facebook/connect',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(unknownProvider.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
