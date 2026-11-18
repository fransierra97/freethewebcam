import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '../auth/users.ts';
import { go } from './respond.ts';

export const DEMO_COUNTRY_COOKIE = 'ftw_country';

// ---- Reusable guards ----

export function needUser(req: FastifyRequest, reply: FastifyReply): req is FastifyRequest & { user: User } {
  if (req.user) return true;
  if (req.url.startsWith('/api/')) reply.code(401).send({ error: 'Log in.' });
  else go(reply, `/login?next=${encodeURIComponent(req.url)}`);
  return false;
}

export function needAdmin(req: FastifyRequest, reply: FastifyReply): req is FastifyRequest & { user: User } {
  if (!needUser(req, reply)) return false;
  if (req.user!.is_admin) return true;
  if (req.url.startsWith('/api/')) reply.code(403).send({ error: 'Admins only.' });
  else reply.code(403).type('text/plain; charset=utf-8').send('Admins only.');
  return false;
}

export function needCreator(req: FastifyRequest, reply: FastifyReply): req is FastifyRequest & { user: User } {
  if (!needUser(req, reply)) return false;
  if (req.user!.creator_status !== 'none') return true;
  go(reply, '/become-creator');
  return false;
}
