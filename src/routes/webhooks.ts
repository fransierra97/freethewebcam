import { parse as parseQuery } from 'node:querystring';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { handleWebhook } from '../providers/webhooks.ts';
import { handleLivekitWebhook } from './media.ts';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Provider webhooks. Keeps the raw body: some signatures are computed over it. */
export async function webhookRoutes(app: FastifyInstance, ctx: Ctx) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 1_000_000 }, (req: FastifyRequest, body: string | Buffer, done) => {
    const text = body.toString();
    req.rawBody = text;
    const type = String(req.headers['content-type'] ?? '');
    try {
      if (type.includes('json')) done(null, text ? JSON.parse(text) : {});
      else if (type.includes('x-www-form-urlencoded')) done(null, { ...parseQuery(text) });
      else done(null, {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as { provider: string; '*'?: string };
    if (params.provider === 'livekit') {
      const r = await handleLivekitWebhook(ctx, req.rawBody ?? '', String(req.headers.authorization ?? ''));
      return reply.code(r.status).type('text/plain').send(r.body);
    }
    const result = await handleWebhook(ctx, params.provider, {
      headers: req.headers,
      rawBody: req.rawBody ?? '',
      body: req.body,
      query: req.query as Record<string, string>,
      ip: req.ip,
      subpath: params['*'] ?? '',
    });
    return reply.code(result.status).type(result.contentType ?? 'text/plain').send(result.body);
  };
  app.post('/webhooks/:provider', handler);
  app.post('/webhooks/:provider/*', handler);
}
