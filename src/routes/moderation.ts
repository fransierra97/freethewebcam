import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { needAdmin, needUser } from '../web/guards.ts';
import { audit, UserError } from '../auth/users.ts';
import { MAX_FRAME_BYTES, raiseIncident, readFrame, scanFrame, storeFrame } from '../moderation/frames.ts';
import { date, html } from '../web/html.ts';
import { field, go, page } from '../web/respond.ts';

const KIND: Record<string, string> = {
  hash_match: 'Match with known illegal material',
  classifier: 'Flagged by the automatic classifier',
  manual: 'Flagged by moderation',
};
const STATUS: Record<string, string> = { open: 'open', reported: 'reported', dismissed: 'dismissed' };

export async function moderationRoutes(app: FastifyInstance, ctx: Ctx) {
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: MAX_FRAME_BYTES }, (_req, body, done) => done(null, body));

  /** Frame sent by the creator's browser while broadcasting. */
  app.post('/api/moderation/frame', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!Buffer.isBuffer(req.body)) throw new UserError('Send the frame as image/jpeg.');
    const { compliance } = await ctx.settings.get();
    if (!compliance.frameIntervalSeconds) return { stored: false };
    // At most one per half interval.
    const last = await ctx.db.one<{ created_at: Date }>('select created_at from moderation_frames where creator_id = $1 order by id desc limit 1', [req.user.id]);
    if (last && Date.now() - new Date(last.created_at).getTime() < (compliance.frameIntervalSeconds * 1000) / 2) return { stored: false };
    const id = await storeFrame(ctx, req.user.id, req.body);
    // Scanning can take a while: it does not block the creator.
    scanFrame(ctx, id).catch((err) => req.log.error({ err }, 'scanFrame'));
    return { stored: true, id };
  });

  app.get('/admin/moderation', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const { compliance } = await ctx.settings.get();
    const incidents = await ctx.db.query(
      `select i.*, u.display_name from moderation_incidents i join users u on u.id = i.creator_id
       order by (i.status = 'open') desc, i.id desc limit 100`,
    );
    const live = await ctx.db.query(
      `select p.user_id, u.display_name, p.slug,
         (select max(created_at) from moderation_frames f where f.creator_id = p.user_id) as last_frame
       from creator_profiles p join users u on u.id = p.user_id where p.is_live order by u.display_name`,
    );
    const liveRows = [];
    for (const l of live as any[]) {
      const frames = await ctx.db.query<{ id: number; scan_status: string; created_at: Date }>(
        'select id, scan_status, created_at from moderation_frames where creator_id = $1 and file is not null order by id desc limit 6',
        [l.user_id],
      );
      const stale = compliance.frameIntervalSeconds && (!l.last_frame || Date.now() - new Date(l.last_frame).getTime() > compliance.frameIntervalSeconds * 3000);
      liveRows.push(html`<section><h3><a href="/c/${l.slug}">${l.display_name}</a> — last frame: ${date(l.last_frame)}
          ${stale ? html` <strong>⚠ no frames arriving</strong>` : ''}</h3>
        <p>${frames.map(
          (f) => html`<a href="/admin/moderation/frames/${f.id}" target="_blank"><img src="/admin/moderation/frames/${f.id}" width="160" alt="Frame ${f.id} (${f.scan_status})"></a> `,
        )}</p>
        ${frames[0]
          ? html`<form method="post" action="/admin/moderation/frames/${frames[0].id}/flag" style="display:inline">
              <input name="detail" placeholder="Reason" required> <button>Flag and cut</button></form>
            ${ctx.cfg.demo ? html`<form method="post" action="/admin/moderation/frames/${frames[0].id}/simulate" style="display:inline"><button>Demo: simulate match</button></form>` : ''}`
          : ''}
      </section>`);
    }
    return page(
      ctx,
      req,
      reply,
      'Moderation',
      html`<p><a href="/admin">← Admin</a> · Detector: <a href="/admin/providers">Providers</a> (Hive or your own connector) · Frequency and retention: <a href="/admin/compliance">Compliance</a></p>
      <p><small>One frame every ${compliance.frameIntervalSeconds || '—'} s during live broadcasts; with no incidents they are deleted after ${compliance.frameRetentionDays} days. Viewing a frame is logged.</small></p>
      <h2>Cases</h2>
      ${incidents.length
        ? html`<table><tr><th>#</th><th>Date</th><th>Creator</th><th>Type</th><th>Status</th><th></th></tr>
          ${incidents.map(
            (i: any) => html`<tr><td>${i.id}</td><td>${date(i.created_at)}</td><td>${i.display_name}</td><td>${KIND[i.kind]}</td>
              <td>${i.status === 'open' ? html`<strong>${STATUS[i.status]}</strong>` : STATUS[i.status]}</td><td><a href="/admin/moderation/incidents/${i.id}">Open</a></td></tr>`,
          )}</table>`
        : html`<p>None.</p>`}
      <h2>Live now</h2>
      ${liveRows.length ? liveRows : html`<p>Nobody is broadcasting.</p>`}`,
    );
  });

  app.get('/admin/moderation/frames/:id', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const f = await ctx.db.one<{ file: string | null }>('select file from moderation_frames where id = $1', [Number((req.params as any).id)]);
    if (!f?.file) return reply.code(404).send('Not found or already deleted');
    await audit(ctx.db, req.user.id, 'moderation.view_frame', { frameId: Number((req.params as any).id) });
    return reply.type('image/jpeg').header('cache-control', 'no-store').send(readFrame(ctx, f.file));
  });

  app.post('/admin/moderation/frames/:id/flag', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const f = await ctx.db.one<{ id: number; creator_id: number }>('select id, creator_id from moderation_frames where id = $1', [Number((req.params as any).id)]);
    if (!f) return reply.code(404).send('Not found');
    const id = await raiseIncident(ctx, f.creator_id, f.id, 'manual', field(req.body, 'detail'), req.user.id);
    return go(reply, `/admin/moderation/incidents/${id}`, 'ok', 'Stream cut, creator suspended and case opened.');
  });

  app.post('/admin/moderation/frames/:id/simulate', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    if (!ctx.cfg.demo) return reply.code(404).send('Not found');
    const f = await ctx.db.one<{ id: number; creator_id: number }>('select id, creator_id from moderation_frames where id = $1', [Number((req.params as any).id)]);
    if (!f) return reply.code(404).send('Not found');
    await ctx.db.query("update moderation_frames set scan_status = 'match', scanner = 'demo', scan_detail = 'SIMULATED match (demo)' where id = $1", [f.id]);
    const id = await raiseIncident(ctx, f.creator_id, f.id, 'hash_match', 'SIMULATED match in demo mode', req.user.id);
    return go(reply, `/admin/moderation/incidents/${id}`, 'ok', 'Simulation: this is how the platform reacts to a match.');
  });

  app.get('/admin/moderation/incidents/:id', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const i = await ctx.db.one(
      `select i.*, u.display_name, u.email, u.created_at as user_created from moderation_incidents i join users u on u.id = i.creator_id where i.id = $1`,
      [Number((req.params as any).id)],
    );
    if (!i) return reply.code(404).send('Not found');
    const frame = i.frame_id ? await ctx.db.one('select * from moderation_frames where id = $1', [i.frame_id]) : null;
    const session = frame?.session_id ? await ctx.db.one('select * from broadcast_sessions where id = $1', [frame.session_id]) : null;
    const frames = session
      ? await ctx.db.query('select id, created_at, scan_status, file from moderation_frames where session_id = $1 order by id', [session.id])
      : frame
        ? [frame]
        : [];
    return page(
      ctx,
      req,
      reply,
      `Case #${i.id}: ${KIND[i.kind]}`,
      html`<p><a href="/admin/moderation">← Moderation</a></p>
      <ul>
        <li>Status: <strong>${STATUS[i.status]}</strong>${i.external_report_id ? html` · report ${i.external_report_id}` : ''}${i.resolution ? html` · ${i.resolution}` : ''}</li>
        <li>Creator: ${i.display_name} (user #${i.creator_id}, ${i.email}, joined ${date(i.user_created)})</li>
        <li>Detail: ${i.detail}</li>
        <li>Opened: ${date(i.created_at)}</li>
        ${session ? html`<li>Broadcast #${session.id}: ${date(session.started_at)} – ${date(session.ended_at)} · ${session.title}</li>` : ''}
      </ul>
      <p><strong>Already done:</strong> stream cut${i.kind !== 'classifier' ? ', creator suspended' : ''} and evidence kept for 1 year.</p>
      <h2>Frames from the broadcast</h2>
      <p>${frames.filter((f: any) => f.file).map(
        (f: any) => html`<a href="/admin/moderation/frames/${f.id}" target="_blank"><img src="/admin/moderation/frames/${f.id}" width="160" alt="${f.scan_status} ${date(f.created_at)}"></a> `,
      )}</p>
      <h2>If it is child sexual abuse material</h2>
      <p>In the US, the law (18 U.S.C. 2258A) requires reporting it to NCMEC as soon as you become aware of it. Do so at
        <a href="https://report.cybertip.org/" target="_blank" rel="noopener">report.cybertip.org</a> (or, if you are registered as a provider, through their API) and include the details above and the frames.
        In other countries, report it to the police or the national hotline (INHOPE network). Do not share the material with anyone else.</p>
      ${i.status === 'open'
        ? html`<form method="post" action="/admin/moderation/incidents/${i.id}">
            <label>Report number (if you filed one) <input name="externalId"></label><br>
            <label>What was done <input name="resolution" required size="60"></label><br>
            <button name="action" value="reported">Mark as reported</button>
            <button name="action" value="dismissed">Dismiss (false positive)</button>
          </form>
          <p><small>Dismissing does not reinstate the creator: do that in <a href="/admin/creators">Creators</a> if appropriate.</small></p>`
        : ''}`,
    );
  });

  app.post('/admin/moderation/incidents/:id', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as any).id);
    const action = field(req.body, 'action') === 'reported' ? 'reported' : 'dismissed';
    const resolution = field(req.body, 'resolution').trim().slice(0, 500);
    if (!resolution) throw new UserError('Explain what was done.');
    await ctx.db.query(
      "update moderation_incidents set status = $2, external_report_id = nullif($3, ''), resolution = $4, resolved_at = now(), resolved_by = $5 where id = $1 and status = 'open'",
      [id, action, field(req.body, 'externalId').trim().slice(0, 100), resolution, req.user.id],
    );
    if (action === 'dismissed') {
      // A false positive no longer needs to be kept for a year.
      await ctx.db.query(
        `update moderation_frames set retain_until = null where id in (
           select f.id from moderation_frames f join moderation_incidents i on i.id = $1
           where f.id = i.frame_id or f.session_id = (select session_id from moderation_frames where id = i.frame_id))`,
        [id],
      );
    }
    await audit(ctx.db, req.user.id, `moderation.incident.${action}`, { incidentId: id });
    return go(reply, `/admin/moderation/incidents/${id}`, 'ok', 'Case closed.');
  });
}
