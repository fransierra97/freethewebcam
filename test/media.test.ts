import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessToken } from 'livekit-server-sdk';
import { Browser, HOST, makeApp, SETUP, verifyRecord } from './helpers.ts';
import type { MediaServices } from '../src/live/media.ts';

function fakeMedia() {
  const calls: string[] = [];
  let n = 0;
  const media: MediaServices = {
    async createIngress(o) {
      calls.push(`ingress:${o.kind}:${o.roomName}`);
      return { ingressId: 'IN_1', url: 'rtmp://example/live', streamKey: 'secret-key' };
    },
    async deleteIngress(id) {
      calls.push(`delete:${id}`);
    },
    async startRecording(room, rel) {
      calls.push(`record:${room}:${rel}`);
      return `EG_${++n}`;
    },
    async startParticipantRecording(room, identity, rel) {
      calls.push(`record:${room}:${identity}:${rel}`);
      return `EG_${++n}`;
    },
    async startHls(room, dir) {
      calls.push(`hls:${room}:${dir}`);
      return `EG_${++n}`;
    },
    async stopEgress(id) {
      calls.push(`stop:${id}`);
    },
  };
  return { media, calls };
}

async function setup(env: Record<string, string>) {
  const { app, ctx } = await makeApp(env);
  const { media, calls } = fakeMedia();
  ctx.media = media;
  const admin = new Browser(app);
  await admin.form('/setup', SETUP);
  const reg = async (email: string, name: string) => {
    const b = new Browser(app);
    await b.form('/register', { email, displayName: name, password: 'password123', adult: '1' });
    return { b, id: (await ctx.db.one('select id from users where email = $1', [email])).id as number };
  };
  const luna = await reg('luna@example.com', 'Luna');
  const start = await luna.b.form('/become-creator', {});
  await luna.b.form(String(start.headers.location), { result: 'approve' });
  await admin.form(`/admin/creators/${luna.id}`, { to: 'approved' });
  await verifyRecord(ctx, luna.id);
  const fan = await reg('fan@example.com', 'Fan');
  await ctx.db.query('update users set age_verified_at = now() where id = $1', [fan.id]);
  await admin.form(`/admin/users/${fan.id}/tokens`, { tokens: '500' });
  return { app, ctx, admin, luna, fan, calls };
}

test('recording of every broadcast and every private', async () => {
  const { ctx, luna, fan, calls } = await setup({ EGRESS_ENABLED: '1' });
  const live = await luna.b.json('/api/studio/live', { on: true });
  const sessionId = live.json().sessionId;
  assert.ok(calls.includes(`record:public-${luna.id}:recordings/${luna.id}/session-${sessionId}.mp4`));
  const s = await ctx.db.one('select egress_id, recording_path from broadcast_sessions where id = $1', [sessionId]);
  assert.equal(s.egress_id, 'EG_1');

  const req = await fan.b.json('/api/private/request', { creatorId: luna.id });
  await luna.b.json(`/api/private/${req.json().id}/accept`);
  assert.ok(calls.some((c) => c.startsWith(`record:private-${req.json().id}:u${luna.id}:`)), 'the private is recorded, only with the creator tracks');
  await fan.b.json(`/api/private/${req.json().id}/end`);
  assert.ok(calls.includes('stop:EG_2'));

  await luna.b.json('/api/studio/live', { on: false });
  assert.ok(calls.includes('stop:EG_1'));
});

test('without the recording service installed no recording is attempted', async () => {
  const { luna, calls } = await setup({});
  await luna.b.json('/api/studio/live', { on: true });
  assert.equal(calls.length, 0);
});

test('OBS: encrypted key, OBS-mode stream and no privates', async () => {
  const { ctx, luna, fan, calls } = await setup({ INGRESS_ENABLED: '1' });
  assert.equal((await luna.b.json('/api/studio/live', { on: true, mode: 'obs' })).statusCode, 400, 'no key, no OBS mode');
  await luna.b.form('/studio/obs/create', { kind: 'rtmp' });
  assert.ok(calls.includes(`ingress:rtmp:public-${luna.id}`));
  const row = await ctx.db.one('select ingress_key_enc from creator_profiles where user_id = $1', [luna.id]);
  assert.ok(!row.ingress_key_enc.includes('secret-key'), 'the key is stored encrypted');
  assert.match((await luna.b.get('/studio/obs')).body, /secret-key/);
  assert.equal((await luna.b.json('/api/studio/live', { on: true, mode: 'obs' })).statusCode, 200);
  const priv = await fan.b.json('/api/private/request', { creatorId: luna.id });
  assert.equal(priv.statusCode, 400);
  assert.match(priv.json().error, /OBS/);
});

test('HLS: only for verified viewers and cannot escape the folder', async () => {
  const { app, ctx, admin, luna, fan, calls } = await setup({ EGRESS_ENABLED: '1' });
  await admin.form('/admin/media', { record: '1', hls: '1' });
  const live = await luna.b.json('/api/studio/live', { on: true });
  const sessionId = live.json().sessionId;
  assert.ok(calls.includes(`hls:public-${luna.id}:hls/${luna.id}/${sessionId}`));
  const dir = join(ctx.cfg.mediaDir, 'hls', String(luna.id), String(sessionId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'live.m3u8'), '#EXTM3U\n');
  const state = await fan.b.get(`/api/rooms/${luna.id}/state`);
  assert.equal(state.json().hlsUrl, `/hls/${luna.id}/${sessionId}/live.m3u8`);
  const ok = await fan.b.get(state.json().hlsUrl);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'application/vnd.apple.mpegurl');
  assert.equal((await fan.b.get(`/hls/${luna.id}/${sessionId}/..%2F..%2Fsecret.m3u8`)).statusCode, 404);
  const stranger = new Browser(app);
  await stranger.form('/register', { email: 'x@example.com', displayName: 'Extra', password: 'password123', adult: '1' });
  assert.equal((await stranger.get(state.json().hlsUrl)).statusCode, 403, 'cannot be viewed without age verification');
});

test('LiveKit notices: signature required', async () => {
  const { app, ctx, luna } = await setup({});
  const body = JSON.stringify({ event: 'egress_ended', id: 'EV1', createdAt: '1', egressInfo: { egressId: 'EG_9', roomName: `public-${luna.id}` } });
  const at = new AccessToken(ctx.cfg.livekitApiKey, ctx.cfg.livekitApiSecret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  const auth = await at.toJwt();
  const post = (authorization: string) =>
    app.inject({ method: 'POST', url: '/webhooks/livekit', payload: body, headers: { host: HOST, 'content-type': 'application/webhook+json', authorization } });
  assert.equal((await post('fake')).statusCode, 401);
  assert.equal((await post(auth)).statusCode, 200);
  assert.ok(await ctx.db.one("select 1 from audit_log where action = 'egress.ended'"));
});
