/**
 * Ticketed shows: several viewers pay for a ticket and watch the show in a separate room.
 * While it lasts, the public room gets no video and private shows are not accepted.
 */
import type { Ctx } from '../context.ts';
import type { Queryable } from '../db/index.ts';
import { audit, type User } from '../auth/users.ts';
import { accountId, InsufficientFunds, post, spend } from '../ledger/ledger.ts';
import { ActionError, activePrivate, creatorById, isBanned, pushBalance, pushState } from './actions.ts';
import { ticketRoom } from './livekit.ts';
import { currentSession } from '../compliance/records.ts';

export interface TicketShow {
  id: number;
  creator_id: number;
  title: string;
  price: number;
  status: 'selling' | 'live' | 'ended' | 'cancelled';
  egress_id: string | null;
  started_at: Date | null;
}

export async function openTicketShow(q: Queryable, creatorId: number): Promise<TicketShow | undefined> {
  return q.one("select * from ticket_shows where creator_id = $1 and status in ('selling', 'live')", [creatorId]);
}

export async function hasTicket(q: Queryable, showId: number, userId: number): Promise<boolean> {
  return Boolean(await q.one('select 1 from tickets where show_id = $1 and user_id = $2 and not refunded', [showId, userId]));
}

export async function ticketSummary(q: Queryable, creatorId: number) {
  const s = await openTicketShow(q, creatorId);
  if (!s) return null;
  const sold = await q.one<{ n: number }>('select count(*)::int as n from tickets where show_id = $1 and not refunded', [s.id]);
  return { id: s.id, title: s.title, price: s.price, status: s.status, sold: sold?.n ?? 0 };
}

export async function createTicketShow(ctx: Ctx, creator: User, title: string, price: number): Promise<number> {
  const t = title.trim().slice(0, 120);
  if (!t) throw new ActionError('Give the show a title.');
  if (!(Number.isInteger(price) && price >= 1 && price <= 100000)) throw new ActionError('Invalid ticket price.');
  if (await openTicketShow(ctx.db, creator.id)) throw new ActionError('You already have an open ticketed show.');
  const row = await ctx.db.one<{ id: number }>('insert into ticket_shows (creator_id, title, price) values ($1, $2, $3) returning id', [
    creator.id,
    t,
    price,
  ]);
  await audit(ctx.db, creator.id, 'ticket.create', { showId: row!.id, price });
  ctx.hub.broadcast(creator.id, { type: 'system', text: `Tickets on sale: “${t}” for ${price} tokens.` }, { remember: true });
  await pushState(ctx, creator.id);
  return row!.id;
}

export async function buyTicket(ctx: Ctx, viewer: User, creatorId: number): Promise<number> {
  const show = await openTicketShow(ctx.db, creatorId);
  if (!show) throw new ActionError('There are no tickets on sale.');
  if (viewer.id === creatorId) throw new ActionError('This is your own show.');
  if (await isBanned(ctx.db, creatorId, viewer.id)) throw new ActionError('You cannot take part in this room.');
  if (await hasTicket(ctx.db, show.id, viewer.id)) throw new ActionError('You already have a ticket.');
  const { economy } = await ctx.settings.get();
  try {
    await ctx.db.tx(async (q) => {
      const txId = await spend(q, {
        kind: 'ticket',
        fromUser: viewer.id,
        toCreator: creatorId,
        tokens: show.price,
        creatorSharePct: economy.creatorSharePct,
        memo: `Ticket: ${show.title}`,
        idempotencyKey: `ticket:${show.id}:${viewer.id}`,
        meta: { showId: show.id },
      });
      await q.query(
        `insert into tickets (show_id, user_id, tx_id) values ($1, $2, $3)
         on conflict (show_id, user_id) do update set refunded = false, tx_id = excluded.tx_id`,
        [show.id, viewer.id, txId],
      );
    });
  } catch (err) {
    if (err instanceof InsufficientFunds) throw new ActionError('No tienes tokens suficientes.');
    throw err;
  }
  await pushState(ctx, creatorId);
  ctx.hub.toUser(viewer.id, { type: 'ticket', creatorId, showId: show.id, hasTicket: true });
  return pushBalance(ctx, viewer.id);
}

export async function startTicketShow(ctx: Ctx, creator: User): Promise<TicketShow> {
  const show = await openTicketShow(ctx.db, creator.id);
  if (!show || show.status !== 'selling') throw new ActionError('There is no ticketed show ready.');
  const c = await creatorById(ctx.db, creator.id);
  if (!c?.is_live) throw new ActionError('Go live before the show.');
  const mode = await ctx.db.one<{ broadcast_mode: string }>('select broadcast_mode from creator_profiles where user_id = $1', [creator.id]);
  if (mode?.broadcast_mode === 'obs') throw new ActionError('Ticketed shows need the browser camera (not OBS).');
  if (await activePrivate(ctx.db, creator.id)) throw new ActionError('End the private show before starting the show.');
  await ctx.db.query("update ticket_shows set status = 'live', started_at = now(), session_id = $2 where id = $1", [
    show.id,
    (await currentSession(ctx.db, creator.id))?.id ?? null,
  ]);
  // Pending private show requests are cancelled.
  await ctx.db.query(
    "update private_shows set status = 'cancelled', end_reason = 'A ticketed show started', ended_at = now() where creator_id = $1 and status = 'requested'",
    [creator.id],
  );
  await recordTicketShow(ctx, show);
  await audit(ctx.db, creator.id, 'ticket.start', { showId: show.id });
  ctx.hub.broadcast(creator.id, { type: 'system', text: `The show “${show.title}” is starting!` }, { remember: true });
  await pushState(ctx, creator.id);
  return (await ctx.db.one<TicketShow>('select * from ticket_shows where id = $1', [show.id]))!;
}

async function recordTicketShow(ctx: Ctx, show: TicketShow): Promise<void> {
  if (!ctx.cfg.egressEnabled) return;
  const { media } = await ctx.settings.get();
  if (!media.record) return;
  const rel = `recordings/${show.creator_id}/ticket-${show.id}.mp4`;
  try {
    // Creator tracks only: this way nobody else is ever recorded.
    const id = await ctx.media.startParticipantRecording(ticketRoom(show.id), `u${show.creator_id}`, rel);
    await ctx.db.query('update ticket_shows set egress_id = $2, recording_path = $3 where id = $1', [show.id, id, rel]);
  } catch (err) {
    await audit(ctx.db, null, 'recording.failed', { ticketShowId: show.id, error: (err as Error).message });
  }
}

export async function endTicketShow(ctx: Ctx, creatorId: number, reason = 'Show ended'): Promise<void> {
  const rows = await ctx.db.query<TicketShow>(
    "update ticket_shows set status = 'ended', ended_at = now() where creator_id = $1 and status = 'live' returning *",
    [creatorId],
  );
  const show = rows[0];
  if (!show) return;
  if (show.egress_id) await ctx.media.stopEgress(show.egress_id).catch(() => undefined);
  ctx.hub.broadcast(creatorId, { type: 'system', text: `${reason}: “${show.title}”.` }, { remember: true });
  await pushState(ctx, creatorId);
}

/** Cancels a show (on sale or in progress) and refunds all tickets. */
export async function cancelTicketShow(ctx: Ctx, creatorId: number, actorId: number): Promise<number> {
  const show = await openTicketShow(ctx.db, creatorId);
  if (!show) throw new ActionError('There is no open ticketed show.');
  const tickets = await ctx.db.query<{ user_id: number; tx_id: number }>(
    'select user_id, tx_id from tickets where show_id = $1 and not refunded',
    [show.id],
  );
  for (const t of tickets) {
    await ctx.db.tx(async (q) => {
      const original = await q.one<{ meta: { creatorPart: number } }>('select meta from ledger_tx where id = $1', [t.tx_id]);
      const creatorPart = Number(original?.meta?.creatorPart ?? 0);
      await post(q, {
        kind: 'ticket_refund',
        memo: `Ticket refund: ${show.title}`,
        idempotencyKey: `ticket-refund:${show.id}:${t.user_id}`,
        entries: [
          { account: await accountId(q, 'wallet', t.user_id), amount: show.price },
          { account: await accountId(q, 'earnings', creatorId), amount: -creatorPart },
          { account: await accountId(q, 'platform', null), amount: -(show.price - creatorPart) },
        ],
        meta: { showId: show.id, userId: t.user_id },
      });
      await q.query('update tickets set refunded = true where show_id = $1 and user_id = $2', [show.id, t.user_id]);
      await q.query('update users set total_spent = greatest(0, total_spent - $2) where id = $1', [t.user_id, show.price]);
    });
    await pushBalance(ctx, t.user_id);
  }
  await ctx.db.query("update ticket_shows set status = 'cancelled', ended_at = now() where id = $1", [show.id]);
  if (show.egress_id) await ctx.media.stopEgress(show.egress_id).catch(() => undefined);
  await audit(ctx.db, actorId, 'ticket.cancel', { showId: show.id, refunded: tickets.length });
  ctx.hub.broadcast(creatorId, { type: 'system', text: `Show “${show.title}” cancelled: tickets have been refunded.` }, { remember: true });
  await pushState(ctx, creatorId);
  return tickets.length;
}
