/** Live polls and free giveaways. */
import { randomInt } from 'node:crypto';
import type { Ctx } from '../context.ts';
import type { Queryable } from '../db/index.ts';
import { audit, type User } from '../auth/users.ts';
import { InsufficientFunds, spend } from '../ledger/ledger.ts';
import { ActionError, creatorById, isBanned, pushBalance } from './actions.ts';

export interface PollState {
  id: number;
  question: string;
  options: string[];
  votes: number[];
  total: number;
  votePrice: number;
  status: 'open' | 'closed';
  endsAt: string;
}

export async function pollState(q: Queryable, creatorId: number): Promise<PollState | null> {
  // The open one, or the last one closed less than 2 minutes ago (to show the result).
  const p = await q.one<{ id: number; question: string; options: string[]; vote_price: number; status: 'open' | 'closed'; ends_at: Date }>(
    `select id, question, options, vote_price, status, ends_at from polls
     where creator_id = $1 and (status = 'open' or closed_at > now() - interval '2 minutes')
     order by id desc limit 1`,
    [creatorId],
  );
  if (!p) return null;
  const rows = await q.query<{ option_index: number; n: number }>(
    'select option_index, sum(weight)::int as n from poll_votes where poll_id = $1 group by option_index',
    [p.id],
  );
  const votes = p.options.map((_, i) => rows.find((r) => r.option_index === i)?.n ?? 0);
  return {
    id: p.id,
    question: p.question,
    options: p.options,
    votes,
    total: votes.reduce((a, b) => a + b, 0),
    votePrice: p.vote_price,
    status: p.status,
    endsAt: new Date(p.ends_at).toISOString(),
  };
}

async function pushPoll(ctx: Ctx, creatorId: number) {
  ctx.hub.broadcast(creatorId, { type: 'poll', poll: await pollState(ctx.db, creatorId) });
}

export async function createPoll(
  ctx: Ctx,
  creator: User,
  input: { question: string; options: string[]; votePrice: number; minutes: number },
): Promise<number> {
  const question = input.question.trim().slice(0, 140);
  const options = input.options.map((o) => o.trim().slice(0, 60)).filter(Boolean);
  if (!question) throw new ActionError('Write the question.');
  if (options.length < 2 || options.length > 5) throw new ActionError('Provide between 2 and 5 options.');
  if (!(Number.isInteger(input.votePrice) && input.votePrice >= 0 && input.votePrice <= 10000)) throw new ActionError('Invalid price per vote.');
  if (!(Number.isInteger(input.minutes) && input.minutes >= 1 && input.minutes <= 60)) throw new ActionError('Duration must be between 1 and 60 minutes.');
  const c = await creatorById(ctx.db, creator.id);
  if (!c?.is_live) throw new ActionError('Polls can only be started while live.');
  if (await ctx.db.one("select 1 from polls where creator_id = $1 and status = 'open'", [creator.id])) {
    throw new ActionError('A poll is already open.');
  }
  const row = await ctx.db.one<{ id: number }>(
    `insert into polls (creator_id, question, options, vote_price, ends_at)
     values ($1, $2, $3, $4, now() + make_interval(mins => $5)) returning id`,
    [creator.id, question, JSON.stringify(options), input.votePrice, input.minutes],
  );
  await audit(ctx.db, creator.id, 'poll.create', { pollId: row!.id });
  ctx.hub.broadcast(creator.id, { type: 'system', text: `New poll: ${question}` }, { remember: true });
  await pushPoll(ctx, creator.id);
  return row!.id;
}

/** Paid: each vote costs tokens and people can vote several times. Free: one vote per person. */
export async function vote(ctx: Ctx, user: User, creatorId: number, optionIndex: number, times = 1): Promise<PollState | null> {
  const p = await ctx.db.one<{ id: number; options: string[]; vote_price: number; status: string; ends_at: Date }>(
    "select id, options, vote_price, status, ends_at from polls where creator_id = $1 and status = 'open'",
    [creatorId],
  );
  if (!p || new Date(p.ends_at).getTime() < Date.now()) throw new ActionError('There is no open poll.');
  if (!(Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < p.options.length)) throw new ActionError('Invalid option.');
  if (user.id === creatorId) throw new ActionError('You cannot vote in your own poll.');
  if (await isBanned(ctx.db, creatorId, user.id)) throw new ActionError('You cannot take part in this room.');
  if (p.vote_price === 0) {
    if (await ctx.db.one('select 1 from poll_votes where poll_id = $1 and user_id = $2', [p.id, user.id])) {
      throw new ActionError('You have already voted.');
    }
    await ctx.db.query('insert into poll_votes (poll_id, user_id, option_index) values ($1, $2, $3)', [p.id, user.id, optionIndex]);
  } else {
    const n = Math.max(1, Math.min(100, Math.trunc(times)));
    const { economy } = await ctx.settings.get();
    try {
      await ctx.db.tx(async (q) => {
        const txId = await spend(q, {
          kind: 'poll',
          fromUser: user.id,
          toCreator: creatorId,
          tokens: p.vote_price * n,
          creatorSharePct: economy.creatorSharePct,
          memo: `Poll vote #${p.id}`,
          meta: { pollId: p.id, optionIndex, votes: n },
        });
        await q.query('insert into poll_votes (poll_id, user_id, option_index, weight, tx_id) values ($1, $2, $3, $4, $5)', [
          p.id,
          user.id,
          optionIndex,
          n,
          txId,
        ]);
      });
    } catch (err) {
      if (err instanceof InsufficientFunds) throw new ActionError('No tienes tokens suficientes.');
      throw err;
    }
    await pushBalance(ctx, user.id);
  }
  await pushPoll(ctx, creatorId);
  return pollState(ctx.db, creatorId);
}

export async function closePoll(ctx: Ctx, creatorId: number): Promise<void> {
  const rows = await ctx.db.query<{ id: number }>(
    "update polls set status = 'closed', closed_at = now() where creator_id = $1 and status = 'open' returning id",
    [creatorId],
  );
  if (!rows.length) return;
  const state = await pollState(ctx.db, creatorId);
  if (state) {
    const max = Math.max(...state.votes);
    const winners = state.options.filter((_, i) => state.votes[i] === max && max > 0);
    ctx.hub.broadcast(
      creatorId,
      { type: 'system', text: winners.length ? `Poll closed. Winner: ${winners.join(' / ')} (${max} votes)` : 'Poll closed with no votes.' },
      { remember: true },
    );
  }
  await pushPoll(ctx, creatorId);
}

/** Closes expired polls (called from a timer). */
export async function closeExpiredPolls(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.query<{ creator_id: number }>("select creator_id from polls where status = 'open' and ends_at <= now()");
  for (const r of rows) await closePoll(ctx, r.creator_id);
}

/**
 * Free giveaway among those currently in the room (or only the followers present).
 * Entry must never depend on paying: it could be considered an illegal lottery.
 */
export async function runRaffle(ctx: Ctx, creator: User, prize: string, audience: 'present' | 'followers') {
  const text = prize.trim().slice(0, 120);
  if (!text) throw new ActionError('Describe the prize.');
  const c = await creatorById(ctx.db, creator.id);
  if (!c?.is_live) throw new ActionError('Giveaways can only be run while live.');
  let entrants = ctx.hub.presentUserIds(creator.id).filter((id) => id !== creator.id);
  if (entrants.length) {
    const banned = await ctx.db.query<{ user_id: number }>('select user_id from room_bans where creator_id = $1', [creator.id]);
    const bannedSet = new Set(banned.map((b) => b.user_id));
    entrants = entrants.filter((id) => !bannedSet.has(id));
  }
  if (audience === 'followers' && entrants.length) {
    const rows = await ctx.db.query<{ follower_id: number }>(
      'select follower_id from follows where creator_id = $1 and follower_id = any($2::int[])',
      [creator.id, entrants],
    );
    entrants = rows.map((r) => r.follower_id);
  }
  if (!entrants.length) throw new ActionError('There is nobody who can take part right now.');
  const winnerId = entrants[randomInt(entrants.length)];
  const winner = await ctx.db.one<{ display_name: string }>('select display_name from users where id = $1', [winnerId]);
  await ctx.db.query('insert into raffles (creator_id, prize, audience, entrants, winner_id) values ($1, $2, $3, $4, $5)', [
    creator.id,
    text,
    audience,
    entrants.length,
    winnerId,
  ]);
  await audit(ctx.db, creator.id, 'raffle.run', { winnerId, entrants: entrants.length });
  ctx.hub.broadcast(creator.id, { type: 'raffle', prize: text, winner: winner!.display_name, entrants: entrants.length }, { remember: true });
  ctx.hub.toUser(winnerId, { type: 'system', creatorId: creator.id, text: `You won the giveaway: ${text}!` });
  return { winner: winner!.display_name, entrants: entrants.length };
}
