import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, jwtPayload, makeApp, SETUP, verifyRecord } from './helpers.ts';
import { balance, unbalancedTransactions } from '../src/ledger/ledger.ts';
import { billPrivates } from '../src/live/privates.ts';
import { completePurchase } from '../src/ledger/purchases.ts';
import { escape, html } from '../src/web/html.ts';
import { cleanText } from '../src/routes/ws.ts';

async function installed() {
  const { app, ctx } = await makeApp();
  const admin = new Browser(app);
  await admin.form('/setup', SETUP);
  return { app, ctx, admin };
}

async function register(app: any, email: string, name: string) {
  const b = new Browser(app);
  await b.form('/register', { email, displayName: name, password: 'password123', adult: '1' });
  assert.ok(b.cookies.has('ftw_session'), `registration of ${name}`);
  return b;
}

/** Completes a simulated verification following redirects like a browser. */
async function verify(b: Browser, purpose: 'creator_kyc' | 'viewer_age', approve = true) {
  const start = await b.form('/verify/start', { purpose });
  const url = String(start.headers.location).split('?')[0];
  assert.match(url, /^\/sandbox\/verify\/\d+$/);
  const page = await b.get(url);
  assert.match(page.body, /Simulate approval/);
  await b.form(url, { result: approve ? 'approve' : 'reject' });
}

async function userId(ctx: any, email: string): Promise<number> {
  return (await ctx.db.one('select id from users where email = $1', [email])).id;
}

async function makeCreator(app: any, ctx: any, admin: Browser, email: string, name: string) {
  const c = await register(app, email, name);
  const start = await c.form('/become-creator', {});
  const url = String(start.headers.location);
  await c.form(url, { result: 'approve' });
  const id = await userId(ctx, email);
  assert.equal((await ctx.db.one('select creator_status from users where id = $1', [id])).creator_status, 'pending_approval');
  await admin.form(`/admin/creators/${id}`, { to: 'approved' });
  await verifyRecord(ctx, id);
  return { c, id };
}

test('the viewer must verify their age to enter', async () => {
  const { app, ctx, admin } = await installed();
  await makeCreator(app, ctx, admin, 'luna@example.com', 'Luna');
  const v = await register(app, 'fan@example.com', 'Fan');
  const room = await v.get('/c/luna');
  assert.equal(room.statusCode, 303);
  assert.match(String(room.headers.location), /^\/age-check/);
  const gate = await v.get(String(room.headers.location));
  assert.match(gate.body, /Verify with/);

  // A rejection grants no access.
  await verify(v, 'viewer_age', false);
  assert.equal((await v.get('/c/luna')).statusCode, 303);
  await verify(v, 'viewer_age', true);
  const ok = await v.get('/c/luna');
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /Request private show/);
});

test('with no active verification provider the region is closed', async () => {
  const { app, ctx } = await installed();
  for (const id of ['yoti', 'unico', 'eu_age_app']) await ctx.providers.setEnabled(id, false);
  const v = await register(app, 'fan@example.com', 'Fan');
  const gate = await v.get('/age-check');
  assert.match(gate.body, /not yet available in your region/);
});

test('lowering the age check requires confirmation and is audited', async () => {
  const { ctx, admin } = await installed();
  const form = {
    creatorKyc: 'yoti, veriff',
    US_age: 'verify', US_viewer: 'yoti', US_pay: 'ccbill',
    EU_age: 'verify', EU_viewer: 'eu_age_app, yoti', EU_pay: 'ccbill',
    LATAM_age: 'self_declare', LATAM_viewer: 'yoti', LATAM_pay: 'vendo, ccbill',
    OTHER_age: 'verify', OTHER_viewer: 'yoti', OTHER_pay: 'ccbill',
    overrides: 'BR age=verify age_providers=unico,yoti payment=vendo,ccbill',
  };
  await admin.form('/admin/regions', form);
  assert.equal((await ctx.settings.get()).regions.regions.LATAM.ageCheck, 'verify', 'does not change without confirmation');
  await admin.form('/admin/regions', { ...form, ack: '1' });
  const r = (await ctx.settings.get()).regions;
  assert.equal(r.regions.LATAM.ageCheck, 'self_declare');
  assert.equal(r.countryOverrides.BR.ageCheck, 'verify');
  assert.ok(await ctx.db.one("select 1 from audit_log where action = 'regions.update_lowered'"));
});

test('nobody broadcasts without identity verification and approval', async () => {
  const { app, ctx, admin } = await installed();
  const c = await register(app, 'sol@example.com', 'Sol');
  await c.form('/become-creator', {}); // starts but does not complete the verification
  const id = await userId(ctx, 'sol@example.com');
  const res = await c.json('/api/studio/live', { on: true });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /verification/);
  // Administration cannot approve without verification.
  await admin.form(`/admin/creators/${id}`, { to: 'approved' });
  assert.equal((await ctx.db.one('select creator_status from users where id = $1', [id])).creator_status, 'pending_kyc');
});

test('simulated purchase, tip, menu, levels and revenue split add up', async () => {
  const { app, ctx, admin } = await installed();
  const { c: creator, id: creatorId } = await makeCreator(app, ctx, admin, 'luna@example.com', 'Luna');
  const v = await register(app, 'fan@example.com', 'Fan');
  await verify(v, 'viewer_age');
  const fanId = await userId(ctx, 'fan@example.com');

  // Purchase of 500 tokens on the simulated gateway.
  const buy = await v.form('/wallet/buy', { packageId: 'p500' });
  const payUrl = String(buy.headers.location);
  assert.match(payUrl, /^\/sandbox\/pay\/\d+$/);
  await v.form(payUrl, { result: 'paid' });
  assert.equal(await balance(ctx.db, 'wallet', fanId), 500);
  // Repeating the confirmation does not credit twice.
  await completePurchase(ctx, Number(payUrl.split('/').pop()), true);
  assert.equal(await balance(ctx.db, 'wallet', fanId), 500);

  // Video token: the creator publishes, the viewer only watches.
  assert.equal((await creator.json('/api/studio/live', { on: true })).statusCode, 200);
  const own = await creator.get(`/api/live/token?creator=${creatorId}`);
  assert.equal(jwtPayload(own.json().token).video.canPublish, true);
  const view = await v.get(`/api/live/token?creator=${creatorId}`);
  const grant = jwtPayload(view.json().token).video;
  assert.equal(grant.canPublish, false);
  assert.equal(grant.canPublishData, false);

  // Tip with goal.
  await ctx.db.query("update creator_profiles set goal_label = 'Goal', goal_tokens = 300 where user_id = $1", [creatorId]);
  const tip = await v.json('/api/tip', { creatorId, amount: 120, message: 'hello' });
  assert.equal(tip.statusCode, 200);
  assert.equal(tip.json().balance, 380);
  assert.equal(await balance(ctx.db, 'earnings', creatorId), 60, '50% for the creator');
  assert.equal((await ctx.db.one('select goal_progress from creator_profiles where user_id = $1', [creatorId])).goal_progress, 120);

  // Menu.
  const item = await ctx.db.one<{ id: number }>("insert into tip_menu_items (creator_id, label, price) values ($1, 'Greeting', 30) returning id", [creatorId]);
  assert.equal((await v.json(`/api/menu/${item!.id}`)).json().balance, 350);

  // With insufficient balance nothing is deducted.
  const tooMuch = await v.json('/api/tip', { creatorId, amount: 10_000 });
  assert.equal(tooMuch.statusCode, 400);
  assert.equal(await balance(ctx.db, 'wallet', fanId), 350);

  // Level by amount spent (150): Bronze from 100.
  const wallet = await v.get('/wallet');
  assert.match(wallet.body, /<div class="label">Level<\/div><div class="value">Bronze<\/div>/);
  assert.equal(await unbalancedTransactions(ctx.db), 0);
});

test('private: accept, per-minute billing and cut-off on balance', async () => {
  const { app, ctx, admin } = await installed();
  const { c: creator, id: creatorId } = await makeCreator(app, ctx, admin, 'luna@example.com', 'Luna');
  await ctx.db.query('update creator_profiles set private_price_per_min = 40 where user_id = $1', [creatorId]);
  const v = await register(app, 'fan@example.com', 'Fan');
  await verify(v, 'viewer_age');
  const fanId = await userId(ctx, 'fan@example.com');
  await admin.form(`/admin/users/${fanId}/tokens`, { tokens: '100' });
  assert.equal(await balance(ctx.db, 'wallet', fanId), 100);

  // Cannot be requested if not live.
  assert.equal((await v.json('/api/private/request', { creatorId })).statusCode, 400);
  await creator.json('/api/studio/live', { on: true });
  const req = await v.json('/api/private/request', { creatorId });
  assert.equal(req.statusCode, 200);
  const showId = req.json().id;
  // Only the creator can accept.
  assert.equal((await v.json(`/api/private/${showId}/accept`)).statusCode, 400);
  assert.equal((await creator.json(`/api/private/${showId}/accept`)).json().status, 'active');
  assert.equal(await balance(ctx.db, 'wallet', fanId), 60, 'first minute charged on start');

  // Private token: the creator publishes in the private room, another user cannot enter.
  const tok = await v.get(`/api/live/token?show=${showId}`);
  assert.equal(jwtPayload(tok.json().token).video.room, `private-${showId}`);
  const intruder = await register(app, 'other@example.com', 'Other');
  assert.equal((await intruder.get(`/api/live/token?show=${showId}`)).statusCode, 400);

  // The public room shows as "in private".
  const state = await v.get(`/api/rooms/${creatorId}/state`);
  assert.equal(state.json().inPrivate, true);

  const started = new Date((await ctx.db.one('select started_at from private_shows where id = $1', [showId])).started_at).getTime();
  await billPrivates(ctx, started + 61_000); // minute 2
  assert.equal(await balance(ctx.db, 'wallet', fanId), 20);
  await billPrivates(ctx, started + 121_000); // minute 3: no balance
  const show = await ctx.db.one('select status, minutes_billed, tokens_billed, end_reason from private_shows where id = $1', [showId]);
  assert.equal(show.status, 'ended');
  assert.equal(show.minutes_billed, 2);
  assert.equal(show.tokens_billed, 80);
  assert.equal(show.end_reason, 'Balance exhausted');
  assert.equal(await balance(ctx.db, 'wallet', fanId), 20);
  // Billing the same minute again does not duplicate.
  await billPrivates(ctx, started + 61_000);
  assert.equal(await balance(ctx.db, 'earnings', creatorId), 40);
  assert.equal(await unbalancedTransactions(ctx.db), 0);
});

test('creator payout: hold, reject and refund', async () => {
  const { app, ctx, admin } = await installed();
  const { c: creator, id: creatorId } = await makeCreator(app, ctx, admin, 'luna@example.com', 'Luna');
  const v = await register(app, 'fan@example.com', 'Fan');
  await verify(v, 'viewer_age');
  const fanId = await userId(ctx, 'fan@example.com');
  await admin.form(`/admin/users/${fanId}/tokens`, { tokens: '1000' });
  await v.json('/api/tip', { creatorId, amount: 800 });
  assert.equal(await balance(ctx.db, 'earnings', creatorId), 400);

  await creator.form('/studio/payouts', { tokens: '100' }); // below the minimum (200)
  assert.equal(await balance(ctx.db, 'earnings', creatorId), 400);
  await creator.form('/studio/payouts', { tokens: '300' });
  assert.equal(await balance(ctx.db, 'earnings', creatorId), 100);
  const p = await ctx.db.one('select id, amount_cents from payouts where creator_id = $1', [creatorId]);
  assert.equal(p.amount_cents, 3000, '300 tokens × 10 cents');
  await admin.form(`/admin/payouts/${p.id}`, { to: 'rejected' });
  assert.equal(await balance(ctx.db, 'earnings', creatorId), 400);
  await creator.form('/studio/payouts', { tokens: '500' }); // more than they have
  assert.equal(await balance(ctx.db, 'earnings', creatorId), 400);
  assert.equal(await unbalancedTransactions(ctx.db), 0);
});

test('banning from the room prevents entering and tipping', async () => {
  const { app, ctx, admin } = await installed();
  const { c: creator, id: creatorId } = await makeCreator(app, ctx, admin, 'luna@example.com', 'Luna');
  const v = await register(app, 'fan@example.com', 'Fan');
  await verify(v, 'viewer_age');
  const fanId = await userId(ctx, 'fan@example.com');
  await admin.form(`/admin/users/${fanId}/tokens`, { tokens: '50' });
  assert.equal((await creator.json(`/api/rooms/${creatorId}/ban`, { userId: fanId })).statusCode, 200);
  assert.match((await v.get('/c/luna')).body, /You can't enter this room/);
  assert.equal((await v.json('/api/tip', { creatorId, amount: 10 })).statusCode, 400);
  // Another viewer cannot ban.
  assert.equal((await v.json(`/api/rooms/${creatorId}/ban`, { userId: fanId })).statusCode, 403);
});

test('HTML escapes everything by default', () => {
  const evil = '<script>alert(1)</script>';
  assert.equal(html`<p>${evil}</p>`.value, `<p>${escape(evil)}</p>`);
  assert.ok(!html`<a title="${'" onmouseover="x'}">`.value.includes('" onmouseover'));
  assert.equal(cleanText('hello\u0000\nworld'), 'hello  world');
});

test('the main pages load without errors', async () => {
  const { app, ctx, admin } = await installed();
  await makeCreator(app, ctx, admin, 'luna@example.com', 'Luna');
  for (const url of [
    '/', '/wallet', '/following', '/studio', '/studio/settings', '/studio/goal-menu', '/studio/earnings', '/studio/privates', '/studio/bans',
    '/admin', '/admin/users', '/admin/creators', '/admin/live', '/admin/verifications', '/admin/providers', '/admin/regions',
    '/admin/economy', '/admin/transactions', '/admin/payouts', '/admin/privates', '/admin/reports', '/admin/audit', '/admin/settings', '/c/luna',
    '/admin/records', '/admin/compliance', '/admin/legal', '/admin/legal/terms', '/admin/webhooks', '/studio/records', '/performer', '/2257',
    '/legal/terms', '/legal/privacy', '/legal/cookies', '/legal/rules', '/legal/takedown',
    '/admin/moderation', '/admin/media', '/studio/obs',
    '/studio/albums', '/studio/chat', '/studio/schedule', '/agenda', '/messages', '/notifications', '/account', '/admin/albums',
  ]) {
    const res = await admin.get(url);
    assert.ok([200, 303].includes(res.statusCode), `${url} → ${res.statusCode}`);
  }
  // The admin has not verified their identity yet: going live sends them back to the studio.
  assert.equal((await admin.get('/studio/live')).statusCode, 303);
});
