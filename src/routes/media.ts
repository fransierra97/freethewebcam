import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebhookReceiver } from 'livekit-server-sdk';
import type { Ctx } from '../context.ts';
import { needAdmin, needCreator, needUser } from '../web/guards.ts';
import { viewerAccess } from '../access.ts';
import { audit, UserError } from '../auth/users.ts';
import { isBanned } from '../live/actions.ts';
import { endLive } from '../live/lifecycle.ts';
import { publicRoom } from '../live/livekit.ts';
import { decryptJson, encryptJson } from '../providers/secrets.ts';
import { html } from '../web/html.ts';
import { field, go, page } from '../web/respond.ts';

const INGRESS_PURPOSE = 'ingress-key';
const HLS_TYPES: Record<string, string> = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', m4s: 'video/iso.segment', mp4: 'video/mp4' };
const OBS_GRACE_MS = 120_000;
const obsTimers = new Map<number, NodeJS.Timeout>();

/** Resolves a path inside the media folder without allowing escape from it. */
export function mediaPath(ctx: Ctx, rel: string): string | null {
  const full = normalize(join(ctx.cfg.mediaDir, rel));
  return full.startsWith(normalize(ctx.cfg.mediaDir) + '/') ? full : null;
}

/** Signed LiveKit webhooks: OBS status and end of recordings. */
export async function handleLivekitWebhook(ctx: Ctx, rawBody: string, auth: string): Promise<{ status: number; body: string }> {
  let event;
  try {
    event = await new WebhookReceiver(ctx.cfg.livekitApiKey, ctx.cfg.livekitApiSecret).receive(rawBody, auth);
  } catch {
    return { status: 401, body: 'rejected' };
  }
  const room = event.ingressInfo?.roomName ?? event.room?.name ?? '';
  const creatorId = Number(/^public-(\d+)$/.exec(room)?.[1]);
  if (event.event === 'ingress_started' && creatorId) {
    clearTimeout(obsTimers.get(creatorId));
    obsTimers.delete(creatorId);
  }
  if (event.event === 'ingress_ended' && creatorId) {
    const c = await ctx.db.one<{ is_live: boolean; broadcast_mode: string }>('select is_live, broadcast_mode from creator_profiles where user_id = $1', [creatorId]);
    if (c?.is_live && c.broadcast_mode === 'obs') {
      ctx.hub.broadcast(creatorId, { type: 'system', text: 'The OBS signal was lost. Waiting for it to return…' });
      clearTimeout(obsTimers.get(creatorId));
      const t = setTimeout(() => {
        obsTimers.delete(creatorId);
        endLive(ctx, creatorId, 'OBS signal lost').catch((err) => console.error('endLive', err));
      }, OBS_GRACE_MS);
      t.unref();
      obsTimers.set(creatorId, t);
    }
  }
  if (event.event === 'egress_ended') {
    await audit(ctx.db, null, 'egress.ended', { egressId: event.egressInfo?.egressId, status: event.egressInfo?.status, error: event.egressInfo?.error });
  }
  return { status: 200, body: 'ok' };
}

export async function mediaRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- OBS ----
  app.get('/studio/obs', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    if (!ctx.cfg.ingressEnabled) {
      return page(ctx, req, reply, 'Broadcast from OBS', html`<p><a href="/studio">← Studio</a></p>
        <p>This server does not have the OBS service (LiveKit Ingress) enabled. Ask your admin: it is enabled with <code>./ftw enable obs</code>.</p>`);
    }
    const p = await ctx.db.one<{ ingress_url: string | null; ingress_key_enc: string | null }>(
      'select ingress_url, ingress_key_enc from creator_profiles where user_id = $1',
      [req.user.id],
    );
    const key = p?.ingress_key_enc ? decryptJson<string>(ctx.cfg.appSecret, p.ingress_key_enc, INGRESS_PURPOSE) : null;
    return page(
      ctx,
      req,
      reply,
      'Broadcast from OBS',
      html`<p><a href="/studio">← Studio</a></p>
      ${key
        ? html`<p>In OBS → Settings → Stream, choose “Custom” and paste:</p>
          <ul><li>Server: <code>${p!.ingress_url}</code></li>
          <li><details><summary>Stream key (do not share it)</summary><code>${key}</code></details></li></ul>
          <p>Then, in <a href="/studio/live">Broadcast</a>, choose “OBS”, click “Go live” and then “Start Streaming” in OBS.</p>
          <p><small>Private shows are not available from OBS: they require the browser camera.</small></p>
          <form method="post" action="/studio/obs/create"><input type="hidden" name="kind" value="rtmp"><button>Generate a new key</button> <small>(the old one stops working)</small></form>
          <form method="post" action="/studio/obs/delete"><button>Delete my key</button></form>`
        : html`<p>Create your key to broadcast from OBS or another RTMP- or WHIP-compatible program.</p>
          <form method="post" action="/studio/obs/create">
            <label><input type="radio" name="kind" value="rtmp" checked> RTMP (works with everything)</label>
            <label><input type="radio" name="kind" value="whip"> WHIP (lower latency; OBS 30 or later)</label>
            <button>Create key</button>
          </form>`}`,
    );
  });

  app.post('/studio/obs/create', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    if (!ctx.cfg.ingressEnabled) throw new UserError('OBS is not enabled on this server.');
    const old = await ctx.db.one<{ ingress_id: string | null }>('select ingress_id from creator_profiles where user_id = $1', [req.user.id]);
    if (old?.ingress_id) await ctx.media.deleteIngress(old.ingress_id).catch(() => undefined);
    const kind = field(req.body, 'kind') === 'whip' ? 'whip' : 'rtmp';
    const r = await ctx.media.createIngress({ roomName: publicRoom(req.user.id), identity: `u${req.user.id}-obs`, name: req.user.display_name, kind });
    await ctx.db.query('update creator_profiles set ingress_id = $2, ingress_url = $3, ingress_key_enc = $4 where user_id = $1', [
      req.user.id,
      r.ingressId,
      r.url,
      encryptJson(ctx.cfg.appSecret, r.streamKey, INGRESS_PURPOSE),
    ]);
    await audit(ctx.db, req.user.id, 'obs.create', { kind });
    return go(reply, '/studio/obs', 'ok', 'Key created.');
  });

  app.post('/studio/obs/delete', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const old = await ctx.db.one<{ ingress_id: string | null }>('select ingress_id from creator_profiles where user_id = $1', [req.user.id]);
    if (old?.ingress_id) await ctx.media.deleteIngress(old.ingress_id).catch(() => undefined);
    await ctx.db.query('update creator_profiles set ingress_id = null, ingress_url = null, ingress_key_enc = null where user_id = $1', [req.user.id]);
    await audit(ctx.db, req.user.id, 'obs.delete');
    return go(reply, '/studio/obs', 'ok', 'Key deleted.');
  });

  // ---- HLS (light mode for viewers) ----
  app.get('/hls/:creatorId/:sessionId/:file', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const { creatorId, sessionId, file } = req.params as Record<string, string>;
    const ext = /^[\w.-]+\.(m3u8|ts|m4s|mp4)$/.exec(file)?.[1];
    if (!ext) return reply.code(404).send('Not found');
    if (!(await viewerAccess(ctx, req.user, req.country)).ok && req.user.id !== Number(creatorId)) return reply.code(403).send('Verify your age');
    if (await isBanned(ctx.db, Number(creatorId), req.user.id)) return reply.code(403).send('Not allowed');
    const s = await ctx.db.one<{ hls_path: string | null; ended_at: Date | null }>(
      'select hls_path, ended_at from broadcast_sessions where id = $1 and creator_id = $2',
      [Number(sessionId), Number(creatorId)],
    );
    if (!s?.hls_path || s.ended_at) return reply.code(404).send('Not found');
    const full = mediaPath(ctx, join(s.hls_path, file));
    if (!full || !existsSync(full)) return reply.code(404).send('Not found');
    return reply.type(HLS_TYPES[ext]).header('cache-control', ext === 'm3u8' ? 'no-cache' : 'private, max-age=60').send(createReadStream(full));
  });

  // ---- Recordings (admin only, for the records) ----
  app.get('/admin/recordings/:kind/:id', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const { kind, id } = req.params as Record<string, string>;
    const row =
      kind === 'session'
        ? await ctx.db.one<{ recording_path: string | null }>('select recording_path from broadcast_sessions where id = $1', [Number(id)])
        : kind === 'private'
          ? await ctx.db.one<{ recording_path: string | null }>('select recording_path from private_shows where id = $1', [Number(id)])
          : undefined;
    const full = row?.recording_path ? mediaPath(ctx, row.recording_path) : null;
    if (!full || !existsSync(full)) return reply.code(404).send('Recording not available');
    await audit(ctx.db, req.user.id, 'recording.view', { kind, id: Number(id) });
    return reply
      .type('video/mp4')
      .header('content-length', statSync(full).size)
      .header('cache-control', 'no-store')
      .send(createReadStream(full));
  });

  app.get('/admin/media', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const { media } = await ctx.settings.get();
    const recent = await ctx.db.query(
      `select s.id, s.started_at, s.ended_at, s.recording_path, u.display_name from broadcast_sessions s
       join users u on u.id = s.creator_id order by s.id desc limit 50`,
    );
    return page(
      ctx,
      req,
      reply,
      'Broadcast: OBS, recordings and HLS',
      html`<p><a href="/admin">← Admin</a></p>
      <ul>
        <li>OBS (LiveKit Ingress): <strong>${ctx.cfg.ingressEnabled ? 'enabled' : 'not installed'}</strong></li>
        <li>Recording and HLS (LiveKit Egress): <strong>${ctx.cfg.egressEnabled ? 'enabled' : 'not installed'}</strong></li>
      </ul>
      <p><small>They are installed on the server with <code>./ftw enable obs</code> and <code>./ftw enable recording</code>. Each requires at least 4 CPUs and 4 GB of RAM according to LiveKit.</small></p>
      <form method="post" action="/admin/media">
        <label><input type="checkbox" name="record" value="1" ${media.record ? 'checked' : ''}> Record every broadcast and every private show (copy required by the 2257 records)</label><br>
        <label><input type="checkbox" name="hls" value="1" ${media.hls ? 'checked' : ''}> Offer “light mode” (HLS) to viewers</label><br>
        <button>Save</button>
      </form>
      <h2>Latest broadcasts</h2>
      <ul>${recent.map(
        (s: any) => html`<li>#${s.id} · ${s.display_name} · ${new Date(s.started_at).toLocaleString('en')}
          ${s.recording_path ? html` · <a href="/admin/recordings/session/${s.id}">recording</a>` : ' · no recording'}</li>`,
      )}</ul>`,
    );
  });

  app.post('/admin/media', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const media = { record: field(req.body, 'record') === '1', hls: field(req.body, 'hls') === '1' };
    await ctx.settings.set('media', media);
    await audit(ctx.db, req.user.id, 'media.update', media);
    return go(reply, '/admin/media', 'ok', 'Saved.');
  });
}
