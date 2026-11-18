import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, makeApp, SETUP } from './helpers.ts';
import { renderLegal } from '../src/web/legal.ts';

test('legal texts: template with operator details, safe editing and restore', async () => {
  const { app } = await makeApp();
  const admin = new Browser(app);
  await admin.form('/setup', SETUP);
  const anon = new Browser(app);

  const before = await anon.get('/legal/terms');
  assert.equal(before.statusCode, 200);
  assert.match(before.body, /operator name not configured/);
  assert.match(before.body, /2257 Record-Keeping Requirements Compliance Statement/, 'the footer links to the 2257 statement');

  await admin.form('/admin/compliance', {
    require2257: '1', operatorName: 'Example Operator Ltd', operatorAddress: '1 Example Street', contactEmail: 'legal@example.com',
    custodianName: 'C', custodianTitle: 'T', custodianAddress: '2 Example Street', frameIntervalSeconds: '60', frameRetentionDays: '7',
  });
  assert.match((await anon.get('/legal/privacy')).body, /Example Operator Ltd/);

  await admin.form('/admin/legal/rules', { body: '# Rules\n\nNo <script>alert(1)</script>, thanks to {{operator}}.\n\n- one\n- two' });
  const edited = await anon.get('/legal/rules');
  assert.match(edited.body, /&lt;script&gt;/);
  assert.doesNotMatch(edited.body, /<script>alert/);
  assert.match(edited.body, /<li>one<\/li>/);
  await admin.form('/admin/legal/rules/reset', {});
  assert.match((await anon.get('/legal/rules')).body, /Only adults/);

  assert.equal((await anon.get('/legal/inventada')).statusCode, 404);
  assert.equal((await anon.get('/admin/legal')).statusCode, 303, 'editing is for administration only');
});

test('legal text formatting escapes HTML', () => {
  const out = renderLegal('> <b>note</b>\n\n# <i>t</i>').value;
  assert.ok(!out.includes('<b>') && !out.includes('<i>'));
});
