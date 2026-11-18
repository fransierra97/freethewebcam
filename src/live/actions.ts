import type { Ctx } from '../context.ts';
import type { Queryable } from '../db/index.ts';
import type { User } from '../auth/users.ts';
import { balance, InsufficientFunds, spend } from '../ledger/ledger.ts';
import { levelFor } from '../settings.ts';
import { pollState } from './engage.ts';
import { ticketSummary } from './tickets.ts';
import { notePeak } from './stats.ts';

export class ActionError extends Error {}

export interface CreatorRow {
  user_id: number;
  slug: string;
  display_name: string;
  bio: string;
  room_title: string;
  private_enabled: boolean;
  private_price_per_min: number;
  is_live: boolean;
  live_since: Date | null;
  goal_label: string | null;
  goal_tokens: number | null;
  goal_progress: number;
  creator_status: string;
  status: string;
}

const CREATOR_COLS = `p.user_id, p.slug, u.display_name, p.bio, p.room_title, p.private_enabled, p.private_price_per_min,
  p.is_live, p.live_since, p.goal_label, p.goal_tokens, p.goal_progress, u.creator_status, u.status`;

export async function creatorBySlug(q: Queryable, slug: string): Promise<CreatorRow | undefined> {
  return q.one(`select ${CREATOR_COLS} from creator_profiles p join users u on u.id = p.user_id where p.slug = $1`, [slug]);
}

export async function creatorById(q: Queryable, id: number): Promise<CreatorRow | undefined> {
  return q.one(`select ${CREATOR_COLS} from creator_profiles p join users u on u.id = p.user_id where p.user_id = $1`, [id]);
}

export async function listCreators(q: Queryable, opts: { liveOnly?: boolean } = {}): Promise<CreatorRow[]> {
  return q.query(
    `select ${CREATOR_COLS} from creator_profiles p join users u on u.id = p.user_id
     where u.creator_status = 'approved' and u.status = 'active' ${opts.liveOnly ? 'and p.is_live' : ''}
     order by p.is_live desc, p.live_since desc nulls last, u.display_name`,
  );
}

export async function activePrivate(q: Queryable, creatorId: number) {
  return q.one<{ id: number; viewer_id: number }>(
    "select id, viewer_id from private_shows where creator_id = $1 and status = 'active'",
    [creatorId],
  );
}

export async function isBanned(q: Queryable, creatorId: number, userId: number): Promise<boolean> {
  return Boolean(await q.one('select 1 from room_bans where creator_id = $1 and user_id = $2', [creatorId, userId]));
}

export async function levelName(ctx: Ctx, user: Pick<User, 'total_spent'>): Promise<string> {
  const { economy } = await ctx.settings.get();
  return levelFor(economy.levels, user.total_spent).current.name;
}

export async function roomState(ctx: Ctx, creatorId: number) {
  notePeak(creatorId, ctx.hub.viewerCount(creatorId));
  const c = await creatorById(ctx.db, creatorId);
  const priv = await activePrivate(ctx.db, creatorId);
  const hls = c?.is_live
    ? await ctx.db.one<{ id: number; hls_path: string | null }>(
        'select id, hls_path from broadcast_sessions where creator_id = $1 and ended_at is null order by id desc limit 1',
        [creatorId],
      )
    : undefined;
  return {
    type: 'state',
    live: Boolean(c?.is_live),
    inPrivate: Boolean(priv),
    title: c?.room_title ?? '',
    goal: c?.goal_tokens ? { label: c.goal_label, tokens: c.goal_tokens, progress: c.goal_progress } : null,
    viewers: ctx.hub.viewerCount(creatorId),
    hlsUrl: hls?.hls_path ? `/hls/${creatorId}/${hls.id}/live.m3u8` : null,
    poll: await pollState(ctx.db, creatorId),
    ticketShow: await ticketSummary(ctx.db, creatorId),
  };
}

export async function pushState(ctx: Ctx, creatorId: number): Promise<void> {
  ctx.hub.broadcast(creatorId, await roomState(ctx, creatorId));
}

export async function pushBalance(ctx: Ctx, userId: number): Promise<number> {
  const b = await balance(ctx.db, 'wallet', userId);
  ctx.hub.toUser(userId, { type: 'balance', balance: b });
  return b;
}

async function assertCanSpendIn(ctx: Ctx, viewer: User, creator: CreatorRow | undefined): Promise<CreatorRow> {
  if (!creator || creator.creator_status !== 'approved' || creator.status !== 'active') throw new ActionError('Room not available.');
  if (viewer.status !== 'active') throw new ActionError('Your account is suspended.');
  if (await isBanned(ctx.db, creator.user_id, viewer.id)) throw new ActionError('You cannot take part in this room.');
  return creator;
}

export async function sendTip(ctx: Ctx, viewer: User, creatorId: number, amount: number, message = '') {
  const { economy } = await ctx.settings.get();
  if (!Number.isInteger(amount) || amount < economy.tipMin) throw new ActionError(`The minimum tip is ${economy.tipMin} tokens.`);
  if (amount > 100000) throw new ActionError('Amount too high.');
  const creator = await assertCanSpendIn(ctx, viewer, await creatorById(ctx.db, creatorId));
  const note = message.trim().slice(0, 200);
  try {
    await ctx.db.tx(async (q) => {
      await spend(q, {
        kind: 'tip',
        fromUser: viewer.id,
        toCreator: creator.user_id,
        tokens: amount,
        creatorSharePct: economy.creatorSharePct,
        memo: `Tip to ${creator.display_name}`,
        meta: { message: note },
      });
      if (creator.goal_tokens) {
        await q.query('update creator_profiles set goal_progress = goal_progress + $2 where user_id = $1', [creator.user_id, amount]);
      }
    });
  } catch (err) {
    if (err instanceof InsufficientFunds) throw new ActionError('You do not have enough tokens.');
    throw err;
  }
  const level = levelFor(economy.levels, viewer.total_spent + amount).current.name;
  ctx.hub.broadcast(creator.user_id, { type: 'tip', user: viewer.display_name, level, amount, message: note, at: Date.now() }, { remember: true });
  await pushState(ctx, creator.user_id);
  return pushBalance(ctx, viewer.id);
}

export async function buyMenuItem(ctx: Ctx, viewer: User, itemId: number) {
  const item = await ctx.db.one<{ id: number; creator_id: number; label: string; price: number }>(
    'select id, creator_id, label, price from tip_menu_items where id = $1',
    [itemId],
  );
  if (!item) throw new ActionError('That action no longer exists.');
  const { economy } = await ctx.settings.get();
  const creator = await assertCanSpendIn(ctx, viewer, await creatorById(ctx.db, item.creator_id));
  try {
    await ctx.db.tx(async (q) => {
      await spend(q, {
        kind: 'menu',
        fromUser: viewer.id,
        toCreator: creator.user_id,
        tokens: item.price,
        creatorSharePct: economy.creatorSharePct,
        memo: `Menu: ${item.label}`,
        meta: { itemId: item.id, label: item.label },
      });
      if (creator.goal_tokens) {
        await q.query('update creator_profiles set goal_progress = goal_progress + $2 where user_id = $1', [creator.user_id, item.price]);
      }
    });
  } catch (err) {
    if (err instanceof InsufficientFunds) throw new ActionError('You do not have enough tokens.');
    throw err;
  }
  const level = levelFor(economy.levels, viewer.total_spent + item.price).current.name;
  ctx.hub.broadcast(
    creator.user_id,
    { type: 'tip', user: viewer.display_name, level, amount: item.price, label: item.label, message: '', at: Date.now() },
    { remember: true },
  );
  await pushState(ctx, creator.user_id);
  return pushBalance(ctx, viewer.id);
}
