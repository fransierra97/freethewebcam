import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import type { Ctx } from './context.ts';
import { SESSION_COOKIE, sessionUser, UserError, type User } from './auth/users.ts';
import { ActionError } from './live/actions.ts';
import { ProviderError } from './providers/service.ts';
import { LedgerError } from './ledger/ledger.ts';
import { authRoutes } from './routes/auth.ts';
import { setupRoutes } from './routes/setup.ts';
import { publicRoutes } from './routes/public.ts';
import { apiRoutes } from './routes/api.ts';
import { wsRoutes } from './routes/ws.ts';
import { studioRoutes } from './routes/studio.ts';
import { adminRoutes } from './routes/admin.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { complianceRoutes } from './routes/compliance.ts';
import { legalRoutes } from './routes/legal.ts';
import { moderationRoutes } from './routes/moderation.ts';
import { mediaRoutes } from './routes/media.ts';
import { socialRoutes } from './routes/social.ts';
import { albumRoutes } from './routes/albums.ts';
import { go } from './web/respond.ts';
import { DEMO_COUNTRY_COOKIE } from './web/guards.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | undefined;
    country: string;
  }
}

const ROOT = join(import.meta.dirname, '..');

function detectCountry(ctx: Ctx, req: FastifyRequest): string {
  if (ctx.cfg.demo) {
    const forced = req.cookies[DEMO_COUNTRY_COOKIE];
    if (forced && /^[A-Z]{2}$/.test(forced)) return forced;
  }
  const raw = String(req.headers[ctx.cfg.geoHeader] ?? '').toUpperCase();
  if (/^[A-Z]{2}$/.test(raw) && raw !== 'XX' && raw !== 'T1') return raw;
  return ctx.cfg.defaultCountry;
}

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: ctx.cfg.trustProxy, bodyLimit: 1_000_000 });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 30 } });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  await app.register(fastifyStatic, { root: join(ROOT, 'public'), prefix: '/static/' });

  app.get('/vendor/hls.light.min.mjs', (_req, reply) => {
    reply.type('text/javascript').header('cache-control', 'public, max-age=86400');
    return reply.send(createReadStream(join(ROOT, 'node_modules/hls.js/dist/hls.light.min.mjs')));
  });

  app.get('/vendor/livekit-client.esm.mjs', (_req, reply) => {
    reply.type('text/javascript').header('cache-control', 'public, max-age=86400');
    return reply.send(createReadStream(join(ROOT, 'node_modules/livekit-client/dist/livekit-client.esm.mjs')));
  });

  app.decorateRequest('user', undefined);
  app.decorateRequest('country', '');

  app.addHook('onRequest', async (req, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {}
        if (host !== req.headers.host) return reply.code(403).send('Origen no permitido');
      }
    }
    req.user = await sessionUser(ctx.db, req.cookies[SESSION_COOKIE]);
    req.country = detectCountry(ctx, req);
    const { site } = await ctx.settings.get();
    const path = req.url.split('?')[0];
    if (!site.setupComplete && !path.startsWith('/setup') && !path.startsWith('/static/') && path !== '/healthz') {
      return reply.redirect('/setup', 303);
    }
  });

  const livekitOrigin = ctx.cfg.livekitUrl.replace(/^ws/, 'http');
  const livekitWs = ctx.cfg.livekitUrl;
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(self), microphone=(self)');
    reply.header(
      'content-security-policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        `connect-src 'self' ws: wss: ${livekitWs} ${livekitOrigin}`,
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join('; '),
    );
    return payload;
  });

  app.setErrorHandler((err: any, req, reply) => {
    const known = err instanceof ActionError || err instanceof UserError || err instanceof ProviderError || err instanceof LedgerError;
    if (!known && !err.validation) req.log.error(err);
    const status = known || err.validation ? 400 : (err.statusCode ?? 500);
    const message = known ? err.message : status >= 500 ? 'Error interno' : err.message;
    if (req.url.startsWith('/api/')) return reply.code(status).send({ error: message });
    let back = '/';
    try {
      if (req.headers.referer && new URL(req.headers.referer).host === req.headers.host) back = req.headers.referer;
    } catch {}
    if (req.method === 'POST') return go(reply, back, 'err', message);
    return reply.code(status).type('text/plain; charset=utf-8').send(message);
  });

  app.get('/healthz', async () => ({ ok: true }));

  await app.register(async (r) => setupRoutes(r, ctx));
  await app.register(async (r) => authRoutes(r, ctx));
  await app.register(async (r) => publicRoutes(r, ctx));
  await app.register(async (r) => apiRoutes(r, ctx));
  await app.register(async (r) => wsRoutes(r, ctx));
  await app.register(async (r) => studioRoutes(r, ctx));
  await app.register(async (r) => adminRoutes(r, ctx));
  await app.register(async (r) => webhookRoutes(r, ctx));
  await app.register(async (r) => complianceRoutes(r, ctx));
  await app.register(async (r) => legalRoutes(r, ctx));
  await app.register(async (r) => moderationRoutes(r, ctx));
  await app.register(async (r) => mediaRoutes(r, ctx));
  await app.register(async (r) => socialRoutes(r, ctx));
  await app.register(async (r) => albumRoutes(r, ctx));
  return app;
}

