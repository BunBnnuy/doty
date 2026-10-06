/**
 * `GET /` — the public landing page.
 *
 * A self-contained static page served from `public/index.html`, so the root of
 * the domain explains the project instead of returning a JSON 404. API routes
 * and the desktop client are unaffected.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const PAGE_PATH = fileURLToPath(new URL('../../public/index.html', import.meta.url));

/** Kept in code so the server still answers if the asset is missing. */
const FALLBACK = [
  '<!doctype html><meta charset="utf-8"><title>Doty</title>',
  '<body style="background:#0b0a14;color:#e8e6f5;font-family:system-ui;padding:40px">',
  '<h1>Doty</h1><p>An always-on AI assistant. ',
  '<a style="color:#a79cff" href="https://github.com/BunBnnuy/doty">Source</a></p>',
].join('');

function readPage(): string {
  try {
    return readFileSync(PAGE_PATH, 'utf8');
  } catch {
    // Never fail to boot over a missing marketing page.
    return FALLBACK;
  }
}

export function registerLandingRoutes(app: FastifyInstance): void {
  const page = readPage();
  app.get('/', async (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=300')
      .type('text/html; charset=utf-8')
      .send(page),
  );
}
