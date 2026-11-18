import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser, HOST, makeApp, SETUP, verifyRecord } from './helpers.ts';
import { balance, unbalancedTransactions } from '../src/ledger/ledger.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
// Minimal MP4 header ("ftyp") followed by data: enough to test ranged downloads.
const MP4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(70_000, 7)]);

function multipart(files: { name: string; filename: string; type: string; data: Buffer }[], fields: Record<string, string> = {}) {
  const boundary = '----ftw' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

async function setup(fakeFetch?: typeof fetch) {
  const { app, ctx } = await makeApp();
  if (fakeFetch) ctx.providers.fetchFn = fakeFetch;
  const admin = new Browser(app);
  await admin.form('/setup', SETUP);
  const reg = async (email: string, name: string) => {
    const b = new Browser(app);
    await b.form('/register', { email, displayName: name, password: 'password123', adult: '1' });
    const id = (await ctx.db.one('select id from users where email = $1', [email])).id as number;
    await ctx.db.query('update users set age_verified_at = now() where id = $1', [id]);
    return { b, id };
  };
  const luna = await reg('luna@example.com', 'Luna');
  const start = await luna.b.form('/become-creator', {});
  await luna.b.form(String(start.headers.location), { result: 'approve' });
  await admin.form(`/admin/creators/${luna.id}`, { to: 'approved' });
  await verifyRecord(ctx, luna.id);
  const fan = await reg('fan@example.com', 'Fan');
  await admin.form(`/admin/users/${fan.id}/tokens`, { tokens: '500' });
  const upload = (b: Browser, url: string, files: Parameters<typeof multipart>[0]) => {
    const m = multipart(files);
    return app.inject({ method: 'POST', url, payload: m.body, headers: { host: HOST, origin: `http://${HOST}`, 'content-type': m.type, cookie: `ftw_session=${b.cookies.get('ftw_session')}` } });
  };
  return { app, ctx, admin, luna, fan, upload };
}

test('full album: upload, review, unlock and watch in ranges', async () => {
  const { ctx, admin, luna, fan, upload } = await setup();
  const created = await luna.b.form('/studio/albums', { title: 'Summer', price: '120' });
  const albumUrl = String(created.headers.location);
  const albumId = Number(albumUrl.split('/').pop());

  // Cannot be submitted without content.
  await luna.b.form(`${albumUrl}/submit`, {});
  assert.equal((await ctx.db.one('select status from albums where id = $1', [albumId])).status, 'draft');

  // A file that is not what it claims to be is rejected.
  await upload(luna.b, `${albumUrl}/upload`, [{ name: 'files', filename: 'fake.png', type: 'image/png', data: Buffer.from('<html>no</html>') }]);
  assert.equal((await ctx.db.one('select count(*)::int as n from album_items where album_id = $1', [albumId])).n, 0);

  const up = await upload(luna.b, `${albumUrl}/upload`, [
    { name: 'files', filename: 'photo.png', type: 'image/png', data: PNG },
    { name: 'files', filename: 'clip.mp4', type: 'video/mp4', data: MP4 },
  ]);
  assert.equal(up.statusCode, 303);
  const items = await ctx.db.query('select id, kind, file, scan_status from album_items where album_id = $1 order by id', [albumId]);
  assert.deepEqual(items.map((i: any) => i.kind), ['image', 'video']);
  assert.equal(items[1].scan_status, 'manual', 'videos require human review');
  const stored = readFileSync(join(ctx.cfg.dataDir, 'content', items[1].file));
  assert.ok(!stored.includes(MP4.subarray(0, 24)), 'stored encrypted');

  await upload(luna.b, `${albumUrl}/cover`, [{ name: 'file', filename: 'cover.png', type: 'image/png', data: PNG }]);
  await luna.b.form(`${albumUrl}/submit`, {});
  assert.equal((await ctx.db.one('select status from albums where id = $1', [albumId])).status, 'pending_review');

  // Before publication, a fan cannot see it.
  assert.equal((await fan.b.get(`/albums/${albumId}`)).statusCode, 404);
  await admin.form(`/admin/albums/${albumId}/review`, { decision: 'approve', note: '' });
  assert.equal((await ctx.db.one('select status from albums where id = $1', [albumId])).status, 'published');

  // Published: it shows in the room with its cover, but the content is locked.
  assert.match((await fan.b.get('/c/luna')).body, /Summer/);
  assert.equal((await fan.b.get(`/content/cover/${albumId}`)).statusCode, 200);
  assert.equal((await fan.b.get(`/content/item/${items[0].id}`)).statusCode, 404);
  assert.match((await fan.b.get(`/albums/${albumId}`)).body, /Unlock for 120 tokens/);

  await fan.b.form(`/albums/${albumId}/unlock`, {});
  assert.equal(await balance(ctx.db, 'wallet', fan.id), 380);
  assert.equal(await balance(ctx.db, 'earnings', luna.id), 60);
  const full = await fan.b.get(`/content/item/${items[0].id}`);
  assert.equal(full.statusCode, 200);
  assert.ok(full.rawPayload.equals(PNG), 'the photo arrives decrypted');

  // Ranged video (Range) so it can be seeked.
  const ranged = await (fan.b as any).app.inject({
    method: 'GET',
    url: `/content/item/${items[1].id}`,
    headers: { host: HOST, cookie: `ftw_session=${fan.b.cookies.get('ftw_session')}`, range: 'bytes=1000-1999' },
  });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.headers['content-range'], `bytes 1000-1999/${MP4.length}`);
  assert.ok(ranged.rawPayload.equals(MP4.subarray(1000, 2000)));
  const tail = await (fan.b as any).app.inject({
    method: 'GET',
    url: `/content/item/${items[1].id}`,
    headers: { host: HOST, cookie: `ftw_session=${fan.b.cookies.get('ftw_session')}`, range: 'bytes=-17' },
  });
  assert.ok(tail.rawPayload.equals(MP4.subarray(MP4.length - 17)));

  // Unlocking twice does not charge again.
  await fan.b.form(`/albums/${albumId}/unlock`, {});
  assert.equal(await balance(ctx.db, 'wallet', fan.id), 380);

  // Editing it sends it back to review; whoever bought it keeps access.
  await luna.b.form(albumUrl, { title: 'Summer 2026', price: '150', description: '' });
  assert.equal((await ctx.db.one('select status from albums where id = $1', [albumId])).status, 'draft');
  assert.equal((await fan.b.get(`/content/item/${items[0].id}`)).statusCode, 200);
  assert.equal(await unbalancedTransactions(ctx.db), 0);
  void readdirSync;
});

test('a photo flagged by the detector blocks the album and opens a case', async () => {
  const fakeFetch = (async () =>
    Response.json({ status: [{ response: { output: [{ file: { reasons: ['matched'] }, hashes: [{ sources: [{ hashSet: 'ncmec' }] }] }] } }] })) as typeof fetch;
  const { ctx, luna, upload } = await setup(fakeFetch);
  await ctx.providers.saveCredentials('hive_csam', { apiKey: 'k' });
  await ctx.providers.setEnabled('hive_csam', true);
  await ctx.providers.setMode('hive_csam', 'live');
  const created = await luna.b.form('/studio/albums', { title: 'X', price: '10' });
  const albumUrl = String(created.headers.location);
  const albumId = Number(albumUrl.split('/').pop());
  await upload(luna.b, `${albumUrl}/upload`, [{ name: 'files', filename: 'a.png', type: 'image/png', data: PNG }]);
  assert.equal((await ctx.db.one('select status from albums where id = $1', [albumId])).status, 'rejected');
  assert.ok(await ctx.db.one('select 1 from moderation_incidents where album_item_id is not null'));
  assert.equal((await ctx.db.one('select creator_status from users where id = $1', [luna.id])).creator_status, 'suspended');
});

test('only verified performers in the album', async () => {
  const { ctx, luna } = await setup();
  const created = await luna.b.form('/studio/albums', { title: 'Duo', price: '10' });
  const albumId = Number(String(created.headers.location).split('/').pop());
  // An unverified co-performer record cannot be added.
  const r = await ctx.db.one<{ id: number }>("insert into performer_records (owner_id, kind, stage_name) values ($1, 'co_performer', 'Pending') returning id", [luna.id]);
  await luna.b.form(`/studio/albums/${albumId}/performers`, { performer: String(r!.id) });
  const rows = await ctx.db.query('select record_id from album_performers where album_id = $1', [albumId]);
  assert.ok(!rows.some((x: any) => x.record_id === r!.id));
  assert.equal(rows.length, 1, 'only the creator');
});
