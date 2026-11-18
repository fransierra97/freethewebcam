import type { Ctx } from '../context.ts';
import type { User } from '../auth/users.ts';
import { balance, InsufficientFunds, spend } from '../ledger/ledger.ts';
import { currentSession } from '../compliance/records.ts';
import { privateRoom } from './livekit.ts';
import { stopEgressSafe } from './lifecycle.ts';
import { audit } from '../auth/users.ts';
import { ActionError, activePrivate, creatorById, isBanned, levelName, pushBalance, pushState } from './actions.ts';

/** Records the private show (it counts as another broadcast for record-keeping) if the server has Egress. */
async function recordPrivate(ctx: Ctx, show: PrivateShow): Promise<void> {
  if (!ctx.cfg.egressEnabled) return;
  const { media } = await ctx.settings.get();
  if (!media.record) return;
  const rel = `recordings/${show.creator_id}/private-${show.id}.mp4`;
  try {
    // Creator only: if the viewer turns on their camera (cam2cam), it is never recorded.
    const id = await ctx.media.startParticipantRecording(privateRoom(show.id), `u${show.creator_id}`, rel);
    await ctx.db.query('update private_shows set egress_id = $2, recording_path = $3 where id = $1', [show.id, id, rel]);
  } catch (err) {
    await audit(ctx.db, null, 'recording.failed', { showId: show.id, error: (err as Error).message });
  }
}

export interface PrivateShow {
  id: number;
  creator_id: number;
  viewer_id: number;
  price_per_min: number;
  cam2cam_on: boolean;
  cam2cam_price: number;
  status: 'requested' | 'active' | 'ended' | 'declined' | 'cancelled';
  egress_id: string | null;
  recording_path: string | null;
  minutes_billed: number;
  tokens_billed: number;
  end_reason: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}

export async function getShow(ctx: Ctx, id: number): Promise<PrivateShow | undefined> {
  return ctx.db.one('select * from private_shows where id = $1', [id]);
}

function notify(ctx: Ctx, show: PrivateShow, extra: Record<string, unknown> = {}) {
  const msg = { type: 'private_update', creatorId: show.creator_id, id: show.id, status: show.status, reason: show.end_reason, startedAt: show.started_at, ...extra };
  ctx.hub.toUser(show.creator_id, msg);
  ctx.hub.toUser(show.viewer_id, msg);
}

export async function requestPrivate(ctx: Ctx, viewer: User, creatorId: number): Promise<PrivateShow> {
  const creator = await creatorById(ctx.db, creatorId);
  if (!creator || creator.creator_status !== 'approved') throw new ActionError('Sala no disponible.');
  if (!creator.is_live) throw new ActionError('The creator is not live.');
  if (!creator.private_enabled) throw new ActionError('This creator is not accepting private shows right now.');
  const mode = await ctx.db.one<{ broadcast_mode: string }>('select broadcast_mode from creator_profiles where user_id = $1', [creatorId]);
  if (mode?.broadcast_mode === 'obs') throw new ActionError('This broadcast comes from OBS: private shows are not available.');
  const ticket = await ctx.db.one("select 1 from ticket_shows where creator_id = $1 and status = 'live'", [creatorId]);
  if (ticket) throw new ActionError('A ticketed show is in progress: private shows return when it ends.');
  if (viewer.id === creatorId) throw new ActionError('You cannot request a private show with yourself.');
  if (await isBanned(ctx.db, creatorId, viewer.id)) throw new ActionError('You cannot take part in this room.');
  if (await activePrivate(ctx.db, creatorId)) throw new ActionError('They are already in a private show. Try again in a few minutes.');
  const pending = await ctx.db.one(
    "select 1 from private_shows where viewer_id = $1 and status in ('requested', 'active')",
    [viewer.id],
  );
  if (pending) throw new ActionError('You already have a pending or ongoing private show.');
  const wallet = await balance(ctx.db, 'wallet', viewer.id);
  if (wallet < creator.private_price_per_min) throw new ActionError('You need tokens for at least one minute.');
  const show = (await ctx.db.one<PrivateShow>(
    `insert into private_shows (creator_id, viewer_id, price_per_min, cam2cam_price)
     values ($1, $2, $3, (select case when cam2cam_enabled then cam2cam_price_per_min else 0 end from creator_profiles where user_id = $1))
     returning *`,
    [creatorId, viewer.id, creator.private_price_per_min],
  ))!;
  ctx.hub.toUser(creatorId, {
    type: 'private_request',
    creatorId,
    id: show.id,
    viewer: viewer.display_name,
    level: await levelName(ctx, viewer),
    pricePerMin: show.price_per_min,
  });
  notify(ctx, show);
  return show;
}

/** Bills the minutes that are due. Each minute is paid in advance. */
async function billDue(ctx: Ctx, show: PrivateShow, now: number): Promise<'ok' | 'ended'> {
  const { economy } = await ctx.settings.get();
  const started = new Date(show.started_at!).getTime();
  const due = Math.floor((now - started) / 60_000) + 1;
  let billed = show.minutes_billed;
  while (billed < due) {
    const minute = billed + 1;
    // The cam2cam extra is charged for minutes that start with the viewer's camera on.
    const fresh = await ctx.db.one<{ cam2cam_on: boolean; status: string }>('select cam2cam_on, status from private_shows where id = $1', [show.id]);
    if (fresh?.status !== 'active') return 'ended';
    const price = show.price_per_min + (fresh.cam2cam_on ? show.cam2cam_price : 0);
    try {
      await ctx.db.tx(async (q) => {
        await spend(q, {
          kind: 'private',
          fromUser: show.viewer_id,
          toCreator: show.creator_id,
          tokens: price,
          creatorSharePct: economy.creatorSharePct,
          memo: `Private show #${show.id}, minute ${minute}${price > show.price_per_min ? ' (with cam2cam)' : ''}`,
          idempotencyKey: `private:${show.id}:${minute}`,
          meta: { showId: show.id, minute, cam2cam: price > show.price_per_min },
        });
        await q.query(
          // Idempotent: the total always comes from the ledger, even if two charges coincide.
          `update private_shows set minutes_billed = greatest(minutes_billed, $2),
             tokens_billed = (select coalesce(sum(-e.amount), 0)::int from ledger_tx t
               join ledger_entries e on e.tx_id = t.id join accounts a on a.id = e.account_id and a.kind = 'wallet'
               where t.kind = 'private' and (t.meta->>'showId')::int = $1)
           where id = $1`,
          [show.id, minute],
        );
      });
      billed = minute;
    } catch (err) {
      if (err instanceof InsufficientFunds) {
        await endPrivate(ctx, show.id, 'Balance exhausted');
        return 'ended';
      }
      throw err;
    }
  }
  const left = await pushBalance(ctx, show.viewer_id);
  if (left < show.price_per_min) ctx.hub.toUser(show.viewer_id, { type: 'system', text: 'You have less than one minute of balance left.' });
  return 'ok';
}

export async function respondPrivate(ctx: Ctx, creator: User, showId: number, accept: boolean): Promise<PrivateShow> {
  const show = await getShow(ctx, showId);
  if (!show || show.creator_id !== creator.id) throw new ActionError('Request not found.');
  if (show.status !== 'requested') throw new ActionError('That request is no longer pending.');
  if (!accept) {
    await ctx.db.query("update private_shows set status = 'declined', ended_at = now() where id = $1", [showId]);
    const updated = (await getShow(ctx, showId))!;
    notify(ctx, updated);
    return updated;
  }
  if (await activePrivate(ctx.db, creator.id)) throw new ActionError('You already have a private show in progress.');
  const session = await currentSession(ctx.db, creator.id);
  await ctx.db.query("update private_shows set status = 'active', started_at = now(), session_id = $2 where id = $1", [showId, session?.id ?? null]);
  const active = (await getShow(ctx, showId))!;
  if ((await billDue(ctx, active, Date.now())) === 'ended') return (await getShow(ctx, showId))!;
  await recordPrivate(ctx, active);
  // The other pending requests are declined automatically.
  const others = await ctx.db.query<PrivateShow>(
    "update private_shows set status = 'declined', end_reason = 'Accepted another private show', ended_at = now() where creator_id = $1 and status = 'requested' returning *",
    [creator.id],
  );
  others.forEach((o) => notify(ctx, o));
  const updated = (await getShow(ctx, showId))!;
  notify(ctx, updated);
  await pushState(ctx, creator.id);
  return updated;
}

export async function cancelRequest(ctx: Ctx, viewer: User, showId: number): Promise<void> {
  const show = await getShow(ctx, showId);
  if (!show || show.viewer_id !== viewer.id || show.status !== 'requested') throw new ActionError('Request not found.');
  await ctx.db.query("update private_shows set status = 'cancelled', ended_at = now() where id = $1", [showId]);
  notify(ctx, (await getShow(ctx, showId))!);
}

export async function endPrivate(ctx: Ctx, showId: number, reason: string): Promise<PrivateShow | undefined> {
  const rows = await ctx.db.query<PrivateShow>(
    "update private_shows set status = 'ended', end_reason = $2, ended_at = now() where id = $1 and status = 'active' returning *",
    [showId, reason],
  );
  const show = rows[0];
  if (!show) return undefined;
  if (show.egress_id) await stopEgressSafe(ctx, show.egress_id);
  notify(ctx, show);
  await pushState(ctx, show.creator_id);
  return show;
}

export async function endPrivateBy(ctx: Ctx, user: User, showId: number): Promise<void> {
  const show = await getShow(ctx, showId);
  if (!show || (show.creator_id !== user.id && show.viewer_id !== user.id && !user.is_admin)) throw new ActionError('Private show not found.');
  const who = show.creator_id === user.id ? 'the creator' : show.viewer_id === user.id ? 'the viewer' : 'moderation';
  await endPrivate(ctx, showId, `Ended by ${who}`);
}

/** Runs every few seconds: bills minutes and ends private shows with no balance. */
export async function billPrivates(ctx: Ctx, now = Date.now()): Promise<void> {
  const shows = await ctx.db.query<PrivateShow>("select * from private_shows where status = 'active'");
  for (const show of shows) await billDue(ctx, show, now);
}

/** If the creator stops broadcasting, their private shows and requests are closed. */
export async function closeCreatorPrivates(ctx: Ctx, creatorId: number, reason: string): Promise<void> {
  const active = await activePrivate(ctx.db, creatorId);
  if (active) await endPrivate(ctx, active.id, reason);
  const pending = await ctx.db.query<PrivateShow>(
    "update private_shows set status = 'cancelled', end_reason = $2, ended_at = now() where creator_id = $1 and status = 'requested' returning *",
    [creatorId, reason],
  );
  pending.forEach((p) => notify(ctx, p));
}

/** The viewer turns their camera on or off in the private show (if the creator allows it). */
export async function setCam2cam(ctx: Ctx, viewer: User, showId: number, on: boolean): Promise<PrivateShow> {
  const show = await getShow(ctx, showId);
  if (!show || show.viewer_id !== viewer.id || show.status !== 'active') throw new ActionError('Private show not found.');
  const p = await ctx.db.one<{ cam2cam_enabled: boolean }>('select cam2cam_enabled from creator_profiles where user_id = $1', [show.creator_id]);
  if (on && !p?.cam2cam_enabled) throw new ActionError('This creator does not accept cam2cam.');
  if (on) {
    const wallet = await balance(ctx.db, 'wallet', viewer.id);
    if (wallet < show.price_per_min + show.cam2cam_price) throw new ActionError('You need tokens for at least one minute with camera.');
  }
  await ctx.db.query('update private_shows set cam2cam_on = $2 where id = $1', [showId, on]);
  const updated = (await getShow(ctx, showId))!;
  notify(ctx, updated, { cam2cam: on });
  return updated;
}

