import type { Ctx } from '../context.ts';
import { balance } from '../ledger/ledger.ts';
import { completePurchase, getPurchase, reversePurchase } from '../ledger/purchases.ts';
import { decideVerification, getVerification, refreshVerification } from '../verification/verify.ts';
import { PAYMENT_ADAPTERS, VERIFICATION_ADAPTERS } from './adapters/index.ts';
import { WebhookRejected, type PaymentEvent, type WebhookReply, type WebhookRequest } from './adapters/types.ts';

async function log(ctx: Ctx, provider: string, ok: boolean, note: string, ip: string) {
  await ctx.db.query('insert into webhook_log (provider, ok, note, ip) values ($1, $2, $3, $4)', [provider, ok, note.slice(0, 500), ip]);
}

async function applyPayment(ctx: Ctx, provider: string, e: PaymentEvent): Promise<string> {
  const p = await getPurchase(ctx, e.purchaseId);
  if (!p) return `purchase ${e.purchaseId} does not exist`;
  if (p.provider !== provider) return `purchase ${p.id} belongs to another provider`;
  if (p.test) return `purchase ${p.id} is a test purchase`;
  if (e.kind === 'paid') {
    // Extra safeguard: the amount charged must match the package price.
    if (e.amountCents !== undefined && Math.abs(e.amountCents - p.price_cents) > 1) {
      return `amount mismatch on purchase ${p.id}: ${e.amountCents} ≠ ${p.price_cents}`;
    }
    if (e.currency && e.currency.toUpperCase() !== p.currency) return `currency mismatch on purchase ${p.id}`;
    const done = await completePurchase(ctx, p.id, true, e.providerRef);
    ctx.hub.toUser(p.user_id, { type: 'balance', balance: await balance(ctx.db, 'wallet', p.user_id) });
    return `purchase ${p.id}: ${done.status}`;
  }
  if (e.kind === 'failed') {
    const done = await completePurchase(ctx, p.id, false, e.providerRef);
    return `purchase ${p.id}: ${done.status}`;
  }
  const done = await reversePurchase(ctx, p.id, e.reason, e.providerRef);
  ctx.hub.toUser(p.user_id, { type: 'balance', balance: await balance(ctx.db, 'wallet', p.user_id) });
  return `purchase ${p.id}: ${done.status}`;
}

/** Processes a notification from a live provider. Throws WebhookRejected if it is not authentic. */
export async function handleWebhook(ctx: Ctx, provider: string, req: WebhookRequest): Promise<WebhookReply> {
  const status = await ctx.providers.status(provider);
  if (!status || !status.enabled || status.mode !== 'live') {
    await log(ctx, provider, false, 'provider not active in live mode', req.ip);
    return { status: 404, body: 'not found' };
  }
  const env = await ctx.providers.env(provider);
  try {
    const pay = PAYMENT_ADAPTERS[provider];
    if (pay) {
      const { events, reply } = await pay.webhook(env, req);
      const notes = [];
      for (const e of events) notes.push(await applyPayment(ctx, provider, e));
      await log(ctx, provider, true, notes.join('; ') || 'no changes', req.ip);
      return reply ?? { status: 200, body: 'ok' };
    }
    const ver = VERIFICATION_ADAPTERS[provider];
    if (ver) {
      const r = await ver.webhook(env, req);
      let v = r.verificationId ? await getVerification(ctx, r.verificationId) : undefined;
      if (!v && r.providerRef) {
        v = await ctx.db.one('select * from verifications where provider = $1 and provider_ref = $2', [provider, r.providerRef]);
      }
      let note = 'verification not found';
      if (v && v.provider === provider && !v.test) {
        if (r.decision && r.decision !== 'pending') {
          await decideVerification(ctx, v.id, r.decision === 'approved', null);
          note = `verification ${v.id}: ${r.decision}`;
        } else {
          const after = await refreshVerification(ctx, v.id);
          note = `verification ${v.id}: ${after?.status ?? 'pending'}`;
        }
      }
      await log(ctx, provider, true, note, req.ip);
      return r.reply ?? { status: 200, body: 'ok' };
    }
    return { status: 404, body: 'not found' };
  } catch (err) {
    if (err instanceof WebhookRejected) {
      await log(ctx, provider, false, err.message, req.ip);
      return { status: 401, body: 'rejected' };
    }
    await log(ctx, provider, false, `error: ${(err as Error).message}`, req.ip);
    throw err;
  }
}
