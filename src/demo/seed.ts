import type { Ctx } from '../context.ts';
import { createUser, ensureCreatorProfile, type User } from '../auth/users.ts';
import { adjust } from '../ledger/ledger.ts';
import { completeSetup } from '../setup/setup.ts';
import { decideVerification } from '../verification/verify.ts';
import { ensurePrimaryRecord, reviewRecord, submitRecord } from '../compliance/records.ts';
import { getUser } from '../auth/users.ts';

// 1×1 px PNG: stands in for the document copy in the demo.
const DEMO_ID_COPY = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Verified 2257 record with FICTITIOUS data, for the demo only. */
async function demoRecord(ctx: Ctx, user: User, admin: User) {
  const fresh = (await getUser(ctx.db, user.id))!;
  const r = await ensurePrimaryRecord(ctx.db, fresh, fresh.display_name);
  await submitRecord(ctx, r, fresh, {
    pii: {
      legalName: `DEMO ${fresh.display_name} Fictional`,
      dateOfBirth: '1995-01-01',
      aliases: [fresh.display_name],
      idType: 'Passport',
      idNumber: `DEMO-${fresh.id}`,
      idIssuer: 'Demo',
      idExpiry: '2035-01-01',
    },
    idCopy: { data: DEMO_ID_COPY, mimetype: 'image/png' },
    consent: true,
  });
  await reviewRecord(ctx, r.id, admin, true, 'Fictitious demo data');
}

export const DEMO_PASSWORD = 'demo1234';

export const DEMO_ACCOUNTS = [
  { email: 'admin@demo.local', name: 'Admin', role: 'Admin (also streams)' },
  { email: 'luna@demo.local', name: 'Luna', role: 'Approved creator, with tip menu and goal' },
  { email: 'sol@demo.local', name: 'Sol', role: 'Approved creator' },
  { email: 'nova@demo.local', name: 'Nova', role: 'Creator pending approval' },
  { email: 'fan@demo.local', name: 'Fan', role: 'Verified viewer with 2000 tokens' },
  { email: 'newbie@demo.local', name: 'Newbie', role: 'Unverified viewer with no tokens' },
];

async function verify(ctx: Ctx, user: User, purpose: 'creator_kyc' | 'viewer_age') {
  const v = await ctx.db.one<{ id: number }>(
    "insert into verifications (user_id, purpose, provider, test) values ($1, $2, 'yoti', true) returning id",
    [user.id, purpose],
  );
  await decideVerification(ctx, v!.id, true, null);
}

async function creator(ctx: Ctx, email: string, name: string, approved: boolean): Promise<User> {
  const u = await createUser(ctx.db, { email, displayName: name, password: DEMO_PASSWORD });
  await ctx.db.query("update users set creator_status = 'pending_kyc' where id = $1", [u.id]);
  await ensureCreatorProfile(ctx.db, u);
  await verify(ctx, { ...u, creator_status: 'pending_kyc' }, 'creator_kyc');
  if (approved) await ctx.db.query("update users set creator_status = 'approved' where id = $1", [u.id]);
  return u;
}

/** Creates a demo installation the first time. Does nothing if one already exists. */
export async function seedDemo(ctx: Ctx): Promise<void> {
  const { site } = await ctx.settings.get();
  if (site.setupComplete) return;
  const admin = await completeSetup(ctx, {
    siteName: 'FreeTheWebcam Demo',
    mode: 'group',
    markets: ['US', 'EU', 'LATAM'],
    email: 'admin@demo.local',
    displayName: 'Admin',
    password: DEMO_PASSWORD,
    adminIsCreator: true,
    // The demo is general-audience; adults-only mode can be enabled in Admin → Site.
    ageRestricted: false,
  });
  await verify(ctx, admin, 'creator_kyc');
  await demoRecord(ctx, admin, admin);

  const luna = await creator(ctx, 'luna@demo.local', 'Luna', true);
  await ctx.db.query(
    `update creator_profiles set room_title = 'Chat and live music', bio = 'Demo profile.',
       private_price_per_min = 30, goal_label = 'Tonight''s goal', goal_tokens = 500 where user_id = $1`,
    [luna.id],
  );
  for (const [label, price, position] of [
    ['Personal greeting', 10, 0],
    ['Pick the next song', 25, 1],
    ['Answer a question', 50, 2],
  ] as const) {
    await ctx.db.query('insert into tip_menu_items (creator_id, label, price, position) values ($1, $2, $3, $4)', [luna.id, label, price, position]);
  }
  await demoRecord(ctx, luna, admin);
  const sol = await creator(ctx, 'sol@demo.local', 'Sol', true);
  await demoRecord(ctx, sol, admin);
  await ctx.db.query("update creator_profiles set room_title = 'Test stream' where user_id = $1", [sol.id]);
  await creator(ctx, 'nova@demo.local', 'Nova', false);

  const fan = await createUser(ctx.db, { email: 'fan@demo.local', displayName: 'Fan', password: DEMO_PASSWORD });
  await verify(ctx, fan, 'viewer_age');
  await ctx.db.tx((q) => adjust(q, fan.id, 2000, 'Demo balance', admin.id));
  await createUser(ctx.db, { email: 'newbie@demo.local', displayName: 'Newbie', password: DEMO_PASSWORD });
  // Sample social features: Fan follows Luna, Luna charges 10 tokens per message and has a scheduled show.
  await ctx.db.query('insert into follows (follower_id, creator_id) values ($1, $2)', [fan.id, luna.id]);
  await ctx.db.query('update creator_profiles set dm_price = 10, cam2cam_price_per_min = 15 where user_id = $1', [luna.id]);
  await ctx.db.query("insert into scheduled_shows (creator_id, starts_at, title) values ($1, now() + interval '1 day', 'Chat and requests')", [luna.id]);
  await ctx.db.query('insert into room_moderators (creator_id, user_id) values ($1, $2)', [luna.id, sol.id]);

  console.log('\nDemo created. Password for all accounts:', DEMO_PASSWORD);
  for (const a of DEMO_ACCOUNTS) console.log(`  ${a.email.padEnd(20)} ${a.role}`);
}
