import type { Ctx } from './context.ts';
import type { Queryable } from './db/index.ts';
import type { User } from './auth/users.ts';
import { ruleFor } from './regions.ts';
import { isAgeRestricted } from './settings.ts';

export type AccessDenied = 'login' | 'banned' | 'verify' | 'self_declare' | 'blocked' | 'no_provider';

export interface AccessResult {
  ok: boolean;
  reason?: AccessDenied;
  providerId?: string;
}

/** Can this user view content from this country? */
export async function viewerAccess(ctx: Ctx, user: User | undefined, country: string): Promise<AccessResult> {
  if (!user) return { ok: false, reason: 'login' };
  if (user.status === 'banned') return { ok: false, reason: 'banned' };
  if (user.is_admin) return { ok: true };
  if (user.creator_status === 'approved') return { ok: true }; // verified via KYC
  const { regions, site } = await ctx.settings.get();
  const rule = ruleFor(regions, country);
  if (rule.ageCheck === 'blocked') return { ok: false, reason: 'blocked' };
  // On a general-audience site, age verification is not required to watch.
  if (!isAgeRestricted(site)) return { ok: true };
  if (user.age_verified_at) return { ok: true };
  if (rule.ageCheck === 'self_declare' && user.age_self_declared_at) return { ok: true };
  const provider = await ctx.providers.pick(rule.viewerAgeProviders, 'viewer_age');
  if (rule.ageCheck === 'self_declare') return { ok: false, reason: 'self_declare', providerId: provider?.manifest.id };
  if (!provider) return { ok: false, reason: 'no_provider' };
  return { ok: false, reason: 'verify', providerId: provider.manifest.id };
}

export async function hasApprovedKyc(q: Queryable, userId: number): Promise<boolean> {
  const row = await q.one(
    "select 1 from verifications where user_id = $1 and purpose = 'creator_kyc' and status = 'approved'",
    [userId],
  );
  return Boolean(row);
}

/**
 * Broadcasting requires: active account, approved identity verification, approved creator and,
 * if the operator requires it (default yes), a verified 2257 record.
 */
export async function canBroadcast(ctx: Ctx, user: User | undefined): Promise<{ ok: boolean; reason?: string }> {
  if (!user) return { ok: false, reason: 'Log in.' };
  if (user.status !== 'active') return { ok: false, reason: 'Your account is suspended.' };
  if (!(await hasApprovedKyc(ctx.db, user.id))) return { ok: false, reason: 'Your identity and age verification is missing.' };
  if (user.creator_status !== 'approved') return { ok: false, reason: 'Your creator profile is not approved yet.' };
  const { compliance } = await ctx.settings.get();
  if (compliance.require2257) {
    const r = await ctx.db.one<{ status: string }>("select status from performer_records where owner_id = $1 and kind = 'primary'", [user.id]);
    if (r?.status !== 'verified') return { ok: false, reason: 'Your verified performer legal record is missing (Studio → Legal records).' };
  }
  return { ok: true };
}
