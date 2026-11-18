import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { viewerAccess } from '../access.ts';
import { creatorById, isBanned, levelName, roomState } from '../live/actions.ts';
import type { ChatConn } from '../live/hub.ts';
import { getShow } from '../live/privates.ts';
import { canModerate, chatBlockReason, messageId, REACTIONS } from '../live/chatmod.ts';

const MIN_INTERVAL_MS = 1000;

function sameHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function cleanText(raw: unknown, max = 300): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

export async function wsRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/ws/room/:creatorId', { websocket: true }, async (socket, req) => {
    const fail = (text: string) => {
      socket.send(JSON.stringify({ type: 'system', text }));
      socket.close();
    };
    const origin = req.headers.origin;
    if (origin && sameHost(origin) !== req.headers.host) return fail('Origin not allowed');
    const user = req.user;
    if (!user) return fail('Log in.');
    const creatorId = Number((req.params as any).creatorId);
    const creator = await creatorById(ctx.db, creatorId);
    if (!creator) return fail('Room not found.');
    const isOwner = creator.user_id === user.id;
    if (!isOwner && !user.is_admin) {
      if (!(await viewerAccess(ctx, user, req.country)).ok) return fail('You need to verify your age.');
      if (await isBanned(ctx.db, creatorId, user.id)) return fail('You cannot enter this room.');
    }

    const conn: ChatConn = {
      userId: user.id,
      name: user.display_name,
      level: await levelName(ctx, user),
      isOwner,
      isStaff: user.is_admin,
      lastMessageAt: 0,
      send: (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      },
      close: () => socket.close(),
    };
    conn.isMod = !isOwner && (await canModerate(ctx.db, creatorId, user));
    ctx.hub.join(creatorId, conn);
    conn.send(await roomState(ctx, creatorId));
    conn.send({ type: 'me', canModerate: isOwner || Boolean(conn.isMod), userId: user.id });
    // On page reload, recover pending or in-progress private shows.
    const open = await ctx.db.query(
      `select s.id, s.status, s.price_per_min, s.started_at, s.viewer_id, u.display_name as viewer, u.total_spent
       from private_shows s join users u on u.id = s.viewer_id
       where s.creator_id = $1 and s.status in ('requested', 'active') and ($2 or s.viewer_id = $3) order by s.id`,
      [creatorId, isOwner, user.id],
    );
    for (const s of open) {
      if (isOwner && s.status === 'requested') {
        conn.send({ type: 'private_request', creatorId, id: s.id, viewer: s.viewer, level: await levelName(ctx, s), pricePerMin: s.price_per_min });
      }
      conn.send({ type: 'private_update', creatorId, id: s.id, status: s.status, viewer: s.viewer, startedAt: s.started_at });
    }

    socket.on('message', async (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const now = Date.now();
      if (msg?.type === 'react') {
        // Quick reactions: free, at most two per second, not kept in the history.
        if (!REACTIONS.includes(msg.emoji) || now - (conn.lastReactAt ?? 0) < 500) return;
        conn.lastReactAt = now;
        ctx.hub.broadcast(creatorId, { type: 'reaction', emoji: msg.emoji });
        return;
      }
      if (now - conn.lastMessageAt < MIN_INTERVAL_MS) {
        conn.send({ type: 'system', text: 'You are going too fast, wait a second.' });
        return;
      }
      if (msg?.type === 'chat') {
        const text = cleanText(msg.text);
        if (!text) return;
        conn.lastMessageAt = now;
        const blocked = await chatBlockReason(ctx, creatorId, user, text, conn.lastChatAt ?? 0);
        if (blocked) {
          conn.send({ type: 'system', text: blocked });
          return;
        }
        conn.lastChatAt = now;
        // Recompute the level in case they spent tokens since joining.
        const fresh = await ctx.db.one<{ total_spent: number }>('select total_spent from users where id = $1', [user.id]);
        if (fresh) conn.level = await levelName(ctx, fresh);
        ctx.hub.broadcast(
          creatorId,
          {
            type: 'chat',
            id: messageId(),
            userId: user.id,
            user: user.display_name,
            level: conn.level,
            owner: isOwner,
            staff: user.is_admin,
            mod: Boolean(conn.isMod),
            text,
            at: now,
          },
          { remember: true },
        );
      } else if (msg?.type === 'private_chat') {
        const show = await getShow(ctx, Number(msg.showId));
        if (!show || show.status !== 'active' || (show.creator_id !== user.id && show.viewer_id !== user.id)) return;
        const text = cleanText(msg.text);
        if (!text) return;
        conn.lastMessageAt = now;
        const out = { type: 'private_chat', creatorId: show.creator_id, showId: show.id, user: user.display_name, text, at: now };
        ctx.hub.toUser(show.creator_id, out);
        ctx.hub.toUser(show.viewer_id, out);
      }
    });
    socket.on('close', () => ctx.hub.leave(creatorId, conn));
  });
}
