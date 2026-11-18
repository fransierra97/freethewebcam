import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { balance } from '../ledger/ledger.ts';
import type { Raw } from './html.ts';
import { renderPage } from './layout.ts';
import { unreadCounts } from '../notify/notify.ts';
import { isAgeRestricted } from '../settings.ts';

const FLASH = 'ftw_flash';

export function flash(reply: FastifyReply, kind: 'ok' | 'err', message: string): void {
  reply.setCookie(FLASH, JSON.stringify({ [kind]: message }), { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 });
}

export function go(reply: FastifyReply, url: string, kind?: 'ok' | 'err', message?: string) {
  if (kind && message) flash(reply, kind, message);
  return reply.redirect(url, 303);
}

export async function page(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  title: string,
  body: Raw,
  opts: { scripts?: string[]; status?: number; hideTitle?: boolean; mainClass?: string } = {},
) {
  let messages: { ok?: string; err?: string } = {};
  const raw = req.cookies[FLASH];
  if (raw) {
    try {
      messages = JSON.parse(raw);
    } catch {}
    reply.clearCookie(FLASH, { path: '/' });
  }
  const { site, compliance } = await ctx.settings.get();
  const bal = req.user ? await balance(ctx.db, 'wallet', req.user.id) : undefined;
  const unread = req.user ? await unreadCounts(ctx, req.user.id) : undefined;
  return reply
    .code(opts.status ?? 200)
    .type('text/html; charset=utf-8')
    .send(
      renderPage({
        siteName: site.name,
        title,
        body,
        user: req.user,
        balance: bal,
        ok: messages.ok,
        err: messages.err,
        demo: ctx.cfg.demo,
        scripts: opts.scripts,
        show2257: compliance.require2257,
        path: req.url.split('?')[0],
        brandColor: site.brandColor,
        unread,
        ageRestricted: isAgeRestricted(site),
        hideTitle: opts.hideTitle,
        mainClass: opts.mainClass,
      }),
    );
}

/** Reads a form field as text. */
export function field(body: unknown, name: string): string {
  const v = (body as Record<string, unknown> | undefined)?.[name];
  if (Array.isArray(v)) return String(v[0] ?? '');
  return v === undefined || v === null ? '' : String(v);
}

export function fields(body: unknown, name: string): string[] {
  const v = (body as Record<string, unknown> | undefined)?.[name];
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

export function intField(body: unknown, name: string): number {
  const n = Number(field(body, name));
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}
