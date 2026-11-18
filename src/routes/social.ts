import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { needCreator, needUser } from '../web/guards.ts';
import { viewerAccess } from '../access.ts';
import { audit, UserError } from '../auth/users.ts';
import type { ChatConn } from '../live/hub.ts';
import { conversations, sendDm, thread } from '../notify/messages.ts';
import { vapidKeys } from '../notify/notify.ts';
import { html } from '../web/html.ts';
import { field, go, intField, page } from '../web/respond.ts';

const ROOT = join(import.meta.dirname, '..', '..');

function localTime(d: Date | string): ReturnType<typeof html> {
  const iso = new Date(d).toISOString();
  return html`<time datetime="${iso}" data-local>${iso.slice(0, 16).replace('T', ' ')} UTC</time>`;
}

/** Converts “YYYY-MM-DDTHH:MM” in the browser's local time (offset in minutes from getTimezoneOffset) to UTC. */
export function parseLocal(value: string, tzOffsetMinutes: number): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const asUtc = Date.parse(`${value}:00Z`);
  if (Number.isNaN(asUtc)) return null;
  const offset = Number.isFinite(tzOffsetMinutes) && Math.abs(tzOffsetMinutes) <= 14 * 60 ? tzOffsetMinutes : 0;
  return new Date(asUtc + offset * 60_000);
}

export async function socialRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- Personal connection: live notifications and messages on any page ----
  app.get('/ws/me', { websocket: true }, async (socket, req) => {
    const user = req.user;
    if (!user) return socket.close();
    const conn: ChatConn = {
      userId: user.id,
      name: user.display_name,
      level: '',
      isOwner: false,
      isStaff: false,
      lastMessageAt: 0,
      send: (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      },
      close: () => socket.close(),
    };
    ctx.hub.join(0, conn);
    socket.on('close', () => ctx.hub.leave(0, conn));
  });

  // ---- Service worker for browser notifications ----
  app.get('/sw.js', (_req, reply) =>
    reply
      .type('text/javascript')
      .header('service-worker-allowed', '/')
      .header('cache-control', 'no-cache')
      .send(readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8')),
  );

  app.post('/api/push/subscribe', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const b = (req.body ?? {}) as any;
    const endpoint = String(b.endpoint ?? '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !b.keys?.p256dh || !b.keys?.auth) throw new UserError('Invalid subscription.');
    await ctx.db.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      [req.user.id, endpoint, String(b.keys.p256dh).slice(0, 200), String(b.keys.auth).slice(0, 100)],
    );
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req, reply) => {
    if (!needUser(req, reply)) return;
    await ctx.db.query('delete from push_subscriptions where user_id = $1 and endpoint = $2', [req.user.id, String((req.body as any)?.endpoint ?? '')]);
    return { ok: true };
  });

  // ---- Notifications ----
  app.get('/notifications', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const rows = await ctx.db.query('select * from notifications where user_id = $1 order by id desc limit 100', [req.user.id]);
    await ctx.db.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [req.user.id]);
    return page(
      ctx,
      req,
      reply,
      'Notifications',
      html`<p><a href="/account">Notification settings</a></p>
      ${rows.length
        ? html`<ul class="notice-list">${rows.map(
            (n: any) => html`<li class="${n.read_at ? '' : 'unread'}"><a href="${n.url}"><strong>${n.title}</strong>${n.body ? html` — ${n.body}` : ''}</a>
              <small>${localTime(n.created_at)}</small></li>`,
          )}</ul>`
        : html`<div class="empty">You have no notifications.</div>`}`,
    );
  });

  app.get('/account', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const u = await ctx.db.one<{ notify_discreet: boolean }>('select notify_discreet from users where id = $1', [req.user.id]);
    return page(
      ctx,
      req,
      reply,
      'My account',
      html`<section class="panel" id="push" data-vapid="${vapidKeys(ctx).publicKey}">
        <h2>Notifications on this device</h2>
        <p>We notify you when someone you follow goes live, 15 minutes before scheduled streams and when you receive a message.</p>
        <p id="push-status"><small>Checking…</small></p>
        <p><button id="push-on" class="primary" hidden>Enable notifications in this browser</button> <button id="push-off" hidden>Disable</button></p>
        <form method="post" action="/account">
          <label><input type="checkbox" name="discreet" value="1" ${u?.notify_discreet ? 'checked' : ''}> Discreet notifications: don't show names or which site it is on the lock screen</label>
          <button>Save</button>
        </form>
      </section>`,
      { scripts: ['/static/js/push.js'] },
    );
  });

  app.post('/account', async (req, reply) => {
    if (!needUser(req, reply)) return;
    await ctx.db.query('update users set notify_discreet = $2 where id = $1', [req.user.id, field(req.body, 'discreet') === '1']);
    return go(reply, '/account', 'ok', 'Saved.');
  });

  // ---- Live schedule ----
  app.get('/agenda', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) return go(reply, '/age-check?next=/agenda');
    const onlyFollowing = (req.query as any).f === '1';
    const rows = await ctx.db.query(
      `select s.id, s.starts_at, s.title, p.slug, u.display_name,
         exists(select 1 from follows f where f.follower_id = $1 and f.creator_id = s.creator_id) as following
       from scheduled_shows s join creator_profiles p on p.user_id = s.creator_id join users u on u.id = s.creator_id
       where s.starts_at > now() - interval '1 hour' and s.starts_at < now() + interval '30 days'
         and u.creator_status = 'approved' and u.status = 'active'
         and ($2 = false or exists(select 1 from follows f where f.follower_id = $1 and f.creator_id = s.creator_id))
       order by s.starts_at limit 200`,
      [req.user.id, onlyFollowing],
    );
    return page(
      ctx,
      req,
      reply,
      'Schedule',
      html`<nav class="tabs"><a href="/agenda" ${onlyFollowing ? '' : 'aria-current="page"'}>All</a><a href="/agenda?f=1" ${onlyFollowing ? 'aria-current="page"' : ''}>Only people I follow</a></nav>
      ${rows.length
        ? html`<ul class="agenda">${rows.map(
            (r: any) => html`<li><span class="when">${localTime(r.starts_at)}</span>
              <span><a href="/c/${r.slug}"><strong>${r.display_name}</strong></a><br><small>${r.title}</small></span>
              ${r.following ? html`<span class="pill">Following</span>` : html`<form method="post" action="/c/${r.slug}/follow"><button>♡ Follow</button></form>`}</li>`,
          )}</ul>`
        : html`<div class="empty">No scheduled streams.</div>`}`,
    );
  });

  app.get('/studio/schedule', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const rows = await ctx.db.query('select * from scheduled_shows where creator_id = $1 and starts_at > now() - interval \'1 hour\' order by starts_at', [req.user.id]);
    return page(
      ctx,
      req,
      reply,
      'Live schedule',
      html`<p><a href="/studio">← Estudio</a></p>
      <p>Your followers get a notification 15 minutes before, and everyone sees it in the <a href="/agenda">schedule</a>.</p>
      <form method="post" action="/studio/schedule" class="inline-form">
        <label>When <input type="datetime-local" name="when" required></label>
        <label>Title <input name="title" maxlength="120" required></label>
        <input type="hidden" name="tzOffset" value="0">
        <button class="primary">Schedule</button>
      </form>
      ${rows.length
        ? html`<ul class="agenda">${rows.map(
            (r: any) => html`<li><span class="when">${localTime(r.starts_at)}</span><span>${r.title}</span>
              <form method="post" action="/studio/schedule/${r.id}/delete"><button class="danger">Remove</button></form></li>`,
          )}</ul>`
        : html`<div class="empty">You have no scheduled streams.</div>`}`,
    );
  });

  app.post('/studio/schedule', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const when = parseLocal(field(req.body, 'when'), intField(req.body, 'tzOffset'));
    const title = field(req.body, 'title').trim().slice(0, 120);
    if (!when || when.getTime() < Date.now() || when.getTime() > Date.now() + 90 * 86400_000) throw new UserError('Pick a date within the next 90 days.');
    if (!title) throw new UserError('Enter a title.');
    await ctx.db.query('insert into scheduled_shows (creator_id, starts_at, title) values ($1, $2, $3)', [req.user.id, when, title]);
    return go(reply, '/studio/schedule', 'ok', 'Stream scheduled.');
  });

  app.post('/studio/schedule/:id/delete', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    await ctx.db.query('delete from scheduled_shows where id = $1 and creator_id = $2', [Number((req.params as any).id), req.user.id]);
    return go(reply, '/studio/schedule', 'ok', 'Removed.');
  });

  // ---- Direct messages ----
  app.get('/messages', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const rows = await conversations(ctx, req.user.id);
    return page(
      ctx,
      req,
      reply,
      'Messages',
      rows.length
        ? html`<ul class="conversations">${rows.map(
            (c) => html`<li class="${c.unread ? 'unread' : ''}"><a href="/messages/${c.other_id}">
              <span class="avatar">${c.name.slice(0, 1)}</span>
              <span class="conv-main"><strong>${c.name}</strong><small>${c.last_body.slice(0, 90)}</small></span>
              ${c.unread ? html`<span class="badge-count">${c.unread}</span>` : ''}</a></li>`,
          )}</ul>`
        : html`<div class="empty">You have no messages yet. Write to a creator from their room.</div>`,
    );
  });

  app.get('/messages/:userId', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const otherId = Number((req.params as any).userId);
    const other = await ctx.db.one<{ id: number; display_name: string; creator_status: string; dm_price: number | null; slug: string | null }>(
      `select u.id, u.display_name, u.creator_status, p.dm_price, p.slug from users u left join creator_profiles p on p.user_id = u.id where u.id = $1`,
      [otherId],
    );
    if (!other || other.id === req.user.id) return reply.code(404).send('Not found');
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) return go(reply, `/age-check?next=/messages/${otherId}`);
    const msgs = await thread(ctx, req.user.id, otherId);
    const pays = other.creator_status === 'approved' && req.user.creator_status !== 'approved' && !req.user.is_admin && (other.dm_price ?? 0) > 0;
    return page(
      ctx,
      req,
      reply,
      other.display_name,
      html`<section class="dm" id="dm" data-other="${other.id}" data-me="${req.user.id}">
        <p><a href="/messages">← Messages</a>${other.slug ? html` · <a href="/c/${other.slug}">View room</a>` : ''}</p>
        <ul id="dm-list">${msgs.map(
          (m) => html`<li class="${m.sender_id === req.user!.id ? 'mine' : ''}"><span class="bubble">${m.body}</span>
            <small>${localTime(m.created_at)}${m.price ? ` · ${m.price} tk` : ''}
            ${m.sender_id !== req.user!.id ? html` · <form method="post" action="/messages/report/${m.id}" class="inline"><button class="linklike">Report</button></form>` : ''}</small></li>`,
        )}</ul>
        <form method="post" action="/messages/${other.id}" id="dm-form">
          <textarea name="body" maxlength="2000" required placeholder="Write a message…"></textarea>
          <button class="primary">Send${pays ? ` (${other.dm_price} tokens)` : ''}</button>
        </form>
      </section>`,
      { scripts: ['/static/js/dm.js'] },
    );
  });

  app.post('/messages/:userId', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const otherId = Number((req.params as any).userId);
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) throw new UserError('You need to verify your age.');
    await sendDm(ctx, req.user, otherId, field(req.body, 'body'));
    return go(reply, `/messages/${otherId}`);
  });

  app.post('/messages/report/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const m = await ctx.db.one<{ id: number; sender_id: number; recipient_id: number }>('select id, sender_id, recipient_id from dm_messages where id = $1', [
      Number((req.params as any).id),
    ]);
    if (!m || m.recipient_id !== req.user.id) return reply.code(404).send('Not found');
    await ctx.db.query('insert into reports (reporter_id, creator_id, reason, dm_message_id) values ($1, $2, $3, $4)', [
      req.user.id,
      m.sender_id,
      'Direct message reported',
      m.id,
    ]);
    await audit(ctx.db, req.user.id, 'dm.report', { messageId: m.id });
    return go(reply, `/messages/${m.sender_id}`, 'ok', 'Report sent. Moderation will review it.');
  });
}
