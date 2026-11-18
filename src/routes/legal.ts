import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { needAdmin } from '../web/guards.ts';
import { audit, UserError } from '../auth/users.ts';
import { html } from '../web/html.ts';
import { LEGAL_PAGES, fillPlaceholders, legalSource, legalTemplate, renderLegal } from '../web/legal.ts';
import { field, go, page } from '../web/respond.ts';

export async function legalRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/legal/:slug', async (req, reply) => {
    const meta = LEGAL_PAGES.find((p) => p.slug === (req.params as any).slug);
    if (!meta) return reply.code(404).send('Not found');
    const text = await fillPlaceholders(ctx, await legalSource(ctx, meta.slug));
    return page(ctx, req, reply, meta.title, renderLegal(text.replace(/^# [^\n]*\n/, '')));
  });

  app.get('/admin/legal', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const rows = await ctx.db.query<{ slug: string; updated_at: Date }>('select slug, updated_at from legal_pages');
    return page(
      ctx,
      req,
      reply,
      'Legal pages',
      html`<p><a href="/admin">← Admin</a> · Operator details are filled in from <a href="/admin/compliance">Compliance</a>.</p>
      <p><small>These are templates: have a lawyer in your country review them before opening the site. Format: “# title”, “- item”, “> note”, paragraphs separated by a blank line. Variables: {{site}}, {{operator}}, {{address}}, {{email}}.</small></p>
      <ul>${LEGAL_PAGES.map((p) => {
        const edited = rows.find((r) => r.slug === p.slug);
        return html`<li><a href="/admin/legal/${p.slug}">${p.title}</a> — ${edited ? 'edited' : 'original template'} · <a href="/legal/${p.slug}">view</a></li>`;
      })}</ul>`,
    );
  });

  app.get('/admin/legal/:slug', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const meta = LEGAL_PAGES.find((p) => p.slug === (req.params as any).slug);
    if (!meta) return reply.code(404).send('Not found');
    return page(
      ctx,
      req,
      reply,
      `Edit: ${meta.title}`,
      html`<p><a href="/admin/legal">← Legal pages</a></p>
      <form method="post" action="/admin/legal/${meta.slug}">
        <textarea name="body" rows="30" cols="100">${await legalSource(ctx, meta.slug)}</textarea><br>
        <button>Save</button>
      </form>
      <form method="post" action="/admin/legal/${meta.slug}/reset"><button>Restore the original template</button></form>`,
    );
  });

  app.post('/admin/legal/:slug', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const meta = LEGAL_PAGES.find((p) => p.slug === (req.params as any).slug);
    if (!meta) return reply.code(404).send('Not found');
    const body = field(req.body, 'body');
    if (!body.trim()) throw new UserError('The text cannot be empty.');
    if (body.length > 100_000) throw new UserError('Text too long.');
    await ctx.db.query(
      `insert into legal_pages (slug, body, updated_by) values ($1, $2, $3)
       on conflict (slug) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = now()`,
      [meta.slug, body, req.user.id],
    );
    await audit(ctx.db, req.user.id, 'legal.update', { slug: meta.slug });
    return go(reply, `/admin/legal/${meta.slug}`, 'ok', 'Saved.');
  });

  app.post('/admin/legal/:slug/reset', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const slug = (req.params as any).slug;
    if (!LEGAL_PAGES.some((p) => p.slug === slug)) return reply.code(404).send('Not found');
    legalTemplate(slug);
    await ctx.db.query('delete from legal_pages where slug = $1', [slug]);
    await audit(ctx.db, req.user.id, 'legal.reset', { slug });
    return go(reply, `/admin/legal/${slug}`, 'ok', 'Original template restored.');
  });
}
