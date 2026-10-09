import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { constantTimeTokenMatch } from '../app.js';
import { browserAction, type BrowserWorkspace } from '../browser/workspace.js';

export function registerBrowserRoutes(app: FastifyInstance, workspace: BrowserWorkspace | undefined, token: string | undefined): void {
  app.get('/browser', async (_req, reply) => reply.type('text/html').header('cache-control', 'no-store')
    .header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    .send(readFileSync(new URL('../../public/browser.html', import.meta.url), 'utf8')));
  void app.register(async (privateApp) => {
    privateApp.addHook('onRequest', async (req, reply) => {
      const bearer = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!token || !bearer || !constantTimeTokenMatch(bearer, token)) return reply.code(401).send({ error: 'unauthorized' });
      reply.header('cache-control', 'no-store');
      if (!workspace) return reply.code(503).send({ error: 'browser_disabled' });
    });
    privateApp.get('/browser/status', async () => workspace!.status());
    privateApp.get('/browser/screenshot', async (_req, reply) => {
      try { return reply.type('image/png').send(await workspace!.screenshot()); }
      catch { return reply.code(503).send({ error: 'browser_unavailable' }); }
    });
    privateApp.post('/browser/action', async (req, reply) => {
      const parsed = browserAction.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_action' });
      try { await workspace!.manual(parsed.data); return { ok: true }; }
      catch { return reply.code(409).send({ error: 'take_control_or_wait' }); }
    });
    privateApp.post('/browser/control', async () => { workspace!.takeControl(); return { ok: true }; });
    privateApp.post('/browser/approve', async (_req, reply) => {
      try { workspace!.approve(); return { ok: true }; }
      catch { return reply.code(409).send({ error: 'no_pending_action' }); }
    });
    privateApp.post('/browser/run', async (req, reply) => {
      const body = z.object({ task: z.string().trim().min(1).max(4000) }).strict().safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_task' });
      try { workspace!.start(body.data.task); return reply.code(202).send({ ok: true }); }
      catch { return reply.code(409).send({ error: 'browser_busy_or_ai_unavailable' }); }
    });
  });
  if (workspace) app.addHook('onClose', async () => workspace.close());
}
