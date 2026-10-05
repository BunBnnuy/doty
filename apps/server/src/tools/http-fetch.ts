import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Tool } from './types.js';

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  // Conservatively accept only IPv6 global unicast; reject mapped IPv4 and local ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}

async function validateUrl(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('http_fetch requires an HTTP(S) URL without embedded credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('http_fetch cannot access private or reserved addresses');
  }
}

export const httpFetchTool: Tool = {
  name: 'http_fetch',
  description: 'Read a public HTTP(S) URL using GET. No credentials, request bodies, or private addresses.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', format: 'uri', maxLength: 4096 } },
    required: ['url'],
    additionalProperties: false,
  },
  tier: 'read',
  async run(args) {
    if (Object.keys(args).some((key) => key !== 'url') || typeof args.url !== 'string' || args.url.length > 4096) {
      throw new Error('http_fetch requires only a URL string');
    }
    let url = new URL(args.url);
    const signal = AbortSignal.timeout(15_000);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await validateUrl(url);
      signal.throwIfAborted();
      const response = await fetch(url, { method: 'GET', redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('HTTP redirect has no location');
        url = new URL(location, url);
        continue;
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let bytes = 0;
      let truncated = false;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = 1_000_000 - bytes;
            const part = value.subarray(0, remaining);
            bytes += part.byteLength;
            text += decoder.decode(part, { stream: true });
            if (value.byteLength > remaining || bytes === 1_000_000) {
              truncated = true;
              break;
            }
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      return { url: url.href, status: response.status, contentType: response.headers.get('content-type'), text, truncated };
    }
    throw new Error('Too many HTTP redirects');
  },
};
