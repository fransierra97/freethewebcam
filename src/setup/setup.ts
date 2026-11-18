import type { Ctx } from '../context.ts';
import { audit, createUser, ensureCreatorProfile, getUser, type User, UserError } from '../auth/users.ts';
import { DEFAULT_COMPLIANCE, loadDefaults, type Market } from '../settings.ts';

export interface SetupInput {
  siteName: string;
  mode: 'personal' | 'group';
  markets: Market[];
  email: string;
  displayName: string;
  password: string;
  adminIsCreator: boolean;
  /** Adults-only site (age verification, 18+ notices and 2257 records). */
  ageRestricted: boolean;
}

const MARKETS: Market[] = ['US', 'EU', 'LATAM'];

export async function completeSetup(ctx: Ctx, input: SetupInput): Promise<User> {
  const { site } = await ctx.settings.get();
  if (site.setupComplete) throw new UserError('The installation is already configured.');
  const name = input.siteName.trim().slice(0, 60);
  if (!name) throw new UserError('Give your site a name.');
  if (!['personal', 'group'].includes(input.mode)) throw new UserError('Invalid mode.');
  const markets = input.markets.filter((m) => MARKETS.includes(m));
  if (!markets.length) throw new UserError('Choose at least one market.');
  const defaults = loadDefaults();

  const userId = await ctx.db.tx(async (q) => {
    const admin = await createUser(q, {
      email: input.email,
      displayName: input.displayName,
      password: input.password,
      isAdmin: true,
    });
    if (input.adminIsCreator || input.mode === 'personal') {
      await q.query("update users set creator_status = 'pending_kyc' where id = $1", [admin.id]);
      await ensureCreatorProfile(q, admin);
    }
    await ctx.settings.set('economy', defaults.economy, q);
    await ctx.settings.set('regions', defaults.regions, q);
    await ctx.providers.preconfigure(defaults.regions, markets, q);
    await ctx.settings.set('site', { name, mode: input.mode, markets, setupComplete: true, ageRestricted: input.ageRestricted }, q);
    await ctx.settings.set('compliance', { ...DEFAULT_COMPLIANCE, require2257: input.ageRestricted }, q);
    await audit(q, admin.id, 'setup.complete', { mode: input.mode, markets });
    return admin.id;
  });
  ctx.settings.invalidate();
  return (await getUser(ctx.db, userId))!;
}
