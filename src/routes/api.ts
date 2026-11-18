import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { needUser } from '../web/guards.ts';
import { canBroadcast, viewerAccess } from '../access.ts';
import { audit } from '../auth/users.ts';
import { ActionError, buyMenuItem, creatorById, isBanned, pushState, roomState, sendTip } from '../live/actions.ts';
import { liveToken, privateRoom, publicRoom, ticketRoom } from '../live/livekit.ts';
import { canModerate, muteUser } from '../live/chatmod.ts';
import { closePoll, createPoll, runRaffle, vote } from '../live/engage.ts';
import { buyTicket, cancelTicketShow, createTicketShow, endTicketShow, hasTicket, openTicketShow, startTicketShow } from '../live/tickets.ts';
import { sessionStats } from '../live/stats.ts';
import { startLive, endLive } from '../live/lifecycle.ts';
import { cancelRequest, setCam2cam, endPrivateBy, getShow, requestPrivate, respondPrivate } from '../live/privates.ts';

function num(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

export async function apiRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/rooms/:creatorId/state', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) throw new ActionError('You need to verify your age.');
    return roomState(ctx, num((req.params as any).creatorId));
  });

  /** LiveKit token: the server decides who publishes and who only watches. */
  app.get('/api/live/token', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const q = req.query as any;
    const user = req.user;
    if (q.show) {
      const show = await getShow(ctx, num(q.show));
      if (!show || show.status !== 'active') throw new ActionError('The private show is not active.');
      const isCreator = show.creator_id === user.id;
      if (!isCreator && show.viewer_id !== user.id) throw new ActionError('You are not part of this private show.');
      if (isCreator && !(await canBroadcast(ctx, user)).ok) throw new ActionError('You cannot broadcast.');
      const room = privateRoom(show.id);
      // The viewer can only publish if they turned on cam2cam (and are therefore charged).
      const publish = isCreator || show.cam2cam_on;
      return { url: ctx.cfg.livekitUrl, room, token: await liveToken(ctx.cfg, { identity: `u${user.id}`, name: user.display_name, room, publish }) };
    }
    if (q.ticket) {
      const t = await ctx.db.one<{ id: number; creator_id: number; status: string }>('select id, creator_id, status from ticket_shows where id = $1', [num(q.ticket)]);
      if (!t || t.status !== 'live') throw new ActionError('The show is not in progress.');
      const isCreator = t.creator_id === user.id;
      if (isCreator && !(await canBroadcast(ctx, user)).ok) throw new ActionError('You cannot broadcast.');
      if (!isCreator && !user.is_admin && !(await hasTicket(ctx.db, t.id, user.id))) throw new ActionError('You need a ticket for this show.');
      const room = ticketRoom(t.id);
      return { url: ctx.cfg.livekitUrl, room, token: await liveToken(ctx.cfg, { identity: `u${user.id}`, name: user.display_name, room, publish: isCreator }) };
    }
    const creator = await creatorById(ctx.db, num(q.creator));
    if (!creator) throw new ActionError('Room not found.');
    const room = publicRoom(creator.user_id);
    if (creator.user_id === user.id) {
      const can = await canBroadcast(ctx, user);
      if (!can.ok) throw new ActionError(can.reason!);
      return { url: ctx.cfg.livekitUrl, room, token: await liveToken(ctx.cfg, { identity: `u${user.id}`, name: user.display_name, room, publish: true }) };
    }
    const access = await viewerAccess(ctx, user, req.country);
    if (!access.ok) throw new ActionError('You need to verify your age.');
    if (creator.creator_status !== 'approved') throw new ActionError('Room not available.');
    if (await isBanned(ctx.db, creator.user_id, user.id)) throw new ActionError('You cannot enter this room.');
    if (!creator.is_live) throw new ActionError('Not live.');
    return { url: ctx.cfg.livekitUrl, room, token: await liveToken(ctx.cfg, { identity: `u${user.id}`, name: user.display_name, room, publish: false }) };
  });

  app.post('/api/studio/live', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const b = (req.body ?? {}) as any;
    if (b.on) {
      const performers = Array.isArray(b.performers) ? b.performers.map(Number).filter(Number.isInteger) : [];
      const sessionId = await startLive(ctx, req.user, performers, b.mode === 'obs' ? 'obs' : 'browser');
      return { live: true, sessionId };
    }
    await endLive(ctx, req.user.id, 'The creator ended the live stream');
    await audit(ctx.db, req.user.id, 'live.stop');
    return { live: false };
  });

  app.post('/api/tip', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const b = (req.body ?? {}) as any;
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) throw new ActionError('You need to verify your age.');
    const left = await sendTip(ctx, req.user, num(b.creatorId), num(b.amount), String(b.message ?? ''));
    return { balance: left };
  });

  app.post('/api/menu/:itemId', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) throw new ActionError('You need to verify your age.');
    const left = await buyMenuItem(ctx, req.user, num((req.params as any).itemId));
    return { balance: left };
  });

  app.post('/api/private/request', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) throw new ActionError('You need to verify your age.');
    const show = await requestPrivate(ctx, req.user, num((req.body as any)?.creatorId));
    return { id: show.id, status: show.status };
  });

  app.post('/api/private/:id/:action', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const { id, action } = req.params as any;
    const showId = num(id);
    switch (action) {
      case 'accept':
      case 'decline': {
        const show = await respondPrivate(ctx, req.user, showId, action === 'accept');
        return { id: show.id, status: show.status };
      }
      case 'cancel':
        await cancelRequest(ctx, req.user, showId);
        return { id: showId, status: 'cancelled' };
      case 'end':
        await endPrivateBy(ctx, req.user, showId);
        return { id: showId, status: 'ended' };
      case 'cam2cam': {
        const show = await setCam2cam(ctx, req.user, showId, Boolean((req.body as any)?.on));
        return { id: show.id, cam2cam: show.cam2cam_on };
      }
      default:
        return reply.code(404).send({ error: 'Unknown action' });
    }
  });

  /** The creator (or an admin) bans someone from the room. */
  app.post('/api/rooms/:creatorId/ban', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const creatorId = num((req.params as any).creatorId);
    const userId = num((req.body as any)?.userId);
    if (!(await canModerate(ctx.db, creatorId, req.user))) return reply.code(403).send({ error: 'Not allowed' });
    if (userId === creatorId) throw new ActionError('You cannot ban the creator.');
    await ctx.db.query('insert into room_bans (creator_id, user_id) values ($1, $2) on conflict do nothing', [creatorId, userId]);
    await audit(ctx.db, req.user.id, 'room.ban', { creatorId, userId });
    ctx.hub.kick(creatorId, userId);
    return { ok: true };
  });

  app.post('/api/rooms/:creatorId/unban', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const creatorId = num((req.params as any).creatorId);
    if (req.user.id !== creatorId && !req.user.is_admin) return reply.code(403).send({ error: 'Not allowed' });
    await ctx.db.query('delete from room_bans where creator_id = $1 and user_id = $2', [creatorId, num((req.body as any)?.userId)]);
    return { ok: true };
  });

  // ---- Personal room data (ticket, moderation) ----
  app.get('/api/rooms/:creatorId/me', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const creatorId = num((req.params as any).creatorId);
    const show = await openTicketShow(ctx.db, creatorId);
    return {
      hasTicket: show ? await hasTicket(ctx.db, show.id, req.user.id) : false,
      canModerate: await canModerate(ctx.db, creatorId, req.user),
    };
  });

  // ---- Chat moderation (creator, admins or moderators) ----
  app.post('/api/rooms/:creatorId/mod', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const creatorId = num((req.params as any).creatorId);
    if (!(await canModerate(ctx.db, creatorId, req.user))) return reply.code(403).send({ error: 'Not allowed' });
    const b = (req.body ?? {}) as any;
    switch (b.action) {
      case 'mute':
        await muteUser(ctx, creatorId, req.user, num(b.userId), num(b.minutes ?? 10));
        return { ok: true };
      case 'unmute':
        await ctx.db.query('delete from room_mutes where creator_id = $1 and user_id = $2', [creatorId, num(b.userId)]);
        return { ok: true };
      case 'delete':
        if (typeof b.messageId !== 'string' || b.messageId.length > 40) throw new ActionError('Invalid message.');
        ctx.hub.deleteMessage(creatorId, b.messageId);
        await audit(ctx.db, req.user.id, 'chat.delete', { creatorId, messageId: b.messageId });
        return { ok: true };
      default:
        return reply.code(400).send({ error: 'Unknown action' });
    }
  });

  // ---- Polls and giveaways ----
  app.post('/api/poll', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const b = (req.body ?? {}) as any;
    const options = Array.isArray(b.options) ? b.options.map(String) : String(b.options ?? '').split('\n');
    const id = await createPoll(ctx, req.user, { question: String(b.question ?? ''), options, votePrice: num(b.votePrice ?? 0), minutes: num(b.minutes ?? 5) });
    return { id };
  });

  app.post('/api/poll/close', async (req, reply) => {
    if (!needUser(req, reply)) return;
    await closePoll(ctx, req.user.id);
    return { ok: true };
  });

  app.post('/api/poll/vote', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!(await viewerAccess(ctx, req.user, req.country)).ok) throw new ActionError('You need to verify your age.');
    const b = (req.body ?? {}) as any;
    return { poll: await vote(ctx, req.user, num(b.creatorId), num(b.option), num(b.times ?? 1)) };
  });

  app.post('/api/raffle', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const b = (req.body ?? {}) as any;
    return runRaffle(ctx, req.user, String(b.prize ?? ''), b.audience === 'followers' ? 'followers' : 'present');
  });

  // ---- Ticketed shows ----
  app.post('/api/tickets/:action', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const b = (req.body ?? {}) as any;
    switch ((req.params as any).action) {
      case 'create':
        return { id: await createTicketShow(ctx, req.user, String(b.title ?? ''), num(b.price)) };
      case 'start':
        return { show: await startTicketShow(ctx, req.user) };
      case 'end':
        await endTicketShow(ctx, req.user.id);
        return { ok: true };
      case 'cancel':
        return { refunded: await cancelTicketShow(ctx, req.user.id, req.user.id) };
      case 'buy':
        if (!(await viewerAccess(ctx, req.user, req.country)).ok) throw new ActionError('You need to verify your age.');
        return { balance: await buyTicket(ctx, req.user, num(b.creatorId)) };
      default:
        return reply.code(404).send({ error: 'Unknown action' });
    }
  });

  // ---- Creator live panel ----
  app.get('/api/studio/stats', async (req, reply) => {
    if (!needUser(req, reply)) return;
    return { stats: await sessionStats(ctx, req.user.id) };
  });
}
