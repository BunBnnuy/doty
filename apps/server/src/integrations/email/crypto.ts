/**
 * Encryption at rest for integration credentials, plus the signed OAuth state.
 *
 * Tokens never reach model context or logs. `SecretBox` seals plaintext with
 * AES-256-GCM under `DOTY_CRED_KEY` (base64, 32 bytes) and returns
 * `v1.<iv>.<tag>.<ciphertext>` (all base64url), safe for a text column. The
 * same key derives the HMAC used to sign short-lived OAuth `state` values, so
 * no second secret is needed.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
/** OAuth round-trips are interactive; 15 minutes is ample and short enough to matter. */
export const STATE_TTL_MS = 15 * 60_000;
/** Tolerate small clock skew when validating `state`. */
const STATE_SKEW_MS = 60_000;

export class SecretBox {
  readonly #key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64.trim(), 'base64');
    if (key.length !== 32) throw new Error('DOTY_CRED_KEY must be 32 bytes, base64-encoded');
    this.#key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(sealed: string): string {
    const [version, ivPart, tagPart, dataPart] = sealed.split('.');
    if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
      throw new Error('Unrecognized sealed value');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** OAuth `state`: base64url(JSON).base64url(HMAC-SHA256). Stateless and self-expiring. */
  signState(payload: Record<string, unknown>, now = Date.now()): string {
    const encoded = Buffer.from(JSON.stringify({ ...payload, ts: now }), 'utf8').toString('base64url');
    return `${encoded}.${this.#stateMac(encoded).toString('base64url')}`;
  }

  /** Returns the payload when the signature and expiry check out; otherwise `undefined`. */
  verifyState(token: string, now = Date.now()): Record<string, unknown> | undefined {
    const [encoded, macPart] = token.split('.');
    if (!encoded || !macPart) return undefined;
    const expected = this.#stateMac(encoded);
    const given = Buffer.from(macPart, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    if (!payload || typeof payload !== 'object') return undefined;
    const ts = (payload as { ts?: unknown }).ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined;
    if (now - ts > STATE_TTL_MS || ts - now > STATE_SKEW_MS) return undefined;
    return payload as Record<string, unknown>;
  }

  #stateMac(encoded: string): Buffer {
    return createHmac('sha256', this.#key).update(`doty-oauth-state.${encoded}`).digest();
  }
}

export function secretBoxFromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox | undefined {
  const value = env.DOTY_CRED_KEY?.trim();
  return value ? new SecretBox(value) : undefined;
}
