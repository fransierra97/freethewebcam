import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, HOST, makeApp, SETUP } from './helpers.ts';
import { balance, unbalancedTransactions } from '../src/ledger/ledger.ts';
import { ccbillDigest, ccbillIpAllowed } from '../src/providers/adapters/ccbill.ts';
import { resetVendoIpCache, vendoSign } from '../src/providers/adapters/vendo.ts';
import { veriffSignature } from '../src/providers/adapters/veriff.ts';
import { idvDecision, ageDecision } from '../src/providers/adapters/yoti.ts';

// ---- Vectors from the official documentation ----

test('CCBill: the formDigest matches the example in its documentation', () => {
  // https://ccbill.com/doc/formdigest-value: "10.00" + "30" + "840" + salt
  assert.equal(ccbillDigest('10.00', '30', '840', '7d901dad245fd0ff6bc20d06'), 'a7459445d0e5dc0963fe736dc5cf900b');
  assert.equal(ccbillIpAllowed('64.38.212.10'), true);
  assert.equal(ccbillIpAllowed('::ffff:64.38.241.254'), true);
  assert.equal(ccbillIpAllowed('64.38.213.10'), false);
  assert.equal(ccbillIpAllowed('64.38.212.255'), false);
});

test('Vendo: the signature matches the example in its documentation', () => {
  assert.equal(vendoSign('/v/signup?site=1&offers=123', '3HDW9B'), 'UrYz6hgkRcRHmPksyIjTt_jFJ-g');
});

test('Yoti: interpreting results', () => {
  assert.equal(idvDecision({ state: 'ONGOING' }), 'pending');
  assert.equal(idvDecision({ state: 'EXPIRED' }), 'rejected');
  const check = (value: string) => ({ report: { recommendation: { value } } });
  assert.equal(idvDecision({ state: 'COMPLETED', checks: [check('APPROVE'), check('APPROVE')] }), 'approved');
  assert.equal(idvDecision({ state: 'COMPLETED', checks: [check('APPROVE'), check('REJECT')] }), 'rejected');
  assert.equal(ageDecision('COMPLETE'), 'approved');
  assert.equal(ageDecision('FAIL'), 'rejected');
  assert.equal(ageDecision('IN_PROGRESS'), 'pending');
});

// ---- Full flows with the provider in live mode ----

async function liveSetup(fakeFetch?: typeof fetch) {
  const { app, ctx } = await makeApp();
  const admin = new Browser(app);
  await admin.form('/setup', SETUP);
  if (fakeFetch) ctx.providers.fetchFn = fakeFetch;
  const fan = new Browser(app);
  await fan.form('/register', { email: 'fan@example.com', displayName: 'Fan', password: 'password123', adult: '1' });
  const fanId = (await ctx.db.one('select id from users where email = $1', ['fan@example.com'])).id;
  await ctx.db.query('update users set age_verified_at = now() where id = $1', [fanId]);
  return { app, ctx, admin, fan, fanId };
}

async function rawPost(app: any, url: string, payload: string, headers: Record<string, string>) {
  return app.inject({ method: 'POST', url, payload, headers: { host: HOST, ...headers } });
}

test('CCBill in live mode: payment, wrong amount, fake IP and chargeback', async () => {
  const { app, ctx, fan, fanId } = await liveSetup();
  await ctx.providers.saveCredentials('ccbill', { clientAccnum: '900000', clientSubacc: '0001', flexFormId: 'abc-123', salt: 'salt' });
  await ctx.providers.setMode('ccbill', 'live');

  const buy = await fan.form('/wallet/buy', { packageId: 'p100' });
  const url = new URL(String(buy.headers.location));
  assert.equal(url.origin + url.pathname, 'https://api.ccbill.com/wap-frontflex/flexforms/abc-123');
  assert.equal(url.searchParams.get('initialPrice'), '9.99');
  assert.equal(url.searchParams.get('currencyCode'), '840');
  assert.equal(url.searchParams.get('formDigest'), ccbillDigest('9.99', '30', '840', 'salt'));
  const purchaseId = url.searchParams.get('X-ftw_purchase')!;

  const sale = (price: string) =>
    JSON.stringify({ clientAccnum: '900000', clientSubacc: '0001', transactionId: 'T1', subscriptionInitialPrice: price, 'X-ftw_purchase': purchaseId });

  // From an IP that is not CCBill's: rejected.
  const fake = await rawPost(app, '/webhooks/ccbill?eventType=NewSaleSuccess', sale('9.99'), {
    'content-type': 'application/json',
    'x-forwarded-for': '203.0.113.5',
  });
  assert.equal(fake.statusCode, 401);
  assert.equal(await balance(ctx.db, 'wallet', fanId), 0);

  // Different amount: not credited.
  await rawPost(app, '/webhooks/ccbill?eventType=NewSaleSuccess', sale('0.99'), { 'content-type': 'application/json', 'x-forwarded-for': '64.38.212.7' });
  assert.equal(await balance(ctx.db, 'wallet', fanId), 0);

  // Correct notice (form), and repeated: credited only once.
  const form = new URLSearchParams({ clientAccnum: '900000', clientSubacc: '0001', transactionId: 'T1', subscriptionInitialPrice: '9.99', 'X-ftw_purchase': purchaseId }).toString();
  for (let i = 0; i < 2; i++) {
    const ok = await rawPost(app, '/webhooks/ccbill?eventType=NewSaleSuccess', form, {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '64.38.212.7',
    });
    assert.equal(ok.statusCode, 200);
  }
  assert.equal(await balance(ctx.db, 'wallet', fanId), 100);
  assert.equal((await fan.get('/wallet/return')).headers.location, '/wallet');

  // Chargeback: the tokens are withdrawn.
  await rawPost(app, '/webhooks/ccbill?eventType=Chargeback', sale('9.99'), { 'content-type': 'application/json', 'x-forwarded-for': '64.38.240.1' });
  assert.equal(await balance(ctx.db, 'wallet', fanId), 0);
  assert.equal((await ctx.db.one('select status from purchases where id = $1', [purchaseId])).status, 'chargeback');
  assert.equal(await unbalancedTransactions(ctx.db), 0);
  const log = await ctx.db.query('select ok from webhook_log where provider = $1', ['ccbill']);
  assert.ok(log.some((l: any) => !l.ok) && log.some((l: any) => l.ok));
});

test('Vendo in live mode: signed link and postback from its IP list', async () => {
  resetVendoIpCache();
  const fakeFetch = (async (input: any) => {
    if (String(input).endsWith('/api/postback-ip-list')) return new Response('52.210.98.38|34.242.162.168');
    throw new Error(`unexpected request ${input}`);
  }) as typeof fetch;
  const { app, ctx, fan, fanId } = await liveSetup(fakeFetch);
  await ctx.providers.saveCredentials('vendo', { siteId: '77', sharedSecret: 'secret' });
  await ctx.providers.setMode('vendo', 'live');
  // Vendo is first for LATAM: we simulate a visitor from Brazil with the country header.
  const buy = await app.inject({
    method: 'POST',
    url: '/wallet/buy',
    payload: 'packageId=p250',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded', 'cf-ipcountry': 'BR', cookie: `ftw_session=${fan.cookies.get('ftw_session')}` },
  });
  const location = String(buy.headers.location);
  assert.match(location, /^https:\/\/secure\.vend-o\.com\/v\/custom-offer\?/);
  const [base, signature] = location.split('&signature=');
  assert.equal(signature, vendoSign(base.replace('https://secure.vend-o.com', ''), 'secret'));
  const params = new URL(location).searchParams;
  assert.equal(params.get('token_quantity'), '250');
  assert.equal(params.get('token_amount'), '22.99');
  const purchaseId = params.get('ref')!;

  const body = new URLSearchParams({ callback: 'transaction', merchant_reference: purchaseId, transaction_id: 'V1', transaction_status: '1', invoice_amount: '22.99', invoice_currency: 'USD' }).toString();
  const bad = await rawPost(app, '/webhooks/vendo', body, { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.1' });
  assert.equal(bad.statusCode, 401);
  const ok = await rawPost(app, '/webhooks/vendo', body, { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '52.210.98.38' });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /<code>1<\/code>/);
  assert.equal(await balance(ctx.db, 'wallet', fanId), 250);
});

test('Veriff in live mode: session, signed notice and forged notice', async () => {
  const calls: any[] = [];
  const fakeFetch = (async (input: any, init: any) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/v1/sessions')) {
      return Response.json({ status: 'success', verification: { id: 'sess-1', url: 'https://alchemy.veriff.com/v/abc', status: 'created' } });
    }
    return Response.json({ status: 'success', verification: null });
  }) as typeof fetch;
  const { app, ctx, admin } = await liveSetup(fakeFetch);
  await ctx.providers.saveCredentials('veriff', { apiKey: 'key-1', sharedSecret: 'shh' });
  await ctx.providers.setMode('veriff', 'live');
  await ctx.providers.setEnabled('yoti', false); // Veriff becomes the creator provider
  const creator = await register(app, 'sol@example.com', 'Sol');
  const start = await creator.form('/become-creator', {});
  assert.equal(start.headers.location, 'https://alchemy.veriff.com/v/abc');
  assert.equal(calls[0].init.headers['x-auth-client'], 'key-1');
  const sent = JSON.parse(calls[0].init.body);
  const verificationId = Number(sent.verification.vendorData);
  assert.match(sent.verification.callback, new RegExp(`/verify/return/${verificationId}$`));

  const payload = JSON.stringify({ status: 'success', verification: { id: 'sess-1', status: 'approved', vendorData: String(verificationId) } });
  const forged = await rawPost(app, '/webhooks/veriff', payload, { 'content-type': 'application/json', 'x-hmac-signature': 'deadbeef' });
  assert.equal(forged.statusCode, 401);
  assert.equal((await ctx.db.one('select status from verifications where id = $1', [verificationId])).status, 'pending');

  const ok = await rawPost(app, '/webhooks/veriff', payload, { 'content-type': 'application/json', 'x-hmac-signature': veriffSignature(payload, 'shh') });
  assert.equal(ok.statusCode, 200);
  assert.equal((await ctx.db.one('select status from verifications where id = $1', [verificationId])).status, 'approved');
  assert.equal((await ctx.db.one("select creator_status from users where email = 'sol@example.com'")).creator_status, 'pending_approval');
  void admin;
});

test('Yoti (age) in live mode: session, return and result lookup', async () => {
  let status = 'IN_PROGRESS';
  const fakeFetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url === 'https://age.yoti.com/api/v1/sessions') {
      const body = JSON.parse(init.body);
      assert.equal(body.type, 'OVER');
      assert.equal(init.headers['yoti-sdk-id'], 'sdk-id-12345678901');
      return Response.json({ id: 'age-sess-1', expires_at: '2030-01-01T00:00:00Z' }, { status: 201 });
    }
    if (url === 'https://age.yoti.com/api/v1/sessions/age-sess-1/result') return Response.json({ status });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const { app, ctx } = await liveSetup(fakeFetch);
  await ctx.providers.saveCredentials('yoti', { clientSdkId: 'sdk-id-12345678901', ageApiKey: 'age-key' });
  await ctx.providers.setMode('yoti', 'live');
  const viewer = await register(app, 'newbie@example.com', 'Newbie');
  const start = await viewer.form('/verify/start', { purpose: 'viewer_age' });
  assert.equal(start.headers.location, 'https://age.yoti.com?sessionId=age-sess-1&sdkId=sdk-id-12345678901');
  const v = await ctx.db.one("select id from verifications where provider_ref = 'age-sess-1'");
  const pending = await viewer.get(`/verify/return/${v.id}`);
  assert.equal(pending.statusCode, 200);
  assert.match(pending.body, /has not returned a result yet/);
  status = 'COMPLETE';
  const done = await viewer.get(`/verify/return/${v.id}`);
  assert.equal(done.headers.location, '/');
  assert.ok((await ctx.db.one("select age_verified_at from users where email = 'newbie@example.com'")).age_verified_at);
});

test('with a live provider active, another one left in test mode is not used', async () => {
  const { ctx } = await liveSetup();
  await ctx.providers.saveCredentials('yoti', { clientSdkId: 'sdk-id-12345678901', ageApiKey: 'k' });
  await ctx.providers.setMode('yoti', 'live');
  const picked = await ctx.providers.pick(['unico', 'yoti'], 'viewer_age');
  assert.equal(picked?.manifest.id, 'yoti');
  assert.equal(picked?.mode, 'live');
});

test('notices from a provider in test mode are ignored', async () => {
  const { app } = await liveSetup();
  const res = await rawPost(app, '/webhooks/ccbill?eventType=NewSaleSuccess', '{}', { 'content-type': 'application/json', 'x-forwarded-for': '64.38.212.7' });
  assert.equal(res.statusCode, 404);
});

async function register(app: any, email: string, name: string) {
  const b = new Browser(app);
  await b.form('/register', { email, displayName: name, password: 'password123', adult: '1' });
  return b;
}
