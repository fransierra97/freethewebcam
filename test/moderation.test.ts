import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Browser, HOST, makeApp, SETUP, verifyRecord } from './helpers.ts';
import { cleanupFrames, scanFrame, storeFrame } from '../src/moderation/frames.ts';
import { hiveVerdict, webhookSignature } from '../src/providers/adapters/moderation.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

async function liveCreator(fakeFetch?: typeof fetch) {
  const { app, ctx } = await makeApp();
  const admin = new Browser(app);
  await admin.form('/setup', SETUP);
  if (fakeFetch) ctx.providers.fetchFn = fakeFetch;
  const c = new Browser(app);
  await c.form('/register', { email: 'luna@example.com', displayName: 'Luna', password: 'password123', adult: '1' });
  const id = (await ctx.db.one("select id from users where email = 'luna@example.com'")).id as number;
  const start = await c.form('/become-creator', {});
  await c.form(String(start.headers.location), { result: 'approve' });
  await admin.form(`/admin/creators/${id}`, { to: 'approved' });
  await verifyRecord(ctx, id);
  assert.equal((await c.json('/api/studio/live', { on: true })).statusCode, 200);
  return { app, ctx, admin, c, id };
}

test('Hive: reading the response', () => {
  const match = { status: [{ response: { output: [{ file: { reasons: ['matched'] }, hashes: [{ hashType: 'saferhashv0', matchTypes: ['CSAM'], sources: [{ hashSet: 'ncmec' }] }] }] } }] };
  assert.equal(hiveVerdict(match, 0.9).verdict, 'match');
  const testSet = { status: [{ response: { output: [{ file: { reasons: ['matched'] }, hashes: [{ sources: [{ hashSet: 'test' }] }] }] } }] };
  assert.equal(hiveVerdict(testSet, 0.9).verdict, 'clear', 'the Thorn test set is ignored');
  const suspect = { status: [{ response: { output: [{ file: { reasons: [], classifierPrediction: { csam_classifier: { csam: 0.95, pornography: 0.04, other: 0.01 } } }, hashes: [] }] } }] };
  assert.equal(hiveVerdict(suspect, 0.9).verdict, 'suspect');
  assert.equal(hiveVerdict(suspect, 0.99).verdict, 'clear');
});

test('uploading frames: JPEG only and live only', async () => {
  const { app, ctx, c, id } = await liveCreator();
  const send = (body: Buffer) =>
    app.inject({ method: 'POST', url: '/api/moderation/frame', payload: body, headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'image/jpeg', cookie: `ftw_session=${c.cookies.get('ftw_session')}` } });
  assert.equal((await send(Buffer.from('<html>'))).statusCode, 400);
  const ok = await send(JPEG);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().stored, true);
  assert.equal((await send(JPEG)).json().stored, false, 'rate limited');
  const f = await ctx.db.one('select file, session_id from moderation_frames where creator_id = $1', [id]);
  assert.ok(f.session_id, 'stays linked to the broadcast');
  await c.json('/api/studio/live', { on: false });
  await ctx.db.query('delete from moderation_frames');
  assert.equal((await send(JPEG)).statusCode, 400, 'not accepted when not live');
});

test('hash match: cuts, suspends, retains and opens a case', async () => {
  const fakeFetch = (async (url: any, init: any) => {
    assert.equal(String(url), 'https://api.thehive.ai/api/v2/task/sync');
    assert.equal(init.headers.authorization, 'Token hive-key');
    return Response.json({ status: [{ response: { output: [{ file: { reasons: ['matched'] }, hashes: [{ sources: [{ hashSet: 'ncmec' }] }] }] } }] });
  }) as typeof fetch;
  const { ctx, admin, id } = await liveCreator(fakeFetch);
  await ctx.providers.saveCredentials('hive_csam', { apiKey: 'hive-key' });
  await ctx.providers.setEnabled('hive_csam', true);
  await ctx.providers.setMode('hive_csam', 'live');
  const frameId = await storeFrame(ctx, id, JPEG);
  const r = await scanFrame(ctx, frameId);
  assert.equal(r.verdict, 'match');
  assert.equal((await ctx.db.one('select is_live from creator_profiles where user_id = $1', [id])).is_live, false);
  assert.equal((await ctx.db.one('select creator_status from users where id = $1', [id])).creator_status, 'suspended');
  const inc = await ctx.db.one('select * from moderation_incidents where creator_id = $1', [id]);
  assert.equal(inc.kind, 'hash_match');
  assert.ok((await ctx.db.one('select retain_until from moderation_frames where id = $1', [frameId])).retain_until);
  // Administration sees it and closes it as reported.
  const page = await admin.get(`/admin/moderation/incidents/${inc.id}`);
  assert.match(page.body, /report\.cybertip\.org/);
  await admin.form(`/admin/moderation/incidents/${inc.id}`, { action: 'reported', externalId: 'CT-123', resolution: 'Reported' });
  assert.equal((await ctx.db.one('select status from moderation_incidents where id = $1', [inc.id])).status, 'reported');
});

test('classifier suspicion: cuts the stream but does not suspend', async () => {
  const fakeFetch = (async () =>
    Response.json({ status: [{ response: { output: [{ file: { reasons: [], classifierPrediction: { csam_classifier: { csam: 0.97 } } }, hashes: [] }] } }] })) as typeof fetch;
  const { ctx, id } = await liveCreator(fakeFetch);
  await ctx.providers.saveCredentials('hive_csam', { apiKey: 'k' });
  await ctx.providers.setEnabled('hive_csam', true);
  await ctx.providers.setMode('hive_csam', 'live');
  await scanFrame(ctx, await storeFrame(ctx, id, JPEG));
  assert.equal((await ctx.db.one('select is_live from creator_profiles where user_id = $1', [id])).is_live, false);
  assert.equal((await ctx.db.one('select creator_status from users where id = $1', [id])).creator_status, 'approved');
});

test('custom connector: signs the request', async () => {
  let signature = '';
  const fakeFetch = (async (_url: any, init: any) => {
    signature = init.headers['x-ftw-signature'];
    return Response.json({ verdict: 'clear' });
  }) as typeof fetch;
  const { ctx, id } = await liveCreator(fakeFetch);
  await ctx.providers.saveCredentials('moderation_webhook', { url: 'https://scanner.example/scan', secret: 's3' });
  await ctx.providers.setEnabled('moderation_webhook', true);
  await ctx.providers.setMode('moderation_webhook', 'live');
  const r = await scanFrame(ctx, await storeFrame(ctx, id, JPEG));
  assert.equal(r.verdict, 'clear');
  assert.equal(signature, webhookSignature(JPEG, 's3'));
});

test('cleanup: deletes old frames except retained ones', async () => {
  const { ctx, id } = await liveCreator();
  const keep = await storeFrame(ctx, id, JPEG);
  const drop = await storeFrame(ctx, id, JPEG);
  await ctx.db.query("update moderation_frames set created_at = now() - interval '30 days'");
  await ctx.db.query("update moderation_frames set retain_until = now() + interval '1 year' where id = $1", [keep]);
  const files = await ctx.db.query('select id, file from moderation_frames order by id');
  assert.equal(await cleanupFrames(ctx), 1);
  const after = await ctx.db.query<{ id: number; file: string | null }>('select id, file from moderation_frames order by id');
  assert.ok(after.find((f) => f.id === keep)!.file);
  assert.equal(after.find((f) => f.id === drop)!.file, null);
  const dropped = files.find((f: any) => f.id === drop).file;
  assert.equal(existsSync(join(ctx.cfg.dataDir, 'frames', dropped)), false, 'the file is deleted from disk');
});
