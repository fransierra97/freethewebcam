import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { needUser, DEMO_COUNTRY_COOKIE } from '../web/guards.ts';
import { viewerAccess } from '../access.ts';
import { audit, ensureCreatorProfile, UserError } from '../auth/users.ts';
import { publishedAlbums } from '../content/albums.ts';
import { REACTIONS } from '../live/chatmod.ts';
import { activePrivate, creatorBySlug, isBanned, listCreators, type CreatorRow } from '../live/actions.ts';
import { balance } from '../ledger/ledger.ts';
import { completePurchase, getPurchase, startPurchase } from '../ledger/purchases.ts';
import { manifest } from '../providers/registry.ts';
import { MARKET_LABELS, ruleFor } from '../regions.ts';
import { isAgeRestricted, levelFor } from '../settings.ts';
import { decideVerification, getVerification, refreshVerification, startVerification } from '../verification/verify.ts';
import { date, html, money, type Raw } from '../web/html.ts';
import { field, go, page } from '../web/respond.ts';

const CREATOR_LABEL: Record<string, string> = {
  none: 'Not requested',
  pending_kyc: 'Identity verification needed',
  pending_approval: 'Pending approval by Admin',
  approved: 'Approved',
  rejected: 'Rejected',
  suspended: 'Suspended',
};
export { CREATOR_LABEL };

/** Stable color hue for each room (cards don't show stream images). */
function hueFor(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 360;
  // Warm range (purples, pinks, corals) to keep the listing consistent.
  return 280 + (h % 110);
}

export function creatorCard(c: CreatorRow, inPrivate: boolean, viewers: number): Raw {
  const badge = !c.is_live ? html`<span class="badge">Offline</span>` : inPrivate ? html`<span class="badge private">Private show</span>` : html`<span class="badge live">Live now</span>`;
  return html`<li class="card ${c.is_live ? '' : 'offline'}"><a href="/c/${c.slug}">
    <div class="card-media" style="--hue:${hueFor(c.slug)}">
      ${badge}
      <span class="card-initial">${c.display_name.slice(0, 1)}</span>
      ${c.is_live ? html`<span class="viewers-chip">${viewers} watching</span>` : ''}
    </div>
    <div class="card-body">
      <div class="card-title"><span>${c.display_name}</span>${c.private_enabled ? html`<small>${c.private_price_per_min} tk/min</small>` : ''}</div>
      <div class="card-sub">${c.room_title || 'Untitled'}</div>
    </div>
  </a></li>`;
}

function statusText(c: CreatorRow, inPrivate: boolean): string {
  if (!c.is_live) return 'Offline';
  return inPrivate ? 'Private show' : 'Live now';
}

/** Checks age and region access; if something is missing, redirects to the right screen. */
export async function gate(ctx: Ctx, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const access = await viewerAccess(ctx, req.user, req.country);
  if (access.ok) return true;
  if (access.reason === 'login') go(reply, `/login?next=${encodeURIComponent(req.url)}`);
  else go(reply, `/age-check?next=${encodeURIComponent(req.url)}`);
  return false;
}

export async function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/', async (req, reply) => {
    const { site } = await ctx.settings.get();
    if (!req.user) {
      const restricted = isAgeRestricted(site);
      return page(
        ctx,
        req,
        reply,
        site.name,
        html`<section class="hero">
          <h1>Live streams, close to the people who make them.</h1>
          <p class="lead">Live rooms from verified creators, with chat, tips and private shows.${restricted ? ' 18+ only.' : ''}</p>
          <div class="actions">
            <a class="button primary" href="/register">Sign up</a>
            <a class="button" href="/login">I already have an account</a>
          </div>
        </section>
        <section class="features">
          <div class="feature"><h3>Verified creators</h3><p>Everyone who appears on camera has verified their identity and age.</p></div>
          <div class="feature"><h3>You decide</h3><p>Tips, a request menu and per-minute private shows, with no subscriptions.</p></div>
          <div class="feature"><h3>Privacy</h3><p>${restricted ? 'To verify your age we only receive “over 18: yes”. Nothing else.' : 'We keep the bare minimum and never sell your data.'}</p></div>
        </section>`,
        { hideTitle: true },
      );
    }
    if (!(await gate(ctx, req, reply))) return;
    const creators = await listCreators(ctx.db);
    if (site.mode === 'personal') {
      const only = creators[0];
      if (only) return go(reply, `/c/${only.slug}`);
      return page(
        ctx,
        req,
        reply,
        site.name,
        html`<div class="empty"><p>There are no live streams yet.</p>
        ${req.user.is_admin ? html`<p><a class="button primary" href="/studio">Go to my Studio</a></p>` : ''}</div>`,
      );
    }
    const rows = [];
    let liveCount = 0;
    for (const c of creators) {
      const inPrivate = Boolean(await activePrivate(ctx.db, c.user_id));
      if (c.is_live) liveCount++;
      rows.push(creatorCard(c, inPrivate, c.is_live ? ctx.hub.viewerCount(c.user_id) : 0));
    }
    return page(
      ctx,
      req,
      reply,
      'Live',
      html`<div class="section-head"><h1>Live</h1><span class="pill">${liveCount} live now</span></div>
      ${rows.length ? html`<ul class="cards">${rows}</ul>` : html`<div class="empty">There are no approved creators yet.</div>`}`,
      { hideTitle: true },
    );
  });

  // ---- Age and region check ----
  app.get('/age-check', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const next = String((req.query as any).next ?? '/');
    const access = await viewerAccess(ctx, req.user, req.country);
    if (access.ok) return go(reply, next.startsWith('/') && !next.startsWith('//') ? next : '/');
    const { regions } = await ctx.settings.get();
    const rule = ruleFor(regions, req.country);
    const where = html`<p><small>Detected region: ${req.country || 'unknown'} (${MARKET_LABELS[rule.market]}).</small></p>`;
    let body;
    switch (access.reason) {
      case 'verify':
        body = html`<p>To enter you need to verify that you are an adult. We only receive “over 18: yes”, not your data.</p>
          <form method="post" action="/verify/start">
            <input type="hidden" name="purpose" value="viewer_age"><input type="hidden" name="next" value="${next}">
            <button>Verify with ${manifest(access.providerId!)?.name}</button>
          </form>`;
        break;
      case 'self_declare':
        body = html`<form method="post" action="/age-check/declare">
            <input type="hidden" name="next" value="${next}">
            <button>I confirm that I am 18 or older</button>
          </form>`;
        break;
      case 'banned':
        body = html`<p>Your account is suspended.</p>`;
        break;
      case 'no_provider':
        body = html`<p>This site is not yet available in your region: there is no active age verification provider.</p>`;
        break;
      default:
        body = html`<p>This site is not available in your region.</p>`;
    }
    return page(ctx, req, reply, 'Age verification', html`${body}${where}`);
  });

  app.post('/age-check/declare', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const access = await viewerAccess(ctx, req.user, req.country);
    if (access.reason !== 'self_declare') return go(reply, '/age-check', 'err', 'Your region requires real verification.');
    await ctx.db.query('update users set age_self_declared_at = now() where id = $1', [req.user.id]);
    return go(reply, field(req.body, 'next') || '/');
  });

  app.post('/verify/start', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const purpose = field(req.body, 'purpose') === 'creator_kyc' ? 'creator_kyc' : 'viewer_age';
    if (purpose === 'creator_kyc' && req.user.creator_status === 'none') {
      const performer = await ctx.db.one("select 1 from performer_records where user_id = $1 and status <> 'removed'", [req.user.id]);
      if (!performer) return go(reply, '/become-creator');
    }
    const url = await startVerification(ctx, req.user, purpose, req.country);
    const next = field(req.body, 'next');
    return go(reply, next ? `${url}?next=${encodeURIComponent(next)}` : url);
  });

  // ---- Return from a real provider ----
  app.get('/verify/return/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    let v = await getVerification(ctx, Number((req.params as any).id));
    if (!v || v.user_id !== req.user.id) return reply.code(404).send('Not found');
    try {
      v = (await refreshVerification(ctx, v.id)) ?? v;
    } catch (err) {
      req.log.warn({ err }, 'refreshVerification');
    }
    const done = v.purpose === 'creator_kyc' ? (req.user.creator_status === 'none' ? '/performer' : '/studio') : '/';
    if (v.status === 'approved') return go(reply, done, 'ok', 'Verification approved.');
    if (v.status === 'rejected') return go(reply, done, 'err', 'The verification was not approved. You can try again.');
    return page(
      ctx,
      req,
      reply,
      'Checking your verification',
      html`<meta http-equiv="refresh" content="5">
      <p>The provider has not returned a result yet. This page refreshes automatically.</p>
      <p><a href="${done}">Back</a></p>`,
    );
  });

  /** Page shown after paying (set it as the success URL in the provider dashboard). */
  app.get('/wallet/return', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const p = await ctx.db.one<{ id: number; status: string; tokens: number; created_at: Date }>(
      "select id, status, tokens, created_at from purchases where user_id = $1 and created_at > now() - interval '1 day' order by id desc limit 1",
      [req.user.id],
    );
    if (!p) return go(reply, '/wallet');
    if (p.status === 'paid') return go(reply, '/wallet', 'ok', `Payment confirmed: ${p.tokens} tokens added.`);
    if (p.status !== 'pending') return go(reply, '/wallet', 'err', 'The payment was not completed.');
    return page(
      ctx,
      req,
      reply,
      'Waiting for payment confirmation',
      html`<meta http-equiv="refresh" content="5">
      <p>As soon as the provider confirms the payment you will see the tokens in your wallet. This page refreshes automatically.</p>
      <p><a href="/wallet">Go to wallet</a></p>`,
    );
  });

  // ---- Provider simulations (only for test mode records) ----
  app.get('/sandbox/verify/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const v = await getVerification(ctx, Number((req.params as any).id));
    if (!v || v.user_id !== req.user.id || !v.test) return reply.code(404).send('Not found');
    const next = String((req.query as any).next ?? '');
    const name = manifest(v.provider)?.name ?? v.provider;
    const what = v.purpose === 'creator_kyc' ? 'ID document and liveness check' : 'age check';
    return page(
      ctx,
      req,
      reply,
      `${name} simulation`,
      html`<p>In production, the ${name} screen for the ${what} would appear here.</p>
      <p>Current status: <strong>${v.status}</strong></p>
      ${v.status === 'pending'
        ? html`<form method="post" action="/sandbox/verify/${v.id}">
            <input type="hidden" name="next" value="${next}">
            <button name="result" value="approve">Simulate approval</button>
            <button name="result" value="reject">Simulate rejection</button>
          </form>`
        : html`<p><a href="/">Back</a></p>`}`,
    );
  });

  app.post('/sandbox/verify/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const v = await getVerification(ctx, Number((req.params as any).id));
    if (!v || v.user_id !== req.user.id || !v.test) return reply.code(404).send('Not found');
    const approved = field(req.body, 'result') === 'approve';
    await decideVerification(ctx, v.id, approved, req.user.id);
    const next = field(req.body, 'next');
    const kycHome = req.user.creator_status === 'none' ? '/performer' : '/studio';
    const dest = v.purpose === 'creator_kyc' ? kycHome : next.startsWith('/') && !next.startsWith('//') ? next : '/';
    return go(reply, dest, approved ? 'ok' : 'err', approved ? 'Verification approved.' : 'Verification rejected.');
  });

  app.get('/sandbox/pay/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const p = await getPurchase(ctx, Number((req.params as any).id));
    if (!p || p.user_id !== req.user.id || !p.test) return reply.code(404).send('Not found');
    const name = manifest(p.provider)?.name ?? p.provider;
    return page(
      ctx,
      req,
      reply,
      `Simulated payment with ${name}`,
      html`<p>${p.tokens} tokens for ${money(p.price_cents, p.currency)}.</p>
      <p>In production, the ${name} payment form would appear here. Nothing is charged.</p>
      ${p.status === 'pending'
        ? html`<form method="post" action="/sandbox/pay/${p.id}">
            <button name="result" value="paid">Simulate successful payment</button>
            <button name="result" value="failed">Simulate declined payment</button>
          </form>`
        : html`<p>Status: ${p.status}. <a href="/wallet">Back to wallet</a></p>`}`,
    );
  });

  app.post('/sandbox/pay/:id', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const p = await getPurchase(ctx, Number((req.params as any).id));
    if (!p || p.user_id !== req.user.id || !p.test) return reply.code(404).send('Not found');
    const result = await completePurchase(ctx, p.id, field(req.body, 'result') === 'paid');
    const b = await balance(ctx.db, 'wallet', req.user.id);
    ctx.hub.toUser(req.user.id, { type: 'balance', balance: b });
    return result.status === 'paid'
      ? go(reply, '/wallet', 'ok', `${p.tokens} tokens added (simulated).`)
      : go(reply, '/wallet', 'err', 'The payment was declined (simulated).');
  });

  // ---- Wallet ----
  app.get('/wallet', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const { economy } = await ctx.settings.get();
    const b = await balance(ctx.db, 'wallet', req.user.id);
    const { current, next } = levelFor(economy.levels, req.user.total_spent);
    const purchases = await ctx.db.query(
      'select * from purchases where user_id = $1 order by id desc limit 20',
      [req.user.id],
    );
    const moves = await ctx.db.query(
      `select t.kind, t.memo, t.created_at, e.amount from ledger_entries e
       join ledger_tx t on t.id = e.tx_id join accounts a on a.id = e.account_id
       where a.kind = 'wallet' and a.user_id = $1 order by e.id desc limit 30`,
      [req.user.id],
    );
    return page(
      ctx,
      req,
      reply,
      'Wallet',
      html`<div class="stats">
        <div class="stat"><div class="label">Balance</div><div class="value">${b} <small>tokens</small></div></div>
        <div class="stat"><div class="label">Level</div><div class="value">${current.name}</div>
          <small>${req.user.total_spent} tokens spent${next ? html` · ${next.minSpent - req.user.total_spent} more to reach ${next.name}` : ' · max level'}</small>
          ${next
            ? html`<div class="progress"><span style="width:${Math.min(100, Math.round(((req.user.total_spent - current.minSpent) / Math.max(1, next.minSpent - current.minSpent)) * 100))}%"></span></div>`
            : ''}
        </div>
      </div>
      <h2>Buy tokens</h2>
      <ul class="packages">${economy.packages.map(
        (p) => html`<li class="package">
          <span class="tokens">${p.tokens} <small>tokens</small></span>
          <span class="amount">${money(p.priceCents, economy.currency)}</span>
          <form method="post" action="/wallet/buy">
            <input type="hidden" name="packageId" value="${p.id}">
            <button class="primary">Buy</button>
          </form></li>`,
      )}</ul>
      <h2>Purchases</h2>
      ${purchases.length
        ? html`<table><tr><th>Date</th><th>Tokens</th><th>Price</th><th>Provider</th><th>Status</th></tr>
          ${purchases.map(
            (p: any) => html`<tr><td>${date(p.created_at)}</td><td>${p.tokens}</td><td>${money(p.price_cents, p.currency)}</td>
              <td>${manifest(p.provider)?.name ?? p.provider}${p.test ? ' (test)' : ''}</td><td>${p.status}</td></tr>`,
          )}</table>`
        : html`<p>None yet.</p>`}
      <h2>Transactions</h2>
      ${moves.length
        ? html`<table><tr><th>Date</th><th>Description</th><th>Tokens</th></tr>
          ${moves.map((m: any) => html`<tr><td>${date(m.created_at)}</td><td>${m.memo}</td><td>${m.amount > 0 ? '+' : ''}${m.amount}</td></tr>`)}</table>`
        : html`<p>None yet.</p>`}`,
    );
  });

  app.post('/wallet/buy', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!(await gate(ctx, req, reply))) return;
    const url = await startPurchase(ctx, req.user, field(req.body, 'packageId'), req.country);
    return go(reply, url);
  });

  // ---- Creator room ----
  app.get('/c/:slug', async (req, reply) => {
    if (!needUser(req, reply)) return;
    if (!(await gate(ctx, req, reply))) return;
    const c = await creatorBySlug(ctx.db, (req.params as any).slug);
    if (!c || (c.creator_status !== 'approved' && c.user_id !== req.user.id && !req.user.is_admin)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Room not found');
    }
    if (await isBanned(ctx.db, c.user_id, req.user.id)) return page(ctx, req, reply, c.display_name, html`<p>You can't enter this room.</p>`);
    const isOwner = c.user_id === req.user.id;
    const menu = await ctx.db.query('select id, label, price from tip_menu_items where creator_id = $1 order by position, id', [c.user_id]);
    const following = await ctx.db.one('select 1 from follows where follower_id = $1 and creator_id = $2', [req.user.id, c.user_id]);
    const albums = await publishedAlbums(ctx.db, c.user_id, req.user.id);
    const cam = (await ctx.db.one<{ cam2cam_enabled: boolean; cam2cam_price_per_min: number }>(
      'select cam2cam_enabled, cam2cam_price_per_min from creator_profiles where user_id = $1',
      [c.user_id],
    ))!;
    const nextShow = await ctx.db.one<{ starts_at: Date; title: string }>(
      'select starts_at, title from scheduled_shows where creator_id = $1 and starts_at > now() order by starts_at limit 1',
      [c.user_id],
    );
    const { economy } = await ctx.settings.get();
    return page(
      ctx,
      req,
      reply,
      c.display_name,
      html`<section id="room" class="room" data-creator-id="${c.user_id}" data-me="${req.user.id}" data-owner="${isOwner ? '1' : '0'}">
        <div class="room-main">
          <div class="room-head">
            <h1>${c.display_name}</h1>
            <span class="pill" id="status">loading…</span>
            <span class="pill"><span id="viewers">0</span>&nbsp;watching</span>
          </div>
          ${isOwner ? html`<p>This is your room. To go live, head to <a href="/studio/live">Go live</a>.</p>` : ''}
          <div class="stage">
            <div id="video"><p>The video will appear here when the stream starts.</p></div>
            <div class="fx-layer" id="fx" aria-hidden="true"></div>
            <div id="self-view" class="pip" hidden></div>
          </div>
          ${isOwner ? '' : html`<div class="reactions" id="reactions">${REACTIONS.map((e) => html`<button type="button" data-emoji="${e}" aria-label="React ${e}">${e}</button>`)}</div>`}
          <p class="room-title" id="room-title">${c.room_title}</p>
          <p><button id="hls-toggle" hidden>Light mode (more delay, less data)</button></p>
          <p id="goal"></p>
          <div id="poll" class="panel poll" hidden></div>
          ${isOwner
            ? ''
            : html`<div id="ticket" class="panel ticket" hidden>
              <h2>Ticketed show</h2>
              <p id="ticket-info"></p>
              <button id="ticket-buy" class="primary">Buy ticket</button>
            </div>`}
          ${isOwner
            ? ''
            : html`<div class="panel room-actions"><div class="col">
              <h2>Tips</h2>
              <div class="tip-quick">${[10, 25, 50, 100].map((n) => html`<button class="quick-tip" data-amount="${n}">${n}</button>`)}</div>
              <form id="tip-form">
                <label>Tokens <input type="number" name="amount" min="${economy.tipMin}" value="10" required></label>
                <label>Message <input name="message" maxlength="200" placeholder="Optional"></label>
                <button class="primary">Send tip</button>
              </form>
              ${menu.length
                ? html`<h3>Menu</h3><ul class="menu-list">${menu.map(
                    (m: any) => html`<li><span>${m.label}</span><span><span class="price">${m.price} tk</span> <button class="menu-item" data-item-id="${m.id}">Order</button></span></li>`,
                  )}</ul>`
                : ''}
              </div><div class="col">
              <h2>Private show</h2>
              <p><small>${c.private_enabled ? html`${c.private_price_per_min} tokens per minute, charged at the start of each minute.` : 'Not accepting private shows right now.'}</small></p>
              <p id="private-status"></p>
              <div class="private-actions">
                <button id="private-request" class="primary" ${c.private_enabled ? '' : 'disabled'}>Request private show</button>
                <button id="private-cancel" hidden>Cancel request</button>
                <button id="private-end" class="danger" hidden>End private show</button>
                ${cam.cam2cam_enabled
                  ? html`<button id="cam2cam" hidden data-price="${cam.cam2cam_price_per_min}">📷 Turn on my camera${cam.cam2cam_price_per_min ? ` (+${cam.cam2cam_price_per_min} tk/min)` : ''}</button>`
                  : ''}
              </div>
              ${cam.cam2cam_enabled ? html`<p><small>Cam2cam: in the private show you can turn on your camera. Only ${c.display_name} sees it and it is never recorded.</small></p>` : ''}
              <div id="private-chat-box" hidden>
                <h3>Private chat</h3>
                <ul id="private-chat"></ul>
                <form id="private-chat-form"><input name="text" maxlength="300" autocomplete="off" required placeholder="Private message"> <button>Send</button></form>
              </div>
              </div>
              <p id="action-result" role="status"></p>
            </div>`}
          ${c.bio ? html`<p style="margin-top:20px">${c.bio}</p>` : ''}
          ${nextShow
            ? html`<p class="next-show">📅 Next live show: <time datetime="${new Date(nextShow.starts_at).toISOString()}" data-local>${new Date(nextShow.starts_at).toISOString().slice(0, 16).replace('T', ' ')} UTC</time> · ${nextShow.title}</p>`
            : ''}
          ${albums.length
            ? html`<h2>Albums</h2><ul class="cards albums">${albums.map(
                (a) => html`<li class="card"><a href="/albums/${a.id}">
                  <div class="card-media album-media">${a.cover_file ? html`<img src="/content/cover/${a.id}" alt="" loading="lazy">` : html`<span class="card-initial">▣</span>`}
                    <span class="badge ${a.unlocked ? '' : 'private'}">${a.unlocked ? 'Unlocked' : `${a.price} tokens`}</span></div>
                  <div class="card-body"><div class="card-title"><span>${a.title}</span></div>
                  <div class="card-sub">${a.photos} photos · ${a.videos} videos</div></div></a></li>`,
              )}</ul>`
            : ''}
          ${isOwner
            ? ''
            : html`<div class="room-extra">
              <form method="post" action="/c/${c.slug}/follow"><button class="${following ? '' : 'primary'}">${following ? '♥ Following' : '♡ Follow'}</button></form>
              <a class="button" href="/messages/${c.user_id}">✉ Send message</a>
              <details><summary>Report this room</summary>
                <form method="post" action="/c/${c.slug}/report">
                  <label>Reason <textarea name="reason" required maxlength="1000"></textarea></label><br>
                  <button class="danger">Submit report</button>
                </form>
              </details>
            </div>`}
        </div>

        <aside class="room-side">
          <div class="panel chat-panel">
            <h2>Chat</h2>
            <ul id="chat"></ul>
            <form id="chat-form"><input name="text" maxlength="300" autocomplete="off" required placeholder="Write a message…"> <button>Send</button></form>
          </div>
        </aside>
      </section>`,
      { scripts: ['/static/js/room.js'], hideTitle: true },
    );
  });

  app.post('/c/:slug/follow', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const c = await creatorBySlug(ctx.db, (req.params as any).slug);
    if (!c) return reply.code(404).send('Not found');
    const removed = await ctx.db.query('delete from follows where follower_id = $1 and creator_id = $2 returning 1', [req.user.id, c.user_id]);
    if (!removed.length) await ctx.db.query('insert into follows (follower_id, creator_id) values ($1, $2)', [req.user.id, c.user_id]);
    return go(reply, `/c/${c.slug}`, 'ok', removed.length ? 'You no longer follow them.' : 'You now follow them.');
  });

  app.post('/c/:slug/report', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const c = await creatorBySlug(ctx.db, (req.params as any).slug);
    if (!c) return reply.code(404).send('Not found');
    const reason = field(req.body, 'reason').trim().slice(0, 1000);
    if (!reason) return go(reply, `/c/${c.slug}`, 'err', 'Please explain the reason.');
    await ctx.db.query('insert into reports (reporter_id, creator_id, reason) values ($1, $2, $3)', [req.user.id, c.user_id, reason]);
    return go(reply, `/c/${c.slug}`, 'ok', 'Report submitted. Moderation will review it.');
  });

  app.get('/following', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const rows = await ctx.db.query(
      `select p.slug, u.display_name, p.is_live from follows f
       join creator_profiles p on p.user_id = f.creator_id join users u on u.id = f.creator_id
       where f.follower_id = $1 order by p.is_live desc, u.display_name`,
      [req.user.id],
    );
    return page(
      ctx,
      req,
      reply,
      'Following',
      rows.length
        ? html`<ul>${rows.map((r: any) => html`<li><a href="/c/${r.slug}">${r.display_name}</a> — ${r.is_live ? 'Live now' : 'Offline'}</li>`)}</ul>`
        : html`<p>You are not following anyone yet.</p>`,
    );
  });

  // ---- Creator sign-up ----
  app.get('/become-creator', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const { site } = await ctx.settings.get();
    if (req.user.creator_status !== 'none') return go(reply, '/studio');
    if (site.mode === 'personal') {
      return page(ctx, req, reply, 'Become a creator', html`<p>This is a personal site: only its owner streams.</p>`);
    }
    return page(
      ctx,
      req,
      reply,
      'Become a creator',
      html`<p>To go live you need to:</p>
      <ol><li>Verify your identity and age (ID document and liveness check).</li>
      <li>Have Admin approve your profile.</li></ol>
      <p>Everyone who appears on camera must be verified.</p>
      <form method="post" action="/become-creator"><button>Get started</button></form>`,
    );
  });

  app.post('/become-creator', async (req, reply) => {
    if (!needUser(req, reply)) return;
    const { site } = await ctx.settings.get();
    if (site.mode === 'personal' && !req.user.is_admin) throw new UserError('This is a personal site.');
    if (req.user.creator_status === 'none') {
      await ctx.db.query("update users set creator_status = 'pending_kyc' where id = $1", [req.user.id]);
      await ensureCreatorProfile(ctx.db, req.user);
      await audit(ctx.db, req.user.id, 'creator.apply');
    }
    const url = await startVerification(ctx, { ...req.user, creator_status: 'pending_kyc' }, 'creator_kyc', req.country);
    return go(reply, url);
  });

  // ---- Demo only: simulate the visitor's country ----
  app.post('/demo/country', async (req, reply) => {
    if (!ctx.cfg.demo) return reply.code(404).send('Not found');
    const country = field(req.body, 'country').toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) reply.setCookie(DEMO_COUNTRY_COOKIE, country, { path: '/', sameSite: 'lax', httpOnly: true });
    else reply.clearCookie(DEMO_COUNTRY_COOKIE, { path: '/' });
    return go(reply, field(req.body, 'next') || '/', 'ok', country ? `Simulated country: ${country}` : 'Simulated country removed');
  });
}
