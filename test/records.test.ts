import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser, HOST, makeApp, SETUP, verifyRecord } from './helpers.ts';

function multipart(fields: Record<string, string>, file?: { name: string; filename: string; type: string; data: Buffer }) {
  const boundary = '----ftwtest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

async function setup() {
  const { app, ctx } = await makeApp();
  const admin = new Browser(app);
  await admin.form('/setup', SETUP);
  const reg = async (email: string, name: string) => {
    const b = new Browser(app);
    await b.form('/register', { email, displayName: name, password: 'password123', adult: '1' });
    return { b, id: (await ctx.db.one('select id from users where email = $1', [email])).id as number };
  };
  // Approved creator (record verification done per test).
  const luna = await reg('luna@example.com', 'Luna');
  const start = await luna.b.form('/become-creator', {});
  await luna.b.form(String(start.headers.location), { result: 'approve' });
  await admin.form(`/admin/creators/${luna.id}`, { to: 'approved' });
  return { app, ctx, admin, luna, reg };
}

test('cannot go live without a verified record', async () => {
  const { ctx, luna } = await setup();
  const res = await luna.b.json('/api/studio/live', { on: true });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /legal record/);
  await verifyRecord(ctx, luna.id);
  assert.equal((await luna.b.json('/api/studio/live', { on: true })).statusCode, 200);
});

test('co-performer: invitation, verification, record with document, review and session', async () => {
  const { app, ctx, admin, luna, reg } = await setup();
  await verifyRecord(ctx, luna.id);

  // Invitation.
  const inv = await luna.b.form('/studio/records/invite', { stageName: 'Star' });
  const link = inv.body.match(/http:\/\/test\.local(\/performer\/invite\/[\w-]+)/)![1];
  const co = await reg('star@example.com', 'Star');
  const claim = await co.b.get(link);
  const recordUrl = String(claim.headers.location);
  assert.match(recordUrl, /^\/performer\/record\/\d+$/);
  const recordId = Number(recordUrl.split('/').pop());
  assert.equal((await co.b.get(link)).statusCode, 400, 'the link is single-use');

  // Cannot appear on camera yet.
  const early = await luna.b.json('/api/studio/live', { on: true, performers: [recordId] });
  assert.equal(early.statusCode, 400);
  assert.match(early.json().error, /Star/);

  // Verifies their identity (simulated) and submits their record with the document copy.
  const kyc = await co.b.form('/verify/start', { purpose: 'creator_kyc' });
  await co.b.form(String(kyc.headers.location).split('?')[0], { result: 'approve' });
  const doc = Buffer.from('%PDF-1.4 test document');
  const form = multipart(
    { legalName: 'Ana Example Perez', dateOfBirth: '1992-03-04', aliases: 'Anita, Star', idType: 'Passport', idNumber: 'P9876543', idIssuer: 'ES', idExpiry: '2033-03-03', consent: '1' },
    { name: 'idCopy', filename: 'passport.pdf', type: 'application/pdf', data: doc },
  );
  const sent = await app.inject({
    method: 'POST',
    url: recordUrl,
    payload: form.body,
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': form.type, cookie: `ftw_session=${co.b.cookies.get('ftw_session')}` },
  });
  assert.equal(sent.statusCode, 303);
  const row = await ctx.db.one('select status, pii_enc, id_copy_file from performer_records where id = $1', [recordId]);
  assert.equal(row.status, 'submitted');
  assert.ok(!row.pii_enc.includes('Ana Example'), 'personal data is stored encrypted');
  const files = readdirSync(join(ctx.cfg.dataDir, 'records'));
  const stored = readFileSync(join(ctx.cfg.dataDir, 'records', row.id_copy_file.split('|')[0]));
  assert.ok(files.length >= 1 && !stored.includes(doc), 'the document copy is stored encrypted');

  // Another person cannot see or touch that record.
  assert.equal((await luna.b.get(recordUrl)).statusCode, 404);

  // Review: administration sees the decrypted document and verifies it.
  const copy = await admin.get(`/admin/records/${recordId}/id-copy`);
  assert.equal(copy.statusCode, 200);
  assert.equal(copy.rawPayload.toString(), doc.toString());
  await admin.form(`/admin/records/${recordId}/review`, { decision: 'approve', note: 'ok' });
  assert.equal((await ctx.db.one('select status from performer_records where id = $1', [recordId])).status, 'verified');

  // Now it works: the session records both people.
  const live = await luna.b.json('/api/studio/live', { on: true, performers: [recordId] });
  assert.equal(live.statusCode, 200);
  const performers = await ctx.db.query('select record_id from broadcast_performers where session_id = $1', [live.json().sessionId]);
  assert.equal(performers.length, 2);
  await luna.b.json('/api/studio/live', { on: false });
  assert.ok((await ctx.db.one('select ended_at from broadcast_sessions where id = $1', [live.json().sessionId])).ended_at);

  // Index for the custodian: one row per legal name and per alias, with the broadcast.
  const csv = await admin.get('/admin/records/export.csv');
  assert.equal(csv.statusCode, 200);
  const lines = csv.body.trim().split('\n');
  assert.ok(lines.some((l) => l.startsWith('Ana Example Perez,')));
  assert.ok(lines.some((l) => l.startsWith('Anita,Ana Example Perez')));
  assert.ok(lines.some((l) => l.includes(`#${live.json().sessionId}`)));
  assert.ok(await ctx.db.one("select 1 from audit_log where action = 'record.export'"));
});

test('minors and expired documents are rejected', async () => {
  const { ctx, luna } = await setup();
  const { ensurePrimaryRecord, submitRecord } = await import('../src/compliance/records.ts');
  const user = (await ctx.db.one('select * from users where id = $1', [luna.id]))!;
  const r = await ensurePrimaryRecord(ctx.db, user, 'Luna');
  const base = { legalName: 'Legal Name', aliases: [], idType: 'Passport', idNumber: 'X123', idIssuer: 'ES', idExpiry: '2034-01-01' };
  const copy = { data: Buffer.from('x'), mimetype: 'image/png' };
  const teen = new Date();
  teen.setUTCFullYear(teen.getUTCFullYear() - 17);
  await assert.rejects(
    () => submitRecord(ctx, r, user, { pii: { ...base, dateOfBirth: teen.toISOString().slice(0, 10) }, idCopy: copy, consent: true }),
    /18 years/,
  );
  await assert.rejects(
    () => submitRecord(ctx, r, user, { pii: { ...base, dateOfBirth: '1990-01-01', idExpiry: '2020-01-01' }, idCopy: copy, consent: true }),
    /expired/,
  );
  await assert.rejects(
    () => submitRecord(ctx, r, user, { pii: { ...base, dateOfBirth: '1990-01-01' }, idCopy: { data: Buffer.from('x'), mimetype: 'text/html' }, consent: true }),
    /JPG, PNG/,
  );
});

test('public 2257 statement and custodian details', async () => {
  const { admin, app } = await setup();
  const before = await new Browser(app).get('/2257');
  assert.match(before.body, /has not yet set up/);
  const bad = await admin.form('/admin/compliance', {
    require2257: '1', operatorName: 'Example Ltd', operatorAddress: '1 Example Street', contactEmail: 'legal@example.com',
    custodianName: 'Custodian Person', custodianTitle: 'Custodian of Records', custodianAddress: 'PO Box 123', frameIntervalSeconds: '60', frameRetentionDays: '7',
  });
  assert.equal(bad.statusCode, 303);
  await admin.form('/admin/compliance', {
    require2257: '1', operatorName: 'Example Ltd', operatorAddress: '1 Example Street', contactEmail: 'legal@example.com',
    custodianName: 'Custodian Person', custodianTitle: 'Custodian of Records', custodianAddress: '1 Main Street, London', frameIntervalSeconds: '60', frameRetentionDays: '7',
  });
  const page = await new Browser(app).get('/2257');
  assert.match(page.body, /1 Main Street/);
  assert.doesNotMatch(page.body, /PO Box/);
});
