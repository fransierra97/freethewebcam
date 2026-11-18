/** Numbers for the current broadcast, for the creator's live panel. */
import type { Ctx } from '../context.ts';
import { currentSession } from '../compliance/records.ts';

const peaks = new Map<number, number>();

export function notePeak(creatorId: number, viewers: number): void {
  if (viewers > (peaks.get(creatorId) ?? 0)) peaks.set(creatorId, viewers);
}

export function resetPeak(creatorId: number): void {
  peaks.delete(creatorId);
}

export async function sessionStats(ctx: Ctx, creatorId: number) {
  const session = await currentSession(ctx.db, creatorId);
  if (!session) return null;
  const s = await ctx.db.one<{ started_at: Date }>('select started_at from broadcast_sessions where id = $1', [session.id]);
  const since = s!.started_at;
  const earned = await ctx.db.one<{ total: number }>(
    `select coalesce(sum(e.amount), 0)::int as total from ledger_entries e
     join ledger_tx t on t.id = e.tx_id join accounts a on a.id = e.account_id
     where a.kind = 'earnings' and a.user_id = $1 and t.created_at >= $2`,
    [creatorId, since],
  );
  const byKind = await ctx.db.query<{ kind: string; n: number; tokens: number }>(
    `select t.kind, count(distinct t.id)::int as n, coalesce(sum(-e.amount), 0)::int as tokens
     from ledger_tx t join ledger_entries e on e.tx_id = t.id join accounts a on a.id = e.account_id and a.kind = 'wallet'
     where (t.meta->>'toCreator')::int = $1 and t.created_at >= $2 and e.amount < 0
     group by t.kind`,
    [creatorId, since],
  );
  const topFans = await ctx.db.query<{ name: string; tokens: number }>(
    `select u.display_name as name, sum(-e.amount)::int as tokens
     from ledger_tx t join ledger_entries e on e.tx_id = t.id join accounts a on a.id = e.account_id and a.kind = 'wallet'
     join users u on u.id = a.user_id
     where (t.meta->>'toCreator')::int = $1 and t.created_at >= $2 and e.amount < 0
     group by u.display_name order by 2 desc limit 5`,
    [creatorId, since],
  );
  const followers = await ctx.db.one<{ n: number }>(
    'select count(*)::int as n from follows where creator_id = $1 and created_at >= $2',
    [creatorId, since],
  );
  const viewers = ctx.hub.viewerCount(creatorId);
  notePeak(creatorId, viewers);
  const { economy } = await ctx.settings.get();
  return {
    sessionId: session.id,
    startedAt: new Date(since).toISOString(),
    earnedTokens: earned?.total ?? 0,
    earnedMoney: ((earned?.total ?? 0) * economy.tokenValueCents) / 100,
    currency: economy.currency,
    byKind: Object.fromEntries(byKind.map((k) => [k.kind, { count: k.n, tokens: k.tokens }])),
    topFans,
    newFollowers: followers?.n ?? 0,
    viewers,
    peakViewers: peaks.get(creatorId) ?? viewers,
  };
}
