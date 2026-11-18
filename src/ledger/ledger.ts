import type { Queryable } from '../db/index.ts';

export type AccountKind = 'wallet' | 'earnings' | 'platform' | 'purchases' | 'payouts' | 'promotions';
export type TxKind = 'album' | 'ticket' | 'ticket_refund' | 'dm' | 'poll' | 'purchase' | 'purchase_reversal' | 'tip' | 'menu' | 'private' | 'payout' | 'payout_reversal' | 'adjustment';

export class LedgerError extends Error {}
export class InsufficientFunds extends LedgerError {
  constructor() {
    super('Insufficient balance');
  }
}

export async function accountId(q: Queryable, kind: AccountKind, userId: number | null): Promise<number> {
  if (userId === null) {
    const row = await q.one<{ id: number }>('select id from accounts where kind = $1 and user_id is null', [kind]);
    if (!row) throw new LedgerError(`Missing system account ${kind}`);
    return row.id;
  }
  const existing = await q.one<{ id: number }>('select id from accounts where kind = $1 and user_id = $2', [kind, userId]);
  if (existing) return existing.id;
  const created = await q.one<{ id: number }>(
    'insert into accounts (kind, user_id) values ($1, $2) on conflict do nothing returning id',
    [kind, userId],
  );
  if (created) return created.id;
  return (await q.one<{ id: number }>('select id from accounts where kind = $1 and user_id = $2', [kind, userId]))!.id;
}

export async function balance(q: Queryable, kind: AccountKind, userId: number | null): Promise<number> {
  const id = await accountId(q, kind, userId);
  const row = await q.one<{ total: number }>(
    'select coalesce(sum(amount), 0)::int as total from ledger_entries where account_id = $1',
    [id],
  );
  return row?.total ?? 0;
}

interface PostInput {
  kind: TxKind;
  memo: string;
  entries: { account: number; amount: number }[];
  /** Accounts that must not go negative after the entry. */
  noNegative?: number[];
  idempotencyKey?: string;
  meta?: Record<string, unknown>;
  test?: boolean;
}

/** Posts a ledger entry. Must be called inside a database transaction. */
export async function post(q: Queryable, input: PostInput): Promise<number> {
  const entries = input.entries.filter((e) => e.amount !== 0);
  const sum = entries.reduce((acc, e) => acc + e.amount, 0);
  if (sum !== 0) throw new LedgerError('The entry does not balance');
  if (!entries.every((e) => Number.isInteger(e.amount))) throw new LedgerError('Amounts must be integers');
  if (input.idempotencyKey) {
    const dup = await q.one<{ id: number }>('select id from ledger_tx where idempotency_key = $1', [input.idempotencyKey]);
    if (dup) return dup.id;
  }
  // Lock the accounts that must not go negative to avoid races.
  for (const acc of input.noNegative ?? []) {
    await q.query('select id from accounts where id = $1 for update', [acc]);
  }
  const tx = await q.one<{ id: number }>(
    'insert into ledger_tx (kind, idempotency_key, memo, meta, test) values ($1, $2, $3, $4, $5) returning id',
    [input.kind, input.idempotencyKey ?? null, input.memo, JSON.stringify(input.meta ?? {}), input.test ?? false],
  );
  for (const e of entries) {
    await q.query('insert into ledger_entries (tx_id, account_id, amount) values ($1, $2, $3)', [tx!.id, e.account, e.amount]);
  }
  for (const acc of input.noNegative ?? []) {
    const row = await q.one<{ total: number }>(
      'select coalesce(sum(amount), 0)::int as total from ledger_entries where account_id = $1',
      [acc],
    );
    if ((row?.total ?? 0) < 0) throw new InsufficientFunds();
  }
  return tx!.id;
}

export async function creditPurchase(
  q: Queryable,
  userId: number,
  tokens: number,
  purchaseId: number,
  test: boolean,
): Promise<number> {
  const wallet = await accountId(q, 'wallet', userId);
  const purchases = await accountId(q, 'purchases', null);
  return post(q, {
    kind: 'purchase',
    memo: `Purchase of ${tokens} tokens`,
    idempotencyKey: `purchase:${purchaseId}`,
    entries: [
      { account: purchases, amount: -tokens },
      { account: wallet, amount: tokens },
    ],
    meta: { purchaseId },
    test,
  });
}

/** A viewer spends tokens on a creator, split between creator and platform. */
export async function spend(
  q: Queryable,
  opts: {
    kind: 'tip' | 'menu' | 'private' | 'ticket' | 'poll' | 'dm' | 'album';
    fromUser: number;
    toCreator: number;
    tokens: number;
    creatorSharePct: number;
    memo: string;
    meta?: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Promise<number> {
  if (!Number.isInteger(opts.tokens) || opts.tokens <= 0) throw new LedgerError('Invalid amount');
  if (opts.fromUser === opts.toCreator) throw new LedgerError('You cannot send tokens to yourself');
  const wallet = await accountId(q, 'wallet', opts.fromUser);
  const earnings = await accountId(q, 'earnings', opts.toCreator);
  const platform = await accountId(q, 'platform', null);
  const creatorPart = Math.floor((opts.tokens * opts.creatorSharePct) / 100);
  const txId = await post(q, {
    kind: opts.kind,
    memo: opts.memo,
    idempotencyKey: opts.idempotencyKey,
    entries: [
      { account: wallet, amount: -opts.tokens },
      { account: earnings, amount: creatorPart },
      { account: platform, amount: opts.tokens - creatorPart },
    ],
    noNegative: [wallet],
    meta: { ...opts.meta, fromUser: opts.fromUser, toCreator: opts.toCreator, creatorPart },
  });
  await q.query('update users set total_spent = total_spent + $2 where id = $1', [opts.fromUser, opts.tokens]);
  return txId;
}

/** The admin grants or removes tokens (e.g. for the demo or a refund). */
export async function adjust(q: Queryable, userId: number, tokens: number, memo: string, actorId: number): Promise<number> {
  const wallet = await accountId(q, 'wallet', userId);
  const promotions = await accountId(q, 'promotions', null);
  return post(q, {
    kind: 'adjustment',
    memo,
    entries: [
      { account: promotions, amount: -tokens },
      { account: wallet, amount: tokens },
    ],
    noNegative: tokens < 0 ? [wallet] : [],
    meta: { actorId, userId },
    test: true,
  });
}

export async function holdPayout(q: Queryable, creatorId: number, tokens: number, payoutId: number): Promise<number> {
  const earnings = await accountId(q, 'earnings', creatorId);
  const payouts = await accountId(q, 'payouts', null);
  return post(q, {
    kind: 'payout',
    memo: `Payout request #${payoutId}`,
    idempotencyKey: `payout:${payoutId}`,
    entries: [
      { account: earnings, amount: -tokens },
      { account: payouts, amount: tokens },
    ],
    noNegative: [earnings],
    meta: { payoutId },
  });
}

export async function reversePayout(q: Queryable, creatorId: number, tokens: number, payoutId: number): Promise<number> {
  const earnings = await accountId(q, 'earnings', creatorId);
  const payouts = await accountId(q, 'payouts', null);
  return post(q, {
    kind: 'payout_reversal',
    memo: `Payout #${payoutId} rejected`,
    idempotencyKey: `payout-reversal:${payoutId}`,
    entries: [
      { account: payouts, amount: -tokens },
      { account: earnings, amount: tokens },
    ],
    meta: { payoutId },
  });
}

/** Integrity check: every entry must sum to zero. */
export async function unbalancedTransactions(q: Queryable): Promise<number> {
  const row = await q.one<{ n: number }>(
    `select count(*)::int as n from (
       select tx_id from ledger_entries group by tx_id having sum(amount) <> 0
     ) t`,
  );
  return row?.n ?? 0;
}
