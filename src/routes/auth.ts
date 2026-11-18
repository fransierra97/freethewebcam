import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { verifyPassword } from '../auth/password.ts';
import {
  createSession,
  createUser,
  destroySession,
  findUserByEmail,
  SESSION_COOKIE,
  UserError,
} from '../auth/users.ts';
import { html } from '../web/html.ts';
import { isAgeRestricted } from '../settings.ts';
import { field, go, page } from '../web/respond.ts';

export function sessionCookie(ctx: Ctx) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.cfg.publicUrl.startsWith('https://'),
    maxAge: 60 * 60 * 24 * 30,
  };
}

/** Internal redirects only, to avoid open redirects. */
function safeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

// Simple per-IP limit on login attempts (in memory).
const attempts = new Map<string, { count: number; until: number }>();
function tooMany(ip: string): boolean {
  const a = attempts.get(ip);
  return Boolean(a && a.count >= 10 && a.until > Date.now());
}
function fail(ip: string) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { count: 1, until: Date.now() + 15 * 60_000 });
  else a.count++;
}

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/register', async (req, reply) => {
    if (req.user) return go(reply, '/');
    const restricted = isAgeRestricted((await ctx.settings.get()).site);
    return page(
      ctx,
      req,
      reply,
      'Create account',
      html`<form method="post" action="/register">
        <label>Email <input type="email" name="email" required></label><br>
        <label>Public name <input name="displayName" required minlength="3" maxlength="24"></label><br>
        <label>Password <input type="password" name="password" required minlength="8"></label><br>
        <label><input type="checkbox" name="adult" value="1" required> ${restricted ? 'I am 18 or older and accept' : 'I accept'} the <a href="/legal/terms" target="_blank">terms</a>, the <a href="/legal/privacy" target="_blank">privacy policy</a> and the <a href="/legal/rules" target="_blank">rules</a></label><br>
        <button>Create account</button>
      </form>
      <p>Already have an account? <a href="/login">Log in</a>.</p>`,
      { mainClass: 'auth' },
    );
  });

  app.post('/register', async (req, reply) => {
    const b = req.body;
    if (field(b, 'adult') !== '1') return go(reply, '/register', 'err', 'You must accept the terms.');
    try {
      const user = await createUser(ctx.db, {
        email: field(b, 'email'),
        displayName: field(b, 'displayName'),
        password: field(b, 'password'),
      });
      reply.setCookie(SESSION_COOKIE, await createSession(ctx.db, user.id), sessionCookie(ctx));
      return go(reply, '/', 'ok', 'Account created.');
    } catch (err) {
      if (err instanceof UserError) return go(reply, '/register', 'err', err.message);
      throw err;
    }
  });

  app.get('/login', async (req, reply) => {
    const next = safeNext(String((req.query as any).next ?? '/'));
    if (req.user) return go(reply, next);
    return page(
      ctx,
      req,
      reply,
      'Log in',
      html`<form method="post" action="/login">
        <input type="hidden" name="next" value="${next}">
        <label>Email <input type="email" name="email" required></label><br>
        <label>Password <input type="password" name="password" required></label><br>
        <button>Log in</button>
      </form>
      <p>Don't have an account? <a href="/register">Create one</a>.</p>`,
      { mainClass: 'auth' },
    );
  });

  app.post('/login', async (req, reply) => {
    const b = req.body;
    const next = safeNext(field(b, 'next') || '/');
    if (tooMany(req.ip)) return go(reply, '/login', 'err', 'Too many attempts. Wait a few minutes.');
    const user = await findUserByEmail(ctx.db, field(b, 'email'));
    if (!user || !(await verifyPassword(field(b, 'password'), user.password_hash))) {
      fail(req.ip);
      return go(reply, `/login?next=${encodeURIComponent(next)}`, 'err', 'Incorrect email or password.');
    }
    if (user.status === 'banned') return go(reply, '/login', 'err', 'This account is suspended.');
    attempts.delete(req.ip);
    reply.setCookie(SESSION_COOKIE, await createSession(ctx.db, user.id), sessionCookie(ctx));
    return go(reply, next);
  });

  app.post('/logout', async (req, reply) => {
    await destroySession(ctx.db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return go(reply, '/');
  });
}
