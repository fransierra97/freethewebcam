import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, HOST, makeApp, SETUP } from './helpers.ts';

test('a new installation leads to the wizard and requires the code', async () => {
  const { app, ctx } = await makeApp();
  const b = new Browser(app);
  const home = await b.get('/');
  assert.equal(home.statusCode, 303);
  assert.equal(home.headers.location, '/setup');

  const noToken = await b.get('/setup');
  assert.match(noToken.body, /setup code/);

  const bad = await b.form('/setup', { ...SETUP, token: 'wrong' });
  assert.equal(bad.headers.location, '/setup');
  assert.equal((await ctx.settings.get()).site.setupComplete, false);

  const ok = await b.form('/setup', SETUP);
  assert.equal(ok.statusCode, 303);
  assert.equal(ok.headers.location, '/admin');
  const s = await ctx.settings.get();
  assert.equal(s.site.setupComplete, true);
  assert.equal(s.site.mode, 'group');

  // The providers for those markets are enabled in test mode.
  const providers = await ctx.providers.list();
  for (const id of ['ccbill', 'vendo', 'yoti', 'veriff', 'eu_age_app', 'unico']) {
    const p = providers.find((x) => x.manifest.id === id)!;
    assert.equal(p.enabled, true, id);
    assert.equal(p.state, 'test', id);
  }

  // Once installed, the wizard can no longer be used.
  const again = await b.get('/setup?token=setup-secret');
  assert.equal(again.headers.location, '/');
  const admin = await b.get('/admin');
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /test mode or not configured/);
  void HOST;
});

test('live mode is blocked if the integration does not exist', async () => {
  const { app, ctx } = await makeApp();
  await new Browser(app).form('/setup', SETUP);
  await assert.rejects(() => ctx.providers.setMode('unico', 'live'), /not implemented yet/);
  await assert.rejects(() => ctx.providers.setMode('ccbill', 'live'), /Missing credentials/);
  await ctx.providers.saveCredentials('ccbill', { clientAccnum: '123', salt: 'secret' });
  const creds = await ctx.providers.credentials('ccbill');
  assert.equal(creds.salt, 'secret');
  const raw = await ctx.db.one<{ credentials_enc: string }>("select credentials_enc from provider_configs where id = 'ccbill'");
  assert.ok(!raw!.credentials_enc.includes('secret'), 'credentials are stored encrypted');
  // An empty secret does not erase the stored one.
  await ctx.providers.saveCredentials('ccbill', { clientAccnum: '456', salt: '' });
  assert.equal((await ctx.providers.credentials('ccbill')).salt, 'secret');
});

test('rejects POST requests from another origin', async () => {
  const { app } = await makeApp();
  const b = new Browser(app);
  const res = await b.form('/setup', SETUP, { origin: 'https://evil.example' });
  assert.equal(res.statusCode, 403);
});

test('general-audience site: no age verification to view, no 18+ notices and no 2257', async () => {
  const { app, ctx } = await makeApp();
  const admin = new Browser(app);
  const missing = await admin.form('/setup', { ...SETUP, ageRestricted: '' });
  assert.match(String(missing.headers.location), /^\/setup/, 'the content type must be chosen');
  await admin.form('/setup', { ...SETUP, ageRestricted: '0' });
  const { site, compliance } = await ctx.settings.get();
  assert.equal(site.ageRestricted, false);
  assert.equal(compliance.require2257, false);
  const viewer = new Browser(app);
  const reg = await viewer.get('/register');
  assert.doesNotMatch(reg.body, /18 or older/);
  await viewer.form('/register', { email: 'v@example.com', displayName: 'Viewer', password: 'password123', adult: '1' });
  const home = await viewer.get('/');
  assert.equal(home.statusCode, 200, 'gets in without verifying age');
  assert.doesNotMatch(home.body, /Adults only/);
  assert.doesNotMatch(home.body, /2257/);
  // Re-enable it from Administration → Site.
  await admin.form('/admin/settings', { name: 'Test', mode: 'group', brandColor: '#d6336c', ageRestricted: '1' });
  assert.equal((await viewer.get('/')).statusCode, 303, 'now asks to verify age');
});
