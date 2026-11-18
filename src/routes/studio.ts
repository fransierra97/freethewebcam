import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';
import { needCreator } from '../web/guards.ts';
import { canBroadcast, hasApprovedKyc } from '../access.ts';
import { audit, UserError } from '../auth/users.ts';
import { creatorById, pushState } from '../live/actions.ts';
import { balance, holdPayout } from '../ledger/ledger.ts';
import { manifest } from '../providers/registry.ts';
import { date, html, money } from '../web/html.ts';
import { field, go, intField, page } from '../web/respond.ts';
import { CREATOR_LABEL } from './public.ts';
import { chatSettings, setModerator } from '../live/chatmod.ts';
import { primaryRecord, verifiedPerformers } from '../compliance/records.ts';

const STATUS_LABEL: Record<string, string> = {
  pending: 'not submitted',
  submitted: 'submitted, pending review',
  verified: 'verified',
  rejected: 'rejected',
  removed: 'removed',
};

const studioNav = html`<nav class="tabs" aria-label="Studio">
  <a href="/studio">Overview</a><a href="/studio/live">Go live</a><a href="/studio/settings">Settings</a>
  <a href="/studio/goal-menu">Goal &amp; menu</a><a href="/studio/chat">Chat</a><a href="/studio/schedule">Schedule</a><a href="/studio/albums">Albums</a><a href="/studio/earnings">Earnings</a><a href="/studio/privates">Private shows</a>
  <a href="/studio/bans">Banned</a><a href="/studio/records">Legal records</a><a href="/studio/obs">OBS</a></nav>`;

export async function studioRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/studio', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const u = req.user;
    const profile = await creatorById(ctx.db, u.id);
    const kyc = await ctx.db.one(
      "select provider, status, test, created_at from verifications where user_id = $1 and purpose = 'creator_kyc' order by id desc limit 1",
      [u.id],
    );
    const kycOk = await hasApprovedKyc(ctx.db, u.id);
    const can = await canBroadcast(ctx, u);
    const record = await primaryRecord(ctx.db, u.id);
    const { economy } = await ctx.settings.get();
    const earned = await balance(ctx.db, 'earnings', u.id);
    const today = await ctx.db.one<{ total: number }>(
      `select coalesce(sum(e.amount), 0)::int as total from ledger_entries e join ledger_tx t on t.id = e.tx_id
       join accounts a on a.id = e.account_id where a.kind = 'earnings' and a.user_id = $1 and e.amount > 0
       and t.created_at >= date_trunc('day', now())`,
      [u.id],
    );
    const followers = await ctx.db.one<{ n: number }>('select count(*)::int as n from follows where creator_id = $1', [u.id]);
    const privates = await ctx.db.one<{ n: number }>(
      "select count(*)::int as n from private_shows where creator_id = $1 and status = 'ended'",
      [u.id],
    );
    return page(
      ctx,
      req,
      reply,
      'Studio',
      html`${studioNav}
      <h2>Status</h2>
      <ul>
        <li>Creator profile: <strong>${CREATOR_LABEL[u.creator_status]}</strong></li>
        <li>Identity and age verification: <strong>${kycOk ? 'approved' : kyc ? kyc.status : 'not started'}</strong>
          ${kyc ? html` (${manifest(kyc.provider)?.name ?? kyc.provider}${kyc.test ? ', test' : ''})` : ''}</li>
        <li>Legal performer record: <strong>${record ? STATUS_LABEL[record.status] : 'not started'}</strong> (<a href="/studio/records">open</a>)</li>
        <li>You can go live: <strong>${can.ok ? 'yes' : `no — ${can.reason}`}</strong></li>
        <li>Live now: ${profile?.is_live ? 'yes' : 'no'}</li>
      </ul>
      ${!kycOk
        ? html`<form method="post" action="/verify/start"><input type="hidden" name="purpose" value="creator_kyc">
            <button>Verify my identity</button></form>`
        : ''}
      ${can.ok ? html`<p><a href="/studio/live"><strong>Go live</strong></a> · <a href="/c/${profile?.slug}">View my room</a></p>` : ''}
      <h2>Numbers</h2>
      <ul>
        <li>Available earnings: ${earned} tokens (${money(earned * economy.tokenValueCents, economy.currency)})</li>
        <li>Earned today: ${today?.total ?? 0} tokens</li>
        <li>Followers: ${followers?.n ?? 0}</li>
        <li>Completed private shows: ${privates?.n ?? 0}</li>
        <li>Your share of each token spent: ${economy.creatorSharePct}%</li>
      </ul>`,
    );
  });

  app.get('/studio/live', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const can = await canBroadcast(ctx, req.user);
    if (!can.ok) return go(reply, '/studio', 'err', can.reason);
    const profile = (await creatorById(ctx.db, req.user.id))!;
    const co = (await verifiedPerformers(ctx.db, req.user.id)).filter((r) => r.kind === 'co_performer');
    const obs = await ctx.db.one<{ ingress_id: string | null }>('select ingress_id from creator_profiles where user_id = $1', [req.user.id]);
    const obsReady = ctx.cfg.ingressEnabled && Boolean(obs?.ingress_id);
    return page(
      ctx,
      req,
      reply,
      'Go live',
      html`${studioNav}
      <section id="studio" class="room" data-creator-id="${req.user.id}" data-slug="${profile.slug}" data-name="${req.user.display_name}" data-frame-interval="${(await ctx.settings.get()).compliance.frameIntervalSeconds}">
        <div class="room-main">
          <div class="room-head">
            <span class="pill" id="status">loading…</span>
            <span class="pill"><span id="viewers">0</span>&nbsp;watching</span>
            <small>Your room: <a href="/c/${profile.slug}" target="_blank">/c/${profile.slug}</a></small>
          </div>
          <div class="stage">
            <div id="preview"><p>Your camera will appear here.</p></div>
            <div class="fx-layer" id="fx" aria-hidden="true"></div>
          </div>
          <p id="goal"></p>
          <div id="poll" class="panel poll" hidden></div>
          <p class="private-actions" style="margin-top:16px">
            <button id="go-live" class="primary">Go live</button>
            ${ctx.cfg.demo ? html`<button id="go-live-test">Start with test pattern (no camera)</button>` : ''}
            <button id="stop-live" hidden>End stream</button>
          </p>
          <section class="panel live-stats" id="stats" hidden>
            <h2>This stream</h2>
            <div class="stats">
              <div class="stat"><div class="label">Earned</div><div class="value" id="st-earned">0</div><small id="st-money"></small></div>
              <div class="stat"><div class="label">Duration</div><div class="value" id="st-duration">0:00</div></div>
              <div class="stat"><div class="label">Viewers</div><div class="value" id="st-viewers">0</div><small id="st-peak"></small></div>
              <div class="stat"><div class="label">New followers</div><div class="value" id="st-followers">0</div></div>
            </div>
            <h3>Top fans today</h3>
            <ol id="st-fans"></ol>
            <p><small id="st-kinds"></small></p>
          </section>

          <section class="panel tools" id="tools" hidden>
            <h2>Live tools</h2>
            <div class="tool-grid">
              <form id="poll-form">
                <h3>Poll</h3>
                <label>Question <input name="question" maxlength="140" required></label>
                <label>Options (one per line, 2 to 5) <textarea name="options" rows="3" required></textarea></label>
                <label>Tokens per vote (0 = free, one vote per person) <input type="number" name="votePrice" min="0" value="0"></label>
                <label>Minutes <input type="number" name="minutes" min="1" max="60" value="3"></label>
                <button class="primary">Start poll</button> <button type="button" id="poll-close">Close poll</button>
              </form>
              <form id="raffle-form">
                <h3>Free giveaway</h3>
                <label>Prize <input name="prize" maxlength="120" required placeholder="E.g. personalized shout-out"></label>
                <label>Among <select name="audience"><option value="present">everyone in the room</option><option value="followers">only followers who are present</option></select></label>
                <p><small>Entering is free: you can't require payment (it would be a lottery).</small></p>
                <button class="primary">Draw now</button>
              </form>
              <form id="ticket-form">
                <h3>Ticketed show</h3>
                <p id="ticket-state"><small>No show set up.</small></p>
                <label>Title <input name="title" maxlength="120"></label>
                <label>Ticket price (tokens) <input type="number" name="price" min="1" value="100"></label>
                <button class="primary" id="ticket-create">Put tickets on sale</button>
                <button type="button" id="ticket-start" hidden>Start the show</button>
                <button type="button" id="ticket-end" hidden>End the show</button>
                <button type="button" id="ticket-cancel" class="danger" hidden>Cancel and refund</button>
              </form>
            </div>
          </section>

          <fieldset id="mode"><legend>Where you stream from</legend>
            <label><input type="radio" name="mode" value="browser" checked> Browser camera</label>
            <label><input type="radio" name="mode" value="obs" ${obsReady ? '' : 'disabled'}> OBS or other software</label>
            ${obsReady ? '' : html` <small>(<a href="/studio/obs">set up OBS</a>)</small>`}
          </fieldset>
          <fieldset id="performers"><legend>Who appears on camera in this stream?</legend>
            <p><small>You always do. Check each verified co-performer who will appear; anyone not on the list can't appear.
              <a href="/studio/records">Manage co-performers</a></small></p>
            ${co.length
              ? co.map((r) => html`<label><input type="checkbox" name="performer" value="${r.id}"> ${r.stage_name}</label><br>`)
              : html`<p><small>You have no verified co-performers.</small></p>`}
          </fieldset>
        </div>

        <aside class="room-side">
          <div class="panel">
            <h2>Private shows</h2>
            <ul id="private-requests"></ul>
            <div id="private-active" hidden>
              <p>In a private show with <strong id="private-with"></strong> · <span id="private-minutes">0</span> min <span id="private-cam" class="pill" hidden>📷 cam2cam</span></p>
              <div id="viewer-cam" class="pip-inline" hidden></div>
              <button id="private-end" class="danger">End private show</button>
              <ul id="private-chat"></ul>
              <form id="private-chat-form"><input name="text" maxlength="300" autocomplete="off" required placeholder="Private message"> <button>Send</button></form>
            </div>
          </div>
          <div class="panel chat-panel">
            <h2>Public chat</h2>
            <p><small>“Ban” next to a message removes that person from your room.</small></p>
            <ul id="chat"></ul>
            <form id="chat-form"><input name="text" maxlength="300" autocomplete="off" required placeholder="Write a message…"> <button>Send</button></form>
          </div>
        </aside>
      </section>`,
      { scripts: ['/static/js/studio.js'] },
    );
  });

  app.get('/studio/settings', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const p = (await creatorById(ctx.db, req.user.id))!;
    const extra = (await ctx.db.one<{ cam2cam_enabled: boolean; cam2cam_price_per_min: number; dm_price: number }>(
      'select cam2cam_enabled, cam2cam_price_per_min, dm_price from creator_profiles where user_id = $1',
      [req.user.id],
    ))!;
    return page(
      ctx,
      req,
      reply,
      'Room settings',
      html`${studioNav}
      <form method="post" action="/studio/settings">
        <fieldset><legend>Room</legend>
          <label>Stream title <input name="room_title" maxlength="120" value="${p.room_title}"></label><br>
          <label>Bio <textarea name="bio" maxlength="1000">${p.bio}</textarea></label>
        </fieldset>
        <fieldset><legend>Private shows</legend>
          <label><input type="checkbox" name="private_enabled" value="1" ${p.private_enabled ? 'checked' : ''}> I accept private shows</label><br>
          <label>Private show price (tokens per minute) <input type="number" name="private_price_per_min" min="1" max="10000" value="${p.private_price_per_min}"></label><br>
          <label><input type="checkbox" name="cam2cam_enabled" value="1" ${extra.cam2cam_enabled ? 'checked' : ''}> Allow cam2cam: the viewer can turn on their camera so only you see them (never recorded)</label><br>
          <label>Cam2cam extra (tokens per minute, 0 = included) <input type="number" name="cam2cam_price_per_min" min="0" max="10000" value="${extra.cam2cam_price_per_min}"></label>
        </fieldset>
        <fieldset><legend>Direct messages</legend>
          <label>Price per incoming message (tokens, 0 = free) <input type="number" name="dm_price" min="0" max="10000" value="${extra.dm_price}"></label>
        </fieldset>
        <button class="primary">Save</button>
      </form>`,
    );
  });

  app.post('/studio/settings', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const b = req.body;
    const price = intField(b, 'private_price_per_min');
    if (!(price >= 1 && price <= 10000)) throw new UserError('Invalid price.');
    const cam2camPrice = intField(b, 'cam2cam_price_per_min');
    const dmPrice = intField(b, 'dm_price');
    if (!(cam2camPrice >= 0 && cam2camPrice <= 10000) || !(dmPrice >= 0 && dmPrice <= 10000)) throw new UserError('Invalid price.');
    await ctx.db.query(
      `update creator_profiles set room_title = $2, bio = $3, private_enabled = $4, private_price_per_min = $5,
         cam2cam_enabled = $6, cam2cam_price_per_min = $7, dm_price = $8 where user_id = $1`,
      [
        req.user.id,
        field(b, 'room_title').slice(0, 120),
        field(b, 'bio').slice(0, 1000),
        field(b, 'private_enabled') === '1',
        price,
        field(b, 'cam2cam_enabled') === '1',
        cam2camPrice,
        dmPrice,
      ],
    );
    await pushState(ctx, req.user.id);
    return go(reply, '/studio/settings', 'ok', 'Saved.');
  });

  // ---- Chat moderation ----
  app.get('/studio/chat', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const s = await chatSettings(ctx.db, req.user.id);
    const mods = await ctx.db.query<{ display_name: string }>(
      'select u.display_name from room_moderators m join users u on u.id = m.user_id where m.creator_id = $1 order by u.display_name',
      [req.user.id],
    );
    const mutes = await ctx.db.query<{ user_id: number; display_name: string; until: Date }>(
      'select m.user_id, u.display_name, m.until from room_mutes m join users u on u.id = m.user_id where m.creator_id = $1 and m.until > now()',
      [req.user.id],
    );
    return page(
      ctx,
      req,
      reply,
      'Room chat',
      html`${studioNav}
      <form method="post" action="/studio/chat">
        <fieldset><legend>Rules</legend>
          <label>Slow mode: seconds between each person's messages (0 = no limit) <input type="number" name="slow" min="0" max="600" value="${s.chat_slow_seconds}"></label><br>
          <label><input type="checkbox" name="followers_only" value="1" ${s.chat_followers_only ? 'checked' : ''}> Only people who follow the room can chat</label><br>
          <label>Banned words (separated by commas or lines) <textarea name="banned" rows="4">${s.chat_banned_words}</textarea></label>
        </fieldset>
        <button class="primary">Save</button>
      </form>
      <h2>Moderators</h2>
      <p><small>They can mute, ban and delete messages in your room. They can't see your money or settings.</small></p>
      ${mods.length ? html`<ul>${mods.map((m) => html`<li>${m.display_name}
          <form method="post" action="/studio/chat/mods" class="inline"><input type="hidden" name="name" value="${m.display_name}"><input type="hidden" name="remove" value="1"><button class="linklike">Remove</button></form></li>`)}</ul>`
        : html`<p>None.</p>`}
      <form method="post" action="/studio/chat/mods" class="inline-form">
        <label>Public name <input name="name" required></label>
        <button>Make moderator</button>
      </form>
      <h2>Currently muted</h2>
      ${mutes.length
        ? html`<ul>${mutes.map((m) => html`<li>${m.display_name} until ${new Date(m.until).toLocaleTimeString('en')}
            <form method="post" action="/studio/chat/unmute" class="inline"><input type="hidden" name="userId" value="${m.user_id}"><button class="linklike">Unmute</button></form></li>`)}</ul>`
        : html`<p>No one.</p>`}`,
    );
  });

  app.post('/studio/chat', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const slow = intField(req.body, 'slow');
    if (!(slow >= 0 && slow <= 600)) throw new UserError('Slow mode must be between 0 and 600 seconds.');
    await ctx.db.query(
      'update creator_profiles set chat_slow_seconds = $2, chat_followers_only = $3, chat_banned_words = $4 where user_id = $1',
      [req.user.id, slow, field(req.body, 'followers_only') === '1', field(req.body, 'banned').slice(0, 5000)],
    );
    return go(reply, '/studio/chat', 'ok', 'Saved.');
  });

  app.post('/studio/chat/mods', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    await setModerator(ctx, req.user, field(req.body, 'name'), field(req.body, 'remove') !== '1');
    return go(reply, '/studio/chat', 'ok', 'Moderators updated.');
  });

  app.post('/studio/chat/unmute', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    await ctx.db.query('delete from room_mutes where creator_id = $1 and user_id = $2', [req.user.id, intField(req.body, 'userId')]);
    return go(reply, '/studio/chat', 'ok', 'Unmuted.');
  });

  app.get('/studio/goal-menu', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const p = (await creatorById(ctx.db, req.user.id))!;
    const items = await ctx.db.query('select id, label, price from tip_menu_items where creator_id = $1 order by position, id', [req.user.id]);
    return page(
      ctx,
      req,
      reply,
      'Goal & menu',
      html`${studioNav}
      <h2>Goal</h2>
      ${p.goal_tokens ? html`<p>Current: ${p.goal_label} — ${p.goal_progress}/${p.goal_tokens} tokens</p>` : html`<p>No goal.</p>`}
      <form method="post" action="/studio/goal">
        <label>Description <input name="goal_label" maxlength="120" value="${p.goal_label ?? ''}"></label>
        <label>Tokens <input type="number" name="goal_tokens" min="1" value="${p.goal_tokens ?? ''}"></label>
        <label><input type="checkbox" name="reset" value="1" checked> Start from zero</label>
        <button>Save goal</button>
      </form>
      <form method="post" action="/studio/goal"><input type="hidden" name="clear" value="1"><button>Remove goal</button></form>
      <h2>Tip menu</h2>
      <ul>${items.map(
        (i: any) => html`<li>${i.label} — ${i.price} tokens
          <form method="post" action="/studio/menu/delete" style="display:inline"><input type="hidden" name="id" value="${i.id}"><button>Remove</button></form></li>`,
      )}</ul>
      <form method="post" action="/studio/menu">
        <label>Action <input name="label" maxlength="80" required></label>
        <label>Price <input type="number" name="price" min="1" required></label>
        <button>Add</button>
      </form>`,
    );
  });

  app.post('/studio/goal', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const b = req.body;
    if (field(b, 'clear') === '1') {
      await ctx.db.query('update creator_profiles set goal_label = null, goal_tokens = null, goal_progress = 0 where user_id = $1', [req.user.id]);
    } else {
      const tokens = intField(b, 'goal_tokens');
      if (!(tokens > 0)) throw new UserError('Enter a number of tokens.');
      await ctx.db.query(
        `update creator_profiles set goal_label = $2, goal_tokens = $3,
           goal_progress = case when $4 then 0 else goal_progress end where user_id = $1`,
        [req.user.id, field(b, 'goal_label').slice(0, 120) || 'Goal', tokens, field(b, 'reset') === '1'],
      );
    }
    await pushState(ctx, req.user.id);
    return go(reply, '/studio/goal-menu', 'ok', 'Goal updated.');
  });

  app.post('/studio/menu', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const label = field(req.body, 'label').trim().slice(0, 80);
    const price = intField(req.body, 'price');
    if (!label || !(price > 0)) throw new UserError('Enter a name and a price.');
    await ctx.db.query(
      'insert into tip_menu_items (creator_id, label, price, position) values ($1, $2, $3, (select count(*) from tip_menu_items where creator_id = $1))',
      [req.user.id, label, price],
    );
    return go(reply, '/studio/goal-menu', 'ok', 'Added to the menu.');
  });

  app.post('/studio/menu/delete', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    await ctx.db.query('delete from tip_menu_items where id = $1 and creator_id = $2', [intField(req.body, 'id'), req.user.id]);
    return go(reply, '/studio/goal-menu', 'ok', 'Removed.');
  });

  app.get('/studio/earnings', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const { economy } = await ctx.settings.get();
    const earned = await balance(ctx.db, 'earnings', req.user.id);
    const moves = await ctx.db.query(
      `select t.kind, t.memo, t.created_at, e.amount from ledger_entries e join ledger_tx t on t.id = e.tx_id
       join accounts a on a.id = e.account_id where a.kind = 'earnings' and a.user_id = $1 order by e.id desc limit 50`,
      [req.user.id],
    );
    const payouts = await ctx.db.query('select * from payouts where creator_id = $1 order by id desc', [req.user.id]);
    return page(
      ctx,
      req,
      reply,
      'Earnings',
      html`${studioNav}
      <p>Available: <strong>${earned} tokens</strong> = ${money(earned * economy.tokenValueCents, economy.currency)}
        (${money(economy.tokenValueCents, economy.currency)} per token).</p>
      <form method="post" action="/studio/payouts">
        <label>Tokens to cash out <input type="number" name="tokens" min="${economy.payoutMinTokens}" max="${Math.max(earned, economy.payoutMinTokens)}" value="${earned}"></label>
        <button ${earned < economy.payoutMinTokens ? 'disabled' : ''}>Request payout</button>
        <small>Minimum ${economy.payoutMinTokens} tokens. Payouts are simulated: Admin marks them as paid.</small>
      </form>
      <h2>Payout requests</h2>
      ${payouts.length
        ? html`<table><tr><th>Date</th><th>Tokens</th><th>Amount</th><th>Status</th></tr>
          ${payouts.map((p: any) => html`<tr><td>${date(p.created_at)}</td><td>${p.tokens}</td><td>${money(p.amount_cents, p.currency)}</td><td>${p.status}</td></tr>`)}</table>`
        : html`<p>None.</p>`}
      <h2>Transactions</h2>
      ${moves.length
        ? html`<table><tr><th>Date</th><th>Description</th><th>Tokens</th></tr>
          ${moves.map((m: any) => html`<tr><td>${date(m.created_at)}</td><td>${m.memo}</td><td>${m.amount > 0 ? '+' : ''}${m.amount}</td></tr>`)}</table>`
        : html`<p>None yet.</p>`}`,
    );
  });

  app.post('/studio/payouts', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const { economy } = await ctx.settings.get();
    const tokens = intField(req.body, 'tokens');
    if (!(tokens >= economy.payoutMinTokens)) throw new UserError(`The minimum is ${economy.payoutMinTokens} tokens.`);
    await ctx.db.tx(async (q) => {
      const p = await q.one<{ id: number }>(
        'insert into payouts (creator_id, tokens, amount_cents, currency) values ($1, $2, $3, $4) returning id',
        [req.user.id, tokens, tokens * economy.tokenValueCents, economy.currency],
      );
      await holdPayout(q, req.user.id, tokens, p!.id);
      await audit(q, req.user.id, 'payout.request', { payoutId: p!.id, tokens });
    });
    return go(reply, '/studio/earnings', 'ok', 'Request submitted.');
  });

  app.get('/studio/privates', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const rows = await ctx.db.query(
      `select s.*, u.display_name as viewer from private_shows s join users u on u.id = s.viewer_id
       where s.creator_id = $1 order by s.id desc limit 100`,
      [req.user.id],
    );
    return page(
      ctx,
      req,
      reply,
      'Private shows',
      html`${studioNav}
      ${rows.length
        ? html`<table><tr><th>Date</th><th>Viewer</th><th>Status</th><th>Minutes</th><th>Tokens</th><th>Ended</th></tr>
          ${rows.map(
            (r: any) => html`<tr><td>${date(r.created_at)}</td><td>${r.viewer}</td><td>${r.status}</td><td>${r.minutes_billed}</td>
              <td>${r.tokens_billed}</td><td>${r.end_reason ?? ''}</td></tr>`,
          )}</table>`
        : html`<p>None yet.</p>`}`,
    );
  });

  app.get('/studio/bans', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    const rows = await ctx.db.query(
      'select b.user_id, u.display_name, b.created_at from room_bans b join users u on u.id = b.user_id where b.creator_id = $1 order by b.created_at desc',
      [req.user.id],
    );
    return page(
      ctx,
      req,
      reply,
      'Banned',
      html`${studioNav}
      ${rows.length
        ? html`<ul>${rows.map(
            (r: any) => html`<li>${r.display_name} (${date(r.created_at)})
              <form method="post" action="/studio/bans/remove" style="display:inline"><input type="hidden" name="userId" value="${r.user_id}"><button>Unban</button></form></li>`,
          )}</ul>`
        : html`<p>No one.</p>`}`,
    );
  });

  app.post('/studio/bans/remove', async (req, reply) => {
    if (!needCreator(req, reply)) return;
    await ctx.db.query('delete from room_bans where creator_id = $1 and user_id = $2', [req.user.id, intField(req.body, 'userId')]);
    return go(reply, '/studio/bans', 'ok', 'Unbanned.');
  });
}
