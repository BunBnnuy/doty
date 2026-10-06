import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { SecretBox, STATE_TTL_MS } from './crypto.js';
import { GmailClient } from './google.js';
import { GraphClient } from './microsoft.js';
import { EmailService } from './service.js';
import { InMemoryIntegrationStore } from './store.js';
import { htmlToText } from './text.js';
import type { EmailProvider } from './types.js';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const MICROSOFT_CONFIG = {
  clientId: 'client',
  clientSecret: 'secret',
  tenantId: 'tenant-1',
  redirectUri: 'https://doty.killbunny.top/integrations/microsoft/callback',
};
const GOOGLE_CONFIG = {
  clientId: 'g-client',
  clientSecret: 'g-secret',
  redirectUri: 'https://doty.killbunny.top/integrations/google/callback',
};

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

  it('bounds results with since/until as Gmail epoch terms', async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => json({ messages: [] }));
    const client = new GmailClient('token', fakeFetch);
    const since = Date.UTC(2026, 9, 5, 6, 0);
    const until = Date.UTC(2026, 9, 6, 6, 0);
    await client.list({ limit: 5, since, until });
    const url = String(fakeFetch.mock.calls[0]?.[0]);
    expect(url).toContain(`after%3A${since / 1000}`);
    expect(url).toContain(`before%3A${until / 1000}`);
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

describe('EmailService (multiple accounts)', () => {
  const base = 1_800_000_000_000;

  function build() {
    let now = base;
    let googleConnects = 0;
    const box = new SecretBox(KEY_A);
    const store = new InMemoryIntegrationStore();
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) {
        const refresh = String(init?.body ?? '').includes('grant_type=refresh_token');
        return json({
          access_token: refresh ? 'ms-access-2' : 'ms-access-1',
          refresh_token: refresh ? 'ms-refresh-2' : 'ms-refresh-1',
          expires_in: 3600,
          scope: 'Mail.Read User.Read',
        });
      }
      if (url.includes('oauth2.googleapis.com/token')) {
        const refresh = String(init?.body ?? '').includes('grant_type=refresh_token');
        return json({
          access_token: refresh ? 'g-access-2' : 'g-access-1',
          refresh_token: refresh ? 'g-refresh-2' : 'g-refresh-1',
          expires_in: 3600,
          scope: 'gmail.readonly',
        });
      }
      if (url.includes('openidconnect.googleapis.com')) {
        googleConnects += 1;
        return json({ email: googleConnects === 1 ? 'segundo@gmail.com' : 'tercero@gmail.com' });
      }
      if (url.includes('graph.microsoft.com/v1.0/me?')) return json({ mail: 'jesus@corpogafi.com' });
      return json({ value: [], messages: [] });
    });
    const service = new EmailService({
      store,
      box,
      google: GOOGLE_CONFIG,
      microsoft: MICROSOFT_CONFIG,
      fetchImpl: fakeFetch,
      now: () => now,
    });
    return { service, store, box, advance: (ms: number) => { now += ms; } };
  }

  async function connect(service: EmailService, provider: EmailProvider) {
    const url = service.connectUrl(provider);
    const state = new URL(url).searchParams.get('state') ?? '';
    return service.handleCallback(provider, `code-${provider}`, state);
  }

  it('connects several mailboxes and reports them', async () => {
    const { service, store, box } = build();
    const ms = await connect(service, 'microsoft');
    expect(ms.account).toBe('jesus@corpogafi.com');
    await connect(service, 'google');

    const row = await store.get(ms.id);
    expect(row?.sealedTokens.startsWith('v1.')).toBe(true);
    expect(box.decrypt(row?.sealedTokens ?? '')).toContain('ms-refresh-1');

    const overview = await service.statuses();
    expect(overview.providers.find((p) => p.provider === 'google')).toMatchObject({
      configured: true,
      accounts: 1,
    });
    expect(overview.providers.find((p) => p.provider === 'microsoft')).toMatchObject({
      configured: true,
      accounts: 1,
    });
    expect(overview.accounts.map((a) => a.account).sort()).toEqual([
      'jesus@corpogafi.com',
      'segundo@gmail.com',
    ]);
  });

  it('resolves accounts by email, id and provider, and refuses ambiguity', async () => {
    const { service } = build();
    await connect(service, 'microsoft');
    await connect(service, 'google');
    const third = await connect(service, 'google');
    expect(third.account).toBe('tercero@gmail.com');

    await expect(service.list({}, { limit: 5 })).rejects.toThrow('More than one account');
    await expect(service.list({ provider: 'google' }, { limit: 5 })).rejects.toThrow(
      'More than one account',
    );
    expect(await service.list({ account: 'TERCERO@GMAIL.COM' }, { limit: 5 })).toEqual([]);
    expect(await service.list({ account: third.id }, { limit: 5 })).toEqual([]);
    expect(await service.list({ provider: 'microsoft' }, { limit: 5 })).toEqual([]);
  });

  it('rejects a forged state', async () => {
    const { service } = build();
    await expect(service.handleCallback('microsoft', 'code', 'forged.state')).rejects.toThrow('state');
  });

  it('refreshes expired access tokens and persists rotations per account', async () => {
    const { service, store, box, advance } = build();
    const ms = await connect(service, 'microsoft');
    await connect(service, 'google');
    advance(2 * 60 * 60 * 1000); // access tokens expired
    await service.list({ account: ms.account }, { limit: 5 });
    const row = await store.get(ms.id);
    expect(box.decrypt(row?.sealedTokens ?? '')).toContain('ms-refresh-2');
  });

  it('disconnects by id or provider and refuses ambiguous providers', async () => {
    const { service } = build();
    const ms = await connect(service, 'microsoft');
    await connect(service, 'google');
    await connect(service, 'google');

    await expect(service.disconnect('google')).rejects.toThrow('More than one account');
    expect(await service.disconnect(ms.id)).toBe(true);
    expect(await service.disconnect('microsoft')).toBe(false);
    expect(await service.disconnect('nope')).toBe(false);
    const overview = await service.statuses();
    expect(overview.accounts).toHaveLength(2);
  });

  it('reports unconfigured providers', async () => {
    const store = new InMemoryIntegrationStore();
    const service = new EmailService({
      store,
      box: new SecretBox(KEY_A),
      microsoft: MICROSOFT_CONFIG,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const overview = await service.statuses();
    expect(overview.providers.find((p) => p.provider === 'google')).toMatchObject({
      configured: false,
      accounts: 0,
    });
    expect(() => service.connectUrl('google')).toThrow('not configured');
  });
});

describe('integration routes', () => {
  it('guards API routes and serves the public callback', async () => {
    const service = {
      statuses: vi.fn(async () => ({ providers: [], accounts: [] })),
      connectUrl: vi.fn(() => 'https://provider.example/authorize'),
      handleCallback: vi.fn(async () => ({ account: 'a@b.c', id: 'int-1' })),
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

      const list = await app.inject({
        method: 'GET',
        url: '/email/list?provider=google&account=ana%40example.com&limit=3',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(list.statusCode).toBe(200);
      expect(service.list).toHaveBeenCalledWith(
        { provider: 'google', account: 'ana@example.com' },
        { limit: 3 },
      );

      const del = await app.inject({
        method: 'DELETE',
        url: '/integrations/int-1',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(del.statusCode).toBe(200);
      expect(service.disconnect).toHaveBeenCalledWith('int-1');

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

      const adminConsent = await app.inject({
        method: 'GET',
        url: '/integrations/google/callback?admin_consent=True',
      });
      expect(adminConsent.statusCode).toBe(200);

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
