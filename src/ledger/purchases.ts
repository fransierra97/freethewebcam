import type { Ctx } from '../context.ts';
import { UserError, type User } from '../auth/users.ts';
import { ruleFor } from '../regions.ts';
import { accountId, creditPurchase, post } from './ledger.ts';
import { audit } from '../auth/users.ts';

export interface Purchase {
  id: number;
  user_id: number;
  package_id: string;
  tokens: number;
  price_cents: number;
  currency: string;
  provider: string;
  status: 'pending' | 'paid' | 'failed' | 'refunded' | 'chargeback';
  provider_ref: string | null;
  test: boolean;
  created_at: Date;
  paid_at: Date | null;
}

export async function startPurchase(ctx: Ctx, user: User, packageId: string, country: string): Promise<string> {
  const { economy, regions } = await ctx.settings.get();
  const pkg = economy.packages.find((p) => p.id === packageId);
  if (!pkg) throw new UserError('That package does not exist.');
  const provider = await ctx.providers.pick(ruleFor(regions, country).paymentProviders, 'payments');
  if (!provider) throw new UserError('Payments are not available in your region yet.');
  const row = await ctx.db.one<{ id: number }>(
    `insert into purchases (user_id, package_id, tokens, price_cents, currency, provider, test)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [user.id, pkg.id, pkg.tokens, pkg.priceCents, economy.currency, provider.manifest.id, provider.mode === 'test'],
  );
  const { redirectUrl } = await ctx.providers.startCheckout(provider.manifest.id, {
    purchaseId: row!.id,
    tokens: pkg.tokens,
    priceCents: pkg.priceCents,
    currency: economy.currency,
  });
  return redirectUrl;
}

export async function getPurchase(ctx: Ctx, id: number): Promise<Purchase | undefined> {
  return ctx.db.one('select * from purchases where id = $1', [id]);
}

/** Provider confirmation. Idempotent: a repeated payment is not credited twice. */
export async function completePurchase(ctx: Ctx, id: number, paid: boolean, providerRef?: string): Promise<Purchase> {
  return ctx.db.tx(async (q) => {
    if (providerRef) await q.query('update purchases set provider_ref = coalesce(provider_ref, $2) where id = $1', [id, providerRef]);
    const p = await q.one<Purchase>('select * from purchases where id = $1 for update', [id]);
    if (!p) throw new UserError('Purchase not found.');
    if (p.status !== 'pending') return p;
    if (!paid) {
      await q.query("update purchases set status = 'failed' where id = $1", [id]);
      return { ...p, status: 'failed' };
    }
    await q.query("update purchases set status = 'paid', paid_at = now() where id = $1", [id]);
    await creditPurchase(q, p.user_id, p.tokens, p.id, p.test);
    return { ...p, status: 'paid' };
  });
}

/**
 * Refund, void or chargeback: removes the purchased tokens.
 * The balance can go negative if they were already spent; the user cannot spend again until it is made up.
 */
export async function reversePurchase(
  ctx: Ctx,
  id: number,
  reason: 'refund' | 'chargeback' | 'void',
  providerRef?: string,
): Promise<Purchase> {
  return ctx.db.tx(async (q) => {
    const p = await q.one<Purchase>('select * from purchases where id = $1 for update', [id]);
    if (!p) throw new UserError('Purchase not found.');
    if (p.status !== 'paid') return p;
    const status = reason === 'chargeback' ? 'chargeback' : 'refunded';
    await q.query('update purchases set status = $2, provider_ref = coalesce(provider_ref, $3) where id = $1', [id, status, providerRef ?? null]);
    const wallet = await accountId(q, 'wallet', p.user_id);
    const purchases = await accountId(q, 'purchases', null);
    await post(q, {
      kind: 'purchase_reversal',
      memo: `${reason === 'chargeback' ? 'Chargeback' : 'Refund'} of purchase #${p.id}`,
      idempotencyKey: `purchase-reversal:${p.id}`,
      entries: [
        { account: wallet, amount: -p.tokens },
        { account: purchases, amount: p.tokens },
      ],
      meta: { purchaseId: p.id, reason },
      test: p.test,
    });
    await audit(q, null, `purchase.${status}`, { purchaseId: p.id, userId: p.user_id, tokens: p.tokens });
    return { ...p, status };
  });
}
