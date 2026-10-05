import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtifactWriteTool } from './artifact-write.js';
import { httpFetchTool } from './http-fetch.js';
import { nowTool } from './now.js';
import { ToolRegistry } from './registry.js';

// Even DNS is mocked: the complete suite can run without network access.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));

describe('built-in tools', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); })));
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('returns UTC time and rejects extra arguments', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
    expect(await nowTool.run({})).toEqual({ ts: Date.now(), iso: '2026-10-05T12:00:00.000Z' });
    await expect(nowTool.run({ unexpected: true })).rejects.toThrow('no arguments');
  });

  it('writes immutable artifacts only below its private temporary directory', async () => {
    const root = await mkdtemp(join(fileURLToPath(new URL('../../', import.meta.url)), '.artifact-test-'));
    try {
      const tool = createArtifactWriteTool(root);
      for (const name of ['../escape.txt', 'C:\\escape.txt', 'sub/file.txt', 'CON.txt', 'test.']) {
        await expect(tool.run({ name, content: 'test' })).rejects.toThrow('safe single filename');
      }
      expect(await readdir(root)).toEqual([]); // Invalid input never even allocates a directory.
      const result = await tool.run({ name: 'result.txt', content: 'Héllo' }) as { path: string; bytes: number };
      expect(result.path.startsWith(join(root, 'doty-artifacts-'))).toBe(true);
      expect(result.bytes).toBe(Buffer.byteLength('Héllo'));
      expect(await readFile(result.path, 'utf8')).toBe('Héllo');
      await expect(tool.run({ name: 'result.txt', content: 'overwrite' })).rejects.toThrow();
      await expect(tool.run({ name: 'too-large.txt', content: 'a'.repeat(1_000_001) })).rejects.toThrow('too large');
    } finally {
      // Only the exact directory created by this test is removed.
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fetches public URLs using GET with mocked DNS and fetch', async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response('Public page', { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fakeFetch);
    expect(await httpFetchTool.run({ url: 'https://example.com/page' })).toMatchObject({
      url: 'https://example.com/page', status: 200, text: 'Public page', truncated: false,
    });
    expect(fakeFetch).toHaveBeenCalledWith(new URL('https://example.com/page'), expect.objectContaining({ method: 'GET', redirect: 'manual' }));
  });

  it.each(['http://127.0.0.1', 'http://10.0.0.1', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'file:///private.txt', 'https://user:pass@example.com'])('rejects unsafe URL %s before fetch', async (url) => {
    await expect(httpFetchTool.run({ url })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates redirects before following them and rejects caller-controlled methods', async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    vi.stubGlobal('fetch', fakeFetch);
    await expect(httpFetchTool.run({ url: 'https://example.com' })).rejects.toThrow('private');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    await expect(httpFetchTool.run({ url: 'https://example.com', method: 'POST' })).rejects.toThrow('only a URL');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds HTTP observation size', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('a'.repeat(1_000_100))));
    const result = await httpFetchTool.run({ url: 'https://example.com' }) as { text: string; truncated: boolean };
    expect(result.text).toHaveLength(1_000_000);
    expect(result.truncated).toBe(true);
  });

  it('exposes only tool schemas to the model and rejects duplicate registrations', () => {
    const registry = new ToolRegistry([nowTool]);
    expect(registry.get('now')).toBe(nowTool);
    expect(registry.definitions()[0]).not.toHaveProperty('tier');
    expect(registry.definitions()[0]).not.toHaveProperty('run');
    expect(() => registry.register(nowTool)).toThrow('Duplicate');
  });
});
