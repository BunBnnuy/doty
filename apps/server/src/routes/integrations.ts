/**
 * Email integration routes.
 *
 * - `GET    /integrations`                     → connected accounts + provider status (guarded)
 * - `POST   /integrations/:provider/connect`   → signed authorize URL (guarded)
 * - `GET    /integrations/:provider/callback`  → browser redirect target (public, state-verified)
 * - `DELETE /integrations/:target`             → disconnect an account id or provider (guarded)
 * - `GET    /email/list`                       → message summaries (guarded)
 * - `GET    /email/read`                       → one message body (guarded)
 *
 * Multiple accounts per provider are supported: `account` (an email address or
 * integration id) selects the mailbox; with a single connected account it can
 * be omitted. The callback is the only public route — a top-level browser
 * navigation cannot carry the bearer token, so it relies on the HMAC-signed
 * `state` produced by `connect`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { EventLog } from '../events/log.js';
import {
  AmbiguousAccountError,
  InvalidStateError,
  NotConfiguredError,
  NotConnectedError,
} from '../integrations/email/service.js';
import {
  isEmailProvider,
  type EmailMessage,
  type EmailProvider,
  type EmailSelector,
  type EmailSummary,
  type IntegrationOverview,
} from '../integrations/email/types.js';

/** Structural contract so routes stay testable without a real service. */
export interface IntegrationRoutesService {
  statuses(): Promise<IntegrationOverview>;
  connectUrl(provider: EmailProvider): string;
  handleCallback(
    provider: EmailProvider,
    code: string,
    state: string,
  ): Promise<{ account?: string; id?: string }>;
  disconnect(target: string): Promise<boolean>;
  list(selector: EmailSelector, options: { query?: string; limit: number }): Promise<EmailSummary[]>;
  read(selector: EmailSelector, id: string): Promise<EmailMessage>;
}

const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  /** Microsoft appends this when an admin finishes the /adminconsent flow. */
  admin_consent: z.string().optional(),
});

const listQuerySchema = z.object({
  provider: z.string().optional(),
  account: z.string().min(1).max(320).optional(),
  query: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(25).optional(),
});

const readQuerySchema = z.object({
  provider: z.string().optional(),
  account: z.string().min(1).max(320).optional(),
  id: z.string().min(1).max(1_024),
});

export function registerIntegrationRoutes(
  app: FastifyInstance,
  service: IntegrationRoutesService,
  log?: EventLog,
): void {
  app.get('/integrations', async () => service.statuses());

  app.post('/integrations/:provider/connect', async (request, reply) => {
    const provider = readProvider(request.params);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
    try {
      return { url: service.connectUrl(provider) };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get('/integrations/:provider/callback', async (request, reply) => {
    const provider = readProvider(request.params);
    const query = callbackQuerySchema.safeParse(request.query);
    if (!provider || !query.success) {
      return sendPage(reply, 400, 'Enlace inválido', 'El enlace de conexión no es válido.');
    }
    if (query.data.admin_consent?.toLowerCase() === 'true') {
      return sendPage(
        reply,
        200,
        'Consentimiento concedido',
        'Un administrador de tu organización autorizó a Doty. Ya puedes conectar tu cuenta desde Doty.',
      );
    }
    if (query.data.error) {
      return sendPage(
        reply,
        400,
        'Autorización rechazada',
        'No se otorgó el permiso solicitado en el proveedor. Puedes intentarlo de nuevo.',
      );
    }
    const { code, state } = query.data;
    if (!code || !state) {
      return sendPage(reply, 400, 'Enlace inválido', 'Falta el código de autorización.');
    }
    try {
      const { account } = await service.handleCallback(provider, code, state);
      log?.append({
        type: 'integration_connected',
        data: { provider, ...(account ? { account } : {}) },
      });
      return sendPage(
        reply,
        200,
        'Cuenta conectada',
        account
          ? `La cuenta ${escapeHtml(account)} quedó conectada a Doty.`
          : 'La cuenta quedó conectada a Doty.',
      );
    } catch (error) {
      const detail =
        error instanceof InvalidStateError
          ? 'El enlace expiró o no es válido. Genera uno nuevo desde Doty.'
          : 'No se pudo completar la conexión. Revisa los registros del servidor.';
      return sendPage(reply, 400, 'No se pudo conectar', detail);
    }
  });

  app.delete('/integrations/:target', async (request, reply) => {
    const target = readTarget(request.params);
    if (!target) return reply.code(404).send({ error: 'unknown_target' });
    try {
      const removed = await service.disconnect(target);
      if (removed) log?.append({ type: 'integration_disconnected', data: { target } });
      return { ok: true, removed };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get('/email/list', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const selector = readSelector(reply, parsed.data.provider, parsed.data.account);
    if (selector === INVALID) return;
    try {
      return {
        messages: await service.list(selector, {
          ...(parsed.data.query ? { query: parsed.data.query } : {}),
          limit: parsed.data.limit ?? 10,
        }),
      };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get('/email/read', async (request, reply) => {
    const parsed = readQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const selector = readSelector(reply, parsed.data.provider, parsed.data.account);
    if (selector === INVALID) return;
    try {
      return { message: await service.read(selector, parsed.data.id) };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });
}

/** Sentinel so a failed selector parse short-circuits without extra types. */
const INVALID = Symbol('invalid');

function readProvider(params: unknown): EmailProvider | undefined {
  const value = (params as { provider?: unknown })?.provider;
  return isEmailProvider(value) ? value : undefined;
}

function readTarget(params: unknown): string | undefined {
  const value = (params as { target?: unknown })?.target;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readSelector(
  reply: FastifyReply,
  rawProvider: string | undefined,
  rawAccount: string | undefined,
): EmailSelector | typeof INVALID {
  const selector: EmailSelector = {};
  if (rawProvider !== undefined) {
    if (!isEmailProvider(rawProvider)) {
      void reply.code(400).send({ error: 'invalid_provider' });
      return INVALID;
    }
    selector.provider = rawProvider;
  }
  if (rawAccount !== undefined) selector.account = rawAccount;
  return selector;
}

function sendServiceError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof NotConfiguredError) {
    return reply.code(503).send({ error: error.code, message: error.message });
  }
  if (error instanceof NotConnectedError) {
    return reply.code(409).send({ error: error.code, message: error.message });
  }
  if (error instanceof AmbiguousAccountError) {
    return reply
      .code(409)
      .send({ error: error.code, message: error.message, accounts: error.accounts });
  }
  throw error;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[character] ?? character;
  });
}

function sendPage(reply: FastifyReply, status: number, title: string, detail: string): FastifyReply {
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Doty</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0b0a14; color: #e8e6f5; font-family: system-ui, sans-serif; }
  main { max-width: 30rem; padding: 2.5rem; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p { margin: 0; color: #b9b4d6; line-height: 1.5; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${detail}</p></main></body>
</html>`;
  return reply.code(status).type('text/html; charset=utf-8').send(html);
}
