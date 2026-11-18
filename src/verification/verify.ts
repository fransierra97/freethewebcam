import type { Ctx } from '../context.ts';
import { audit, type User } from '../auth/users.ts';
import { ruleFor } from '../regions.ts';
import { UserError } from '../auth/users.ts';
import { VERIFICATION_ADAPTERS } from '../providers/adapters/index.ts';

export type Purpose = 'creator_kyc' | 'viewer_age';

export interface Verification {
  id: number;
  user_id: number;
  purpose: Purpose;
  provider: string;
  status: 'pending' | 'approved' | 'rejected';
  test: boolean;
  provider_ref: string | null;
  created_at: Date;
  decided_at: Date | null;
}

export async function startVerification(ctx: Ctx, user: User, purpose: Purpose, country: string): Promise<string> {
  const { regions } = await ctx.settings.get();
  const candidates = purpose === 'creator_kyc' ? regions.creatorKycProviders : ruleFor(regions, country).viewerAgeProviders;
  const provider = await ctx.providers.pick(candidates, purpose);
  if (!provider) throw new UserError('No verification provider is active. Please notify the administrators.');
  const row = await ctx.db.one<{ id: number }>(
    'insert into verifications (user_id, purpose, provider, test) values ($1, $2, $3, $4) returning id',
    [user.id, purpose, provider.manifest.id, provider.mode === 'test'],
  );
  const { redirectUrl, providerRef } = await ctx.providers.startVerification(provider.manifest.id, row!.id, purpose);
  if (providerRef) await ctx.db.query('update verifications set provider_ref = $2 where id = $1', [row!.id, providerRef]);
  return redirectUrl;
}

/** Queries the live provider for the result and applies it if already decided. */
export async function refreshVerification(ctx: Ctx, id: number): Promise<Verification | undefined> {
  const v = await getVerification(ctx, id);
  if (!v || v.status !== 'pending' || v.test || !v.provider_ref) return v;
  const adapter = VERIFICATION_ADAPTERS[v.provider];
  if (!adapter) return v;
  const decision = await adapter.fetchResult(await ctx.providers.env(v.provider), v.provider_ref, v.purpose);
  if (decision === 'pending') return v;
  return decideVerification(ctx, id, decision === 'approved', null);
}

export async function getVerification(ctx: Ctx, id: number): Promise<Verification | undefined> {
  return ctx.db.one('select * from verifications where id = $1', [id]);
}

/** Applies the result returned by the provider (or the simulation). */
export async function decideVerification(ctx: Ctx, id: number, approved: boolean, actorId: number | null): Promise<Verification> {
  const { site } = await ctx.settings.get();
  return ctx.db.tx(async (q) => {
    const v = await q.one<Verification>('select * from verifications where id = $1 for update', [id]);
    if (!v) throw new UserError('Verification not found.');
    if (v.status !== 'pending') return v;
    const status = approved ? 'approved' : 'rejected';
    await q.query('update verifications set status = $2, decided_at = now() where id = $1', [id, status]);
    if (approved && v.purpose === 'viewer_age') {
      await q.query('update users set age_verified_at = now() where id = $1', [v.user_id]);
    }
    if (approved && v.purpose === 'creator_kyc') {
      await q.query('update users set age_verified_at = coalesce(age_verified_at, now()) where id = $1', [v.user_id]);
      const u = await q.one<{ is_admin: boolean; creator_status: string }>(
        'select is_admin, creator_status from users where id = $1',
        [v.user_id],
      );
      if (u && u.creator_status === 'pending_kyc') {
        // In group mode the admins review each creator; an admin approves themselves.
        const next = site.mode === 'group' && !u.is_admin ? 'pending_approval' : 'approved';
        await q.query('update users set creator_status = $2 where id = $1', [v.user_id, next]);
      }
    }
    await audit(q, actorId, `verification.${status}`, { verificationId: id, purpose: v.purpose, provider: v.provider, test: v.test });
    return { ...v, status };
  });
}
