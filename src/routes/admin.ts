import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { needAdmin } from '../web/guards.ts';
import { audit, UserError } from '../auth/users.ts';
import { pushState } from '../live/actions.ts';
import { endPrivate } from '../live/privates.ts';
import { endLive } from '../live/lifecycle.ts';
import { adjust, balance, reversePayout, unbalancedTransactions } from '../ledger/ledger.ts';
import { CATEGORY_LABELS, PROVIDERS, manifest } from '../providers/registry.ts';
import { isLowering, LEGAL_NOTES, MARKET_LABELS } from '../regions.ts';
import { isAgeRestricted, type AgeCheck, type Economy, type Market, type RegionRule, type Regions } from '../settings.ts';
import { date, html, money, type Raw } from '../web/html.ts';
import { field, go, intField, page } from '../web/respond.ts';
import { CREATOR_LABEL } from './public.ts';

const nav = html`<nav class="tabs" aria-label="Admin">
  <a href="/admin">Overview</a><a href="/admin/users">Users</a><a href="/admin/creators">Creators</a>
  <a href="/admin/live">Live</a><a href="/admin/moderation">Moderation</a><a href="/admin/verifications">Verifications</a>
  <a href="/admin/providers">Providers</a><a href="/admin/regions">Regions</a><a href="/admin/economy">Economy and levels</a>
  <a href="/admin/transactions">Transactions</a><a href="/admin/payouts">Payouts</a><a href="/admin/privates">Private shows</a>
  <a href="/admin/reports">Reports</a><a href="/admin/albums">Albums</a><a href="/admin/records">2257 records</a><a href="/admin/compliance">Compliance</a>
  <a href="/admin/legal">Legal pages</a><a href="/admin/media">Streaming</a><a href="/admin/webhooks">Webhooks</a>
  <a href="/admin/audit">Audit log</a><a href="/admin/settings">Site</a></nav>`;

const AGE_LABELS: Record<AgeCheck, string> = {
  verify: 'Real verification',
  self_declare: 'Self-declaration (“I am 18”)',
  blocked: 'Blocked',
};
const STATE_LABELS = { disabled: 'disabled', unconfigured: 'not configured', test: 'test', live: 'active (live)' };

function table(headers: string[], rows: Raw[]): Raw {
  if (!rows.length) return html`<p>Nothing to show.</p>`;
  return html`<table><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr>${rows}</table>`;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/admin') && !needAdmin(req, reply)) return reply;
  });

  // ---- Overview and to-do list ----
  app.get('/admin', async (req, reply) => {
    const { site, regions } = await ctx.settings.get();
    const providers = await ctx.providers.list();
    const n = async (sql: string) => (await ctx.db.one<{ n: number }>(sql))?.n ?? 0;
    const stats = {
      users: await n('select count(*)::int as n from users'),
      creators: await n("select count(*)::int as n from users where creator_status = 'approved'"),
      pendingCreators: await n("select count(*)::int as n from users where creator_status = 'pending_approval'"),
      live: await n('select count(*)::int as n from creator_profiles where is_live'),
      reports: await n("select count(*)::int as n from reports where status = 'open'"),
      payouts: await n("select count(*)::int as n from payouts where status = 'requested'"),
      sold: await n("select coalesce(sum(tokens), 0)::int as n from purchases where status = 'paid'"),
      revenue: await n("select coalesce(sum(price_cents), 0)::int as n from purchases where status = 'paid'"),
      unbalanced: await unbalancedTransactions(ctx.db),
      incidents: await n("select count(*)::int as n from moderation_incidents where status = 'open'"),
      records: await n("select count(*)::int as n from performer_records where status = 'submitted'"),
      albums: await n("select count(*)::int as n from albums where status = 'pending_review'"),
    };
    const platform = await balance(ctx.db, 'platform', null);
    const promoted = -(await balance(ctx.db, 'promotions', null));
    const { economy } = await ctx.settings.get();
    const kycReady = await ctx.providers.pick(regions.creatorKycProviders, 'creator_kyc');
    const checklist: Raw[] = [];
    const notLive = providers.filter((p) => p.enabled && p.state !== 'live');
    if (notLive.length)
      checklist.push(html`<li>${notLive.length} providers are still in test mode or not configured: <a href="/admin/providers">add your credentials</a>.
        <strong>In test mode anyone can fake their age verification and buy tokens for free: do not open the site to the public like this.</strong></li>`);
    if (!kycReady) checklist.push(html`<li><strong>No creator verification provider is active: nobody can go live.</strong></li>`);
    if (stats.pendingCreators) checklist.push(html`<li>${stats.pendingCreators} creators awaiting approval: <a href="/admin/creators">review</a>.</li>`);
    if (stats.incidents) checklist.push(html`<li><strong>${stats.incidents} open moderation cases: <a href="/admin/moderation">review now</a>.</strong></li>`);
    if (stats.albums) checklist.push(html`<li>${stats.albums} albums awaiting review: <a href="/admin/albums">review</a>.</li>`);
    if (stats.records) checklist.push(html`<li>${stats.records} performer records awaiting review: <a href="/admin/records">review</a>.</li>`);
    if (stats.reports) checklist.push(html`<li>${stats.reports} open reports: <a href="/admin/reports">review</a>.</li>`);
    if (stats.payouts) checklist.push(html`<li>${stats.payouts} payouts pending: <a href="/admin/payouts">review</a>.</li>`);
    if (stats.unbalanced) checklist.push(html`<li><strong>${stats.unbalanced} unbalanced ledger entries.</strong></li>`);
    return page(
      ctx,
      req,
      reply,
      'Admin',
      html`${nav}
      <h2>To do</h2>
      ${checklist.length ? html`<ul>${checklist}</ul>` : html`<p>All good.</p>`}
      <h2>Numbers</h2>
      <ul>
        <li>Site: ${site.name} (${site.mode === 'personal' ? 'personal' : 'group'} mode; markets ${site.markets.join(', ')})</li>
        <li>Users: ${stats.users} · Approved creators: ${stats.creators} · Live: ${stats.live}</li>
        <li>Tokens sold: ${stats.sold} · Sales revenue: ${money(stats.revenue, economy.currency)}</li>
        <li>Tokens earned by the platform (its share of spending): ${platform}</li>
        <li>Tokens given away by Admin: ${promoted}</li>
      </ul>`,
    );
  });

  // ---- Users ----
  app.get('/admin/users', async (req, reply) => {
    const q = String((req.query as any).q ?? '').trim();
    const rows = await ctx.db.query(
      `select id, email, display_name, is_admin, creator_status, status, age_verified_at, total_spent, created_at from users
       where $1 = '' or email ilike '%' || $1 || '%' or display_name ilike '%' || $1 || '%' order by id desc limit 200`,
      [q],
    );
    const out: Raw[] = [];
    for (const u of rows as any[]) {
      out.push(html`<tr><td>${u.id}</td><td>${u.display_name}</td><td>${u.email}</td>
        <td>${u.is_admin ? 'admin' : ''} ${CREATOR_LABEL[u.creator_status]}</td><td>${u.status}</td>
        <td>${u.age_verified_at ? 'yes' : 'no'}</td><td>${await balance(ctx.db, 'wallet', u.id)}</td><td>${u.total_spent}</td>
        <td>
          <form method="post" action="/admin/users/${u.id}/status" style="display:inline">
            <button name="status" value="${u.status === 'banned' ? 'active' : 'banned'}">${u.status === 'banned' ? 'Reactivate' : 'Suspend'}</button></form>
          <form method="post" action="/admin/users/${u.id}/admin" style="display:inline">
            <button name="is_admin" value="${u.is_admin ? '0' : '1'}">${u.is_admin ? 'Remove admin' : 'Make admin'}</button></form>
          <form method="post" action="/admin/users/${u.id}/tokens" style="display:inline">
            <input type="number" name="tokens" value="100" style="width:6em"> <button>Give tokens</button></form>
        </td></tr>`);
    }
    return page(
      ctx,
      req,
      reply,
      'Users',
      html`${nav}
      <form method="get"><input name="q" value="${q}" placeholder="Search by email or name"> <button>Search</button></form>
      ${table(['ID', 'Name', 'Email', 'Role', 'Status', 'Age verified', 'Balance', 'Spent', 'Actions'], out)}
      <p><small>“Give tokens” creates an adjustment flagged as test; use a negative number to take tokens back.</small></p>`,
    );
  });

  app.post('/admin/users/:id/status', async (req, reply) => {
    const id = Number((req.params as any).id);
    const status = field(req.body, 'status') === 'banned' ? 'banned' : 'active';
    if (id === req.user!.id) throw new UserError('You cannot suspend yourself.');
    await ctx.db.query('update users set status = $2 where id = $1', [id, status]);
    if (status === 'banned') {
      await ctx.db.query('delete from sessions where user_id = $1', [id]);
      await endLive(ctx, id, 'Account suspended');
    }
    await audit(ctx.db, req.user!.id, `user.${status}`, { userId: id });
    return go(reply, '/admin/users', 'ok', 'Done.');
  });

  app.post('/admin/users/:id/admin', async (req, reply) => {
    const id = Number((req.params as any).id);
    const value = field(req.body, 'is_admin') === '1';
    if (id === req.user!.id && !value) throw new UserError('You cannot remove your own admin role.');
    await ctx.db.query('update users set is_admin = $2 where id = $1', [id, value]);
    await audit(ctx.db, req.user!.id, value ? 'user.make_admin' : 'user.remove_admin', { userId: id });
    return go(reply, '/admin/users', 'ok', 'Done.');
  });

  app.post('/admin/users/:id/tokens', async (req, reply) => {
    const id = Number((req.params as any).id);
    const tokens = intField(req.body, 'tokens');
    if (!tokens || Math.abs(tokens) > 1_000_000) throw new UserError('Invalid amount.');
    await ctx.db.tx(async (q) => {
      await adjust(q, id, tokens, `Admin adjustment (${tokens > 0 ? '+' : ''}${tokens})`, req.user!.id);
      await audit(q, req.user!.id, 'tokens.adjust', { userId: id, tokens });
    });
    ctx.hub.toUser(id, { type: 'balance', balance: await balance(ctx.db, 'wallet', id) });
    return go(reply, '/admin/users', 'ok', 'Balance adjusted.');
  });

  // ---- Creators ----
  app.get('/admin/creators', async (req, reply) => {
    const rows = await ctx.db.query(
      `select u.id, u.display_name, u.creator_status, u.status, p.slug, p.is_live,
         (select status from verifications v where v.user_id = u.id and v.purpose = 'creator_kyc' order by id desc limit 1) as kyc
       from users u join creator_profiles p on p.user_id = u.id order by u.creator_status, u.id`,
    );
    const actions = (u: any) => {
      const b = (to: string, label: string) =>
        html`<form method="post" action="/admin/creators/${u.id}" style="display:inline"><button name="to" value="${to}">${label}</button></form> `;
      switch (u.creator_status) {
        case 'pending_approval':
          return html`${b('approved', 'Approve')}${b('rejected', 'Reject')}`;
        case 'approved':
          return b('suspended', 'Suspend');
        case 'suspended':
        case 'rejected':
          return b('approved', 'Reinstate');
        default:
          return '';
      }
    };
    return page(
      ctx,
      req,
      reply,
      'Creators',
      html`${nav}${table(
        ['Name', 'Room', 'Status', 'Verification', 'Live', 'Actions'],
        rows.map(
          (u: any) => html`<tr><td>${u.display_name}</td><td><a href="/c/${u.slug}">/c/${u.slug}</a></td><td>${CREATOR_LABEL[u.creator_status]}</td>
            <td>${u.kyc ?? 'not started'}</td><td>${u.is_live ? 'yes' : 'no'}</td><td>${actions(u)}</td></tr>`,
        ),
      )}
      <p><small>Only creators with an approved identity verification can be approved.</small></p>`,
    );
  });

  app.post('/admin/creators/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const to = field(req.body, 'to');
    if (!['approved', 'rejected', 'suspended'].includes(to)) throw new UserError('Invalid status.');
    if (to === 'approved') {
      const kyc = await ctx.db.one("select 1 from verifications where user_id = $1 and purpose = 'creator_kyc' and status = 'approved'", [id]);
      if (!kyc) throw new UserError('Cannot approve without an approved identity verification.');
    }
    await ctx.db.query('update users set creator_status = $2 where id = $1', [id, to]);
    if (to !== 'approved') {
      await endLive(ctx, id, 'Creator suspended');
    }
    await audit(ctx.db, req.user!.id, `creator.${to}`, { userId: id });
    return go(reply, '/admin/creators', 'ok', 'Done.');
  });

  // ---- Live ----
  app.get('/admin/live', async (req, reply) => {
    const rows = await ctx.db.query(
      `select p.user_id, p.slug, u.display_name, p.room_title, p.live_since,
         (select id from private_shows s where s.creator_id = p.user_id and s.status = 'active') as private_id
       from creator_profiles p join users u on u.id = p.user_id where p.is_live order by p.live_since`,
    );
    return page(
      ctx,
      req,
      reply,
      'Live',
      html`${nav}${table(
        ['Creator', 'Title', 'Since', 'Viewers', 'Private show', 'Actions'],
        rows.map(
          (r: any) => html`<tr><td><a href="/c/${r.slug}">${r.display_name}</a></td><td>${r.room_title}</td><td>${date(r.live_since)}</td>
            <td>${ctx.hub.viewerCount(r.user_id)}</td><td>${r.private_id ? `#${r.private_id}` : '—'}</td>
            <td><form method="post" action="/admin/live/${r.user_id}/stop" style="display:inline"><button>Stop stream</button></form></td></tr>`,
        ),
      )}`,
    );
  });

  app.post('/admin/live/:id/stop', async (req, reply) => {
    const id = Number((req.params as any).id);
    ctx.hub.broadcast(id, { type: 'system', text: 'Moderation has stopped this stream.' });
    await endLive(ctx, id, 'Stopped by moderation');
    await audit(ctx.db, req.user!.id, 'live.force_stop', { creatorId: id });
    return go(reply, '/admin/live', 'ok', 'Stream stopped.');
  });

  // ---- Verifications ----
  app.get('/admin/verifications', async (req, reply) => {
    const rows = await ctx.db.query(
      `select v.*, u.display_name from verifications v join users u on u.id = v.user_id order by v.id desc limit 200`,
    );
    return page(
      ctx,
      req,
      reply,
      'Verifications',
      html`${nav}
      <p><small>We do not store images or documents: only the result returned by the provider.</small></p>
      ${table(
        ['Date', 'User', 'Type', 'Provider', 'Status', 'Decided'],
        rows.map(
          (v: any) => html`<tr><td>${date(v.created_at)}</td><td>${v.display_name}</td>
            <td>${v.purpose === 'creator_kyc' ? 'Creator identity' : 'Viewer age'}</td>
            <td>${manifest(v.provider)?.name ?? v.provider}${v.test ? ' (test)' : ''}</td><td>${v.status}</td><td>${date(v.decided_at)}</td></tr>`,
        ),
      )}`,
    );
  });

  // ---- Providers ----
  app.get('/admin/providers', async (req, reply) => {
    const providers = await ctx.providers.list();
    const sections = providers.map((p) => {
      const m = p.manifest;
      return html`<section>
        <h2>${m.name} — ${STATE_LABELS[p.state]}</h2>
        <p>${m.categories.map((c) => CATEGORY_LABELS[c]).join(' · ')} · Markets: ${m.markets.join(', ')} ${m.website ? html` · <a href="${m.website}" target="_blank" rel="noopener">documentation</a>` : ''}</p>
        <p><small>${m.notes}${m.liveImplemented ? '' : ' Live integration pending: for now it works in test mode (simulation).'}
          ${m.fieldsConfirmed ? '' : ' Field names still need to be confirmed against the provider documentation.'}</small></p>
        <form method="post" action="/admin/providers/${m.id}/state" style="display:inline">
          <label><input type="checkbox" name="enabled" value="1" ${p.enabled ? 'checked' : ''}> Enabled</label>
          <select name="mode"><option value="test" ${p.mode === 'test' ? 'selected' : ''}>Test mode</option>
            <option value="live" ${p.mode === 'live' ? 'selected' : ''}>Live mode</option></select>
          <button>Save</button>
        </form>
        <form method="post" action="/admin/providers/${m.id}/test" style="display:inline"><button>Test</button></form>
        ${m.fields.length
          ? html`<form method="post" action="/admin/providers/${m.id}/credentials">
              ${m.fields.map(
                (f) => html`<label>${f.label}
                  ${f.multiline
                    ? html`<textarea name="${f.key}" placeholder="${f.secret && p.hasCredentials ? '(saved; leave empty to keep it)' : ''}"></textarea>`
                    : html`<input name="${f.key}" type="${f.secret ? 'password' : 'text'}" autocomplete="off"
                        placeholder="${f.secret && p.hasCredentials ? '(saved; empty = keep)' : ''}">`}
                </label><br>`,
              )}
              <button>Save credentials</button> <small>Stored encrypted.</small>
            </form>`
          : html`<p><small>No credentials needed.</small></p>`}
        <p><small>Webhook URL for its dashboard: <code>${ctx.cfg.publicUrl}/webhooks/${m.id}</code>
          ${m.categories.includes('payments') ? html` · Return URL after payment: <code>${ctx.cfg.publicUrl}/wallet/return</code>` : ''}</small></p>
      </section><hr>`;
    });
    return page(ctx, req, reply, 'Providers', html`${nav}
      <p>They come preconfigured in test mode. To take real payments and verify for real: add your credentials, click “Test” and switch to live mode.</p>
      ${sections}`);
  });

  app.post('/admin/providers/:id/state', async (req, reply) => {
    const id = (req.params as any).id;
    await ctx.providers.setEnabled(id, field(req.body, 'enabled') === '1');
    try {
      await ctx.providers.setMode(id, field(req.body, 'mode') === 'live' ? 'live' : 'test');
    } catch (err: any) {
      return go(reply, '/admin/providers', 'err', err.message);
    }
    await audit(ctx.db, req.user!.id, 'provider.state', { id, enabled: field(req.body, 'enabled') === '1', mode: field(req.body, 'mode') });
    return go(reply, '/admin/providers', 'ok', 'Saved.');
  });

  app.post('/admin/providers/:id/credentials', async (req, reply) => {
    const id = (req.params as any).id;
    const m = manifest(id);
    if (!m) throw new UserError('Unknown provider');
    const values = Object.fromEntries(m.fields.map((f) => [f.key, field(req.body, f.key)]));
    await ctx.providers.saveCredentials(id, values);
    await audit(ctx.db, req.user!.id, 'provider.credentials', { id });
    return go(reply, '/admin/providers', 'ok', `${m.name} credentials saved.`);
  });

  app.post('/admin/providers/:id/test', async (req, reply) => {
    const r = await ctx.providers.test((req.params as any).id);
    return go(reply, '/admin/providers', r.ok ? 'ok' : 'err', r.message);
  });

  // ---- Regions ----
  app.get('/admin/regions', async (req, reply) => {
    const { regions } = await ctx.settings.get();
    const markets = Object.keys(regions.regions) as Market[];
    const overrides = Object.entries(regions.countryOverrides)
      .map(([c, o]) =>
        [c, o.ageCheck ? `age=${o.ageCheck}` : '', o.viewerAgeProviders ? `age_providers=${o.viewerAgeProviders.join(',')}` : '', o.paymentProviders ? `payment=${o.paymentProviders.join(',')}` : '']
          .filter(Boolean)
          .join(' '),
      )
      .join('\n');
    const ids = PROVIDERS.map((p) => p.id).join(', ');
    return page(
      ctx,
      req,
      reply,
      'Regions',
      html`${nav}
      <form method="post" action="/admin/regions">
        <label>Creator verification (in order): <input name="creatorKyc" value="${regions.creatorKycProviders.join(', ')}"></label>
        ${markets.map((m) => {
          const r = regions.regions[m];
          return html`<fieldset><legend>${MARKET_LABELS[m]}</legend>
            ${LEGAL_NOTES[m] ? html`<p><small>${LEGAL_NOTES[m]}</small></p>` : ''}
            <label>Age check <select name="${m}_age">${(Object.keys(AGE_LABELS) as AgeCheck[]).map(
              (a) => html`<option value="${a}" ${r.ageCheck === a ? 'selected' : ''}>${AGE_LABELS[a]}</option>`,
            )}</select></label><br>
            <label>Age verification (in order) <input name="${m}_viewer" value="${r.viewerAgeProviders.join(', ')}"></label><br>
            <label>Payments (in order) <input name="${m}_pay" value="${r.paymentProviders.join(', ')}"></label>
          </fieldset>`;
        })}
        <fieldset><legend>Per-country settings</legend>
          <p><small>One line per country: <code>BR age=verify age_providers=unico,yoti payment=vendo,ccbill</code>. ${LEGAL_NOTES.BR} ${LEGAL_NOTES.FR}</small></p>
          <textarea name="overrides" rows="6" cols="60">${overrides}</textarea>
        </fieldset>
        <p><small>Available providers: ${ids}</small></p>
        <label><input type="checkbox" name="ack" value="1"> I understand that lowering an age check may break the law in that region and that the operator is responsible.</label><br>
        <button>Save</button>
      </form>`,
    );
  });

  app.post('/admin/regions', async (req, reply) => {
    const b = req.body;
    const { regions } = await ctx.settings.get();
    const known = new Set(PROVIDERS.map((p) => p.id));
    const check = (ids: string[]) => {
      const bad = ids.filter((i) => !known.has(i));
      if (bad.length) throw new UserError(`Unknown providers: ${bad.join(', ')}`);
      return ids;
    };
    const next: Regions = { creatorKycProviders: check(list(field(b, 'creatorKyc'))), regions: { ...regions.regions }, countryOverrides: {} };
    const lowered: string[] = [];
    for (const m of Object.keys(regions.regions) as Market[]) {
      const age = field(b, `${m}_age`) as AgeCheck;
      if (!AGE_LABELS[age]) throw new UserError('Invalid age check.');
      if (isLowering(regions.regions[m].ageCheck, age)) lowered.push(m);
      next.regions[m] = { ageCheck: age, viewerAgeProviders: check(list(field(b, `${m}_viewer`))), paymentProviders: check(list(field(b, `${m}_pay`))) };
    }
    for (const line of field(b, 'overrides').split('\n')) {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const country = parts.shift()!.toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw new UserError(`Invalid country: ${country}`);
      const o: Partial<RegionRule> = {};
      for (const p of parts) {
        const [k, v = ''] = p.split('=');
        if (k === 'age') {
          if (!AGE_LABELS[v as AgeCheck]) throw new UserError(`Invalid age check for ${country}`);
          o.ageCheck = v as AgeCheck;
        } else if (k === 'age_providers') o.viewerAgeProviders = check(list(v));
        else if (k === 'payment') o.paymentProviders = check(list(v));
        else throw new UserError(`Unknown key for ${country}: ${k}`);
      }
      const before = regions.countryOverrides[country]?.ageCheck;
      if (o.ageCheck && before && isLowering(before, o.ageCheck)) lowered.push(country);
      if (o.ageCheck && !before && (LEGAL_NOTES[country] || isLowering('verify', o.ageCheck))) lowered.push(country);
      next.countryOverrides[country] = o;
    }
    if (lowered.length && field(b, 'ack') !== '1') {
      return go(reply, '/admin/regions', 'err', `You are lowering the age check in ${lowered.join(', ')}: tick the confirmation box.`);
    }
    await ctx.settings.set('regions', next);
    await audit(ctx.db, req.user!.id, lowered.length ? 'regions.update_lowered' : 'regions.update', { lowered });
    return go(reply, '/admin/regions', 'ok', 'Rules saved.');
  });

  // ---- Economy and levels ----
  app.get('/admin/economy', async (req, reply) => {
    const { economy: e } = await ctx.settings.get();
    return page(
      ctx,
      req,
      reply,
      'Economy and levels',
      html`${nav}
      <form method="post" action="/admin/economy">
        <label>Currency (ISO) <input name="currency" value="${e.currency}" maxlength="3" size="4"></label><br>
        <label>Creator's share (%) <input type="number" name="creatorSharePct" min="0" max="100" value="${e.creatorSharePct}"></label><br>
        <label>Payout value per earned token (cents) <input type="number" name="tokenValueCents" min="0" value="${e.tokenValueCents}"></label><br>
        <label>Minimum to request a payout (tokens) <input type="number" name="payoutMinTokens" min="1" value="${e.payoutMinTokens}"></label><br>
        <label>Minimum tip (tokens) <input type="number" name="tipMin" min="1" value="${e.tipMin}"></label><br>
        <fieldset><legend>Token packages</legend>
          <p><small>One line per package: <code>id tokens price_in_cents</code></small></p>
          <textarea name="packages" rows="6" cols="40">${e.packages.map((p) => `${p.id} ${p.tokens} ${p.priceCents}`).join('\n')}</textarea>
        </fieldset>
        <fieldset><legend>Viewer levels</legend>
          <p><small>One line per level: <code>Name minimum_tokens_spent</code>. Calculated from everything spent (tips, menu and private shows).</small></p>
          <textarea name="levels" rows="6" cols="40">${e.levels.map((l) => `${l.name} ${l.minSpent}`).join('\n')}</textarea>
        </fieldset>
        <button>Save</button>
      </form>`,
    );
  });

  app.post('/admin/economy', async (req, reply) => {
    const b = req.body;
    const nums = (k: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
      const n = intField(b, k);
      if (!(n >= min && n <= max)) throw new UserError(`Invalid value: ${k}`);
      return n;
    };
    const packages = field(b, 'packages')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, tokens, price] = l.split(/\s+/);
        const t = Number(tokens);
        const p = Number(price);
        if (!/^[a-z0-9_-]{1,20}$/i.test(id ?? '') || !Number.isInteger(t) || t <= 0 || !Number.isInteger(p) || p <= 0)
          throw new UserError(`Invalid package: ${l}`);
        return { id, tokens: t, priceCents: p };
      });
    const levels = field(b, 'levels')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = l.match(/^(.+?)\s+(\d+)$/);
        if (!m) throw new UserError(`Invalid level: ${l}`);
        return { name: m[1].slice(0, 30), minSpent: Number(m[2]) };
      });
    if (!packages.length) throw new UserError('Add at least one package.');
    if (!levels.length) throw new UserError('Add at least one level.');
    const currency = field(b, 'currency').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new UserError('Invalid currency.');
    const economy: Economy = {
      currency,
      creatorSharePct: nums('creatorSharePct', 0, 100),
      tokenValueCents: nums('tokenValueCents', 0),
      payoutMinTokens: nums('payoutMinTokens', 1),
      tipMin: nums('tipMin', 1),
      packages,
      levels,
    };
    await ctx.settings.set('economy', economy);
    await audit(ctx.db, req.user!.id, 'economy.update', { creatorSharePct: economy.creatorSharePct });
    return go(reply, '/admin/economy', 'ok', 'Saved.');
  });

  // ---- Transactions ----
  app.get('/admin/transactions', async (req, reply) => {
    const rows = await ctx.db.query(
      `select t.id, t.kind, t.memo, t.test, t.created_at,
         string_agg(a.kind || coalesce(':' || u.display_name, '') || ' ' || case when e.amount > 0 then '+' else '' end || e.amount, ' · ' order by e.id) as entries
       from ledger_tx t join ledger_entries e on e.tx_id = t.id join accounts a on a.id = e.account_id
       left join users u on u.id = a.user_id group by t.id order by t.id desc limit 200`,
    );
    const unbalanced = await unbalancedTransactions(ctx.db);
    return page(
      ctx,
      req,
      reply,
      'Transactions',
      html`${nav}
      <p>Ledger check: ${unbalanced ? html`<strong>${unbalanced} unbalanced entries</strong>` : 'all entries balance.'}</p>
      ${table(
        ['#', 'Date', 'Type', 'Memo', 'Entries', 'Test'],
        rows.map(
          (t: any) => html`<tr><td>${t.id}</td><td>${date(t.created_at)}</td><td>${t.kind}</td><td>${t.memo}</td><td><small>${t.entries}</small></td><td>${t.test ? 'yes' : ''}</td></tr>`,
        ),
      )}`,
    );
  });

  // ---- Payouts ----
  app.get('/admin/payouts', async (req, reply) => {
    const rows = await ctx.db.query(
      'select p.*, u.display_name from payouts p join users u on u.id = p.creator_id order by (p.status = $1) desc, p.id desc limit 200',
      ['requested'],
    );
    return page(
      ctx,
      req,
      reply,
      'Payouts',
      html`${nav}
      <p><small>Simulated: marking as paid does not move money. Make the transfer yourself and mark it afterwards.</small></p>
      ${table(
        ['#', 'Date', 'Creator', 'Tokens', 'Amount', 'Status', 'Actions'],
        rows.map(
          (p: any) => html`<tr><td>${p.id}</td><td>${date(p.created_at)}</td><td>${p.display_name}</td><td>${p.tokens}</td>
            <td>${money(p.amount_cents, p.currency)}</td><td>${p.status}</td>
            <td>${p.status === 'requested'
              ? html`<form method="post" action="/admin/payouts/${p.id}" style="display:inline">
                  <button name="to" value="paid">Mark paid</button> <button name="to" value="rejected">Reject</button></form>`
              : date(p.decided_at)}</td></tr>`,
        ),
      )}`,
    );
  });

  app.post('/admin/payouts/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const to = field(req.body, 'to') === 'paid' ? 'paid' : 'rejected';
    await ctx.db.tx(async (q) => {
      const p = await q.one<{ id: number; creator_id: number; tokens: number; status: string }>(
        'select id, creator_id, tokens, status from payouts where id = $1 for update',
        [id],
      );
      if (!p || p.status !== 'requested') throw new UserError('That payout is no longer pending.');
      await q.query('update payouts set status = $2, decided_at = now() where id = $1', [id, to]);
      if (to === 'rejected') await reversePayout(q, p.creator_id, p.tokens, p.id);
      await audit(q, req.user!.id, `payout.${to}`, { payoutId: id });
    });
    return go(reply, '/admin/payouts', 'ok', to === 'paid' ? 'Marked as paid.' : 'Rejected; the tokens go back to the creator.');
  });

  // ---- Private shows ----
  app.get('/admin/privates', async (req, reply) => {
    const rows = await ctx.db.query(
      `select s.*, c.display_name as creator, v.display_name as viewer from private_shows s
       join users c on c.id = s.creator_id join users v on v.id = s.viewer_id order by s.id desc limit 200`,
    );
    return page(
      ctx,
      req,
      reply,
      'Private shows',
      html`${nav}${table(
        ['#', 'Date', 'Creator', 'Viewer', 'Status', 'Price/min', 'Minutes', 'Tokens', 'End', ''],
        rows.map(
          (s: any) => html`<tr><td>${s.id}</td><td>${date(s.created_at)}</td><td>${s.creator}</td><td>${s.viewer}</td><td>${s.status}</td>
            <td>${s.price_per_min}</td><td>${s.minutes_billed}</td><td>${s.tokens_billed}</td><td>${s.end_reason ?? ''}</td>
            <td>${s.status === 'active' ? html`<form method="post" action="/admin/privates/${s.id}/end"><button>Stop</button></form>` : ''}</td></tr>`,
        ),
      )}`,
    );
  });

  app.post('/admin/privates/:id/end', async (req, reply) => {
    const id = Number((req.params as any).id);
    await endPrivate(ctx, id, 'Stopped by moderation');
    await audit(ctx.db, req.user!.id, 'private.force_end', { showId: id });
    return go(reply, '/admin/privates', 'ok', 'Private show stopped.');
  });

  // ---- Reports ----
  app.get('/admin/reports', async (req, reply) => {
    const rows = await ctx.db.query(
      `select r.*, u.display_name as reporter, c.display_name as creator, p.slug from reports r
       join users u on u.id = r.reporter_id join users c on c.id = r.creator_id join creator_profiles p on p.user_id = r.creator_id
       order by (r.status = 'open') desc, r.id desc limit 200`,
    );
    return page(
      ctx,
      req,
      reply,
      'Reports',
      html`${nav}
      <p><small>If a report points to minors or non-consensual content: stop the stream, suspend the account and notify the authorities (in the US, NCMEC).</small></p>
      ${table(
        ['#', 'Date', 'Reporter', 'Room', 'Reason', 'Status', 'Actions'],
        rows.map(
          (r: any) => html`<tr><td>${r.id}</td><td>${date(r.created_at)}</td><td>${r.reporter}</td><td><a href="/c/${r.slug}">${r.creator}</a></td>
            <td>${r.reason}</td><td>${r.status}${r.resolution ? html`<br><small>${r.resolution}</small>` : ''}</td>
            <td>${r.status === 'open'
              ? html`<form method="post" action="/admin/reports/${r.id}"><input name="resolution" placeholder="What was done" required>
                  <label><input type="checkbox" name="suspend" value="1"> Suspend creator</label> <button>Close</button></form>`
              : ''}</td></tr>`,
        ),
      )}`,
    );
  });

  app.post('/admin/reports/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const report = await ctx.db.one<{ creator_id: number }>('select creator_id from reports where id = $1', [id]);
    if (!report) throw new UserError('Report not found.');
    if (field(req.body, 'suspend') === '1') {
      await ctx.db.query("update users set creator_status = 'suspended' where id = $1", [report.creator_id]);
      await endLive(ctx, report.creator_id, 'Creator suspended');
    }
    await ctx.db.query("update reports set status = 'resolved', resolution = $2 where id = $1", [id, field(req.body, 'resolution').slice(0, 500)]);
    await audit(ctx.db, req.user!.id, 'report.resolve', { reportId: id, suspended: field(req.body, 'suspend') === '1' });
    return go(reply, '/admin/reports', 'ok', 'Report closed.');
  });

  // ---- Provider webhooks ----
  app.get('/admin/webhooks', async (req, reply) => {
    const rows = await ctx.db.query('select * from webhook_log order by id desc limit 300');
    return page(
      ctx,
      req,
      reply,
      'Provider webhooks',
      html`${nav}
      <p><small>Every webhook received from a live provider. Rejected ones change nothing.</small></p>
      ${table(
        ['Date', 'Provider', 'Accepted', 'Detail', 'IP'],
        rows.map((w: any) => html`<tr><td>${date(w.created_at)}</td><td>${manifest(w.provider)?.name ?? w.provider}</td><td>${w.ok ? 'yes' : 'no'}</td><td>${w.note}</td><td>${w.ip}</td></tr>`),
      )}`,
    );
  });

  // ---- Audit log ----
  app.get('/admin/audit', async (req, reply) => {
    const rows = await ctx.db.query(
      'select a.*, u.display_name from audit_log a left join users u on u.id = a.actor_id order by a.id desc limit 300',
    );
    return page(
      ctx,
      req,
      reply,
      'Audit log',
      html`${nav}${table(
        ['Date', 'Who', 'Action', 'Details'],
        rows.map((a: any) => html`<tr><td>${date(a.created_at)}</td><td>${a.display_name ?? 'system'}</td><td>${a.action}</td><td><small>${JSON.stringify(a.details)}</small></td></tr>`),
      )}`,
    );
  });

  // ---- Site ----
  app.get('/admin/settings', async (req, reply) => {
    const { site } = await ctx.settings.get();
    return page(
      ctx,
      req,
      reply,
      'Site',
      html`${nav}
      <form method="post" action="/admin/settings">
        <label>Name <input name="name" value="${site.name}" maxlength="60" required></label><br>
        <label>Brand color <input type="color" name="brandColor" value="${site.brandColor ?? '#d6336c'}"></label><br>
        <label><input type="checkbox" name="ageRestricted" value="1" ${isAgeRestricted(site) ? 'checked' : ''}> Adults-only site (viewer age verification and 18+ notices)</label><br>
        <p><small>Performer records (2257) are enabled separately, under <a href="/admin/compliance">Compliance</a>.</small></p>
        <label><input type="radio" name="mode" value="personal" ${site.mode === 'personal' ? 'checked' : ''}> Personal</label>
        <label><input type="radio" name="mode" value="group" ${site.mode === 'group' ? 'checked' : ''}> Group</label><br>
        <button>Save</button>
      </form>
      ${ctx.cfg.demo
        ? html`<h2>Demo: simulate visitor country</h2>
          <p>Country detected now: ${req.country || 'unknown'}. Use it to test per-region rules.</p>
          <form method="post" action="/demo/country"><input type="hidden" name="next" value="/admin/settings">
            <input name="country" maxlength="2" size="3" placeholder="BR"> <button>Simulate</button> <small>(empty = clear)</small></form>`
        : ''}
      <h2>Technical details</h2>
      <ul><li>Public URL: ${ctx.cfg.publicUrl}</li><li>Video server: ${ctx.cfg.livekitUrl}</li>
        <li>Database: ${ctx.cfg.databaseUrl ? 'PostgreSQL' : 'embedded (PGlite)'}</li><li>Country header: ${ctx.cfg.geoHeader}</li></ul>`,
    );
  });

  app.post('/admin/settings', async (req, reply) => {
    const { site } = await ctx.settings.get();
    const name = field(req.body, 'name').trim().slice(0, 60);
    if (!name) throw new UserError('Enter a name.');
    const mode = field(req.body, 'mode') === 'group' ? 'group' : 'personal';
    const color = field(req.body, 'brandColor').toLowerCase();
    const brandColor = /^#[0-9a-f]{6}$/.test(color) ? color : site.brandColor;
    const ageRestricted = field(req.body, 'ageRestricted') === '1';
    if (isAgeRestricted(site) && !ageRestricted) await audit(ctx.db, req.user!.id, 'site.age_restriction_off');
    await ctx.settings.set('site', { ...site, name, mode, brandColor, ageRestricted });
    await audit(ctx.db, req.user!.id, 'site.update', { name, mode });
    return go(reply, '/admin/settings', 'ok', 'Saved.');
  });

}
