import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, jwtPayload, makeApp, SETUP, verifyRecord } from './helpers.ts';
import { balance, unbalancedTransactions } from '../src/ledger/ledger.ts';
import { billPrivates } from '../src/live/privates.ts';
import { chatBlockReason, containsBanned, bannedWords } from '../src/live/chatmod.ts';
import { closeExpiredPolls } from '../src/live/engage.ts';
import type { ChatConn } from '../src/live/hub.ts';
import { sendReminders, setPushSender } from '../src/notify/notify.ts';
import { parseLocal } from '../src/routes/social.ts';

async function setup() {
  const { app, ctx } = await makeApp();
  const admin = new Browser(app);
  await admin.form('/setup', SETUP);
  const reg = async (email: string, name: string, tokens = 0) => {
    const b = new Browser(app);
    await b.form('/register', { email, displayName: name, password: 'password123', adult: '1' });
    const id = (await ctx.db.one('select id from users where email = $1', [email])).id as number;
    await ctx.db.query('update users set age_verified_at = now() where id = $1', [id]);
    if (tokens) await admin.form(`/admin/users/${id}/tokens`, { tokens: String(tokens) });
    return { b, id };
  };
  const luna = await reg('luna@example.com', 'Luna');
  const start = await luna.b.form('/become-creator', {});
  await luna.b.form(String(start.headers.location), { result: 'approve' });
  await admin.form(`/admin/creators/${luna.id}`, { to: 'approved' });
  await verifyRecord(ctx, luna.id);
  const fan = await reg('fan@example.com', 'Fan', 1000);
  const fan2 = await reg('fan2@example.com', 'Other', 1000);
  return { app, ctx, admin, luna, fan, fan2, reg };
}

function fakeConn(userId: number): ChatConn {
  return { userId, name: `u${userId}`, level: '', isOwner: false, isStaff: false, lastMessageAt: 0, send() {}, close() {} };
}

test('chat moderation: mute, followers-only, slow mode, banned words and moderators', async () => {
  const { ctx, luna, fan, fan2 } = await setup();
  const u = (id: number) => ({ id, is_admin: false });
  assert.equal(await chatBlockReason(ctx, luna.id, u(fan.id), 'hello', 0), null);

  // Moderator appointed by the creator.
  await luna.b.form('/studio/chat/mods', { name: 'Other' });
  assert.equal((await fan2.b.json(`/api/rooms/${luna.id}/mod`, { action: 'mute', userId: fan.id, minutes: 5 })).statusCode, 200);
  assert.match((await chatBlockReason(ctx, luna.id, u(fan.id), 'hello', 0))!, /muted/);
  assert.equal((await fan.b.json(`/api/rooms/${luna.id}/mod`, { action: 'mute', userId: fan2.id })).statusCode, 403, 'a viewer cannot moderate');
  await luna.b.form('/studio/chat/unmute', { userId: String(fan.id) });

  await luna.b.form('/studio/chat', { slow: '30', followers_only: '1', banned: 'spam, Scam' });
  assert.match((await chatBlockReason(ctx, luna.id, u(fan.id), 'hello', 0))!, /Only followers/);
  await fan.b.form('/c/luna/follow', {});
  assert.equal(await chatBlockReason(ctx, luna.id, u(fan.id), 'hello', 0), null);
  assert.match((await chatBlockReason(ctx, luna.id, u(fan.id), 'hello', Date.now()))!, /Slow mode/);
  assert.match((await chatBlockReason(ctx, luna.id, u(fan.id), 'this is a SCAM', 0))!, /not allowed/);
  assert.equal(await chatBlockReason(ctx, luna.id, u(fan2.id), 'spam', Date.now()), null, 'moderators have no limits');
  assert.ok(containsBanned('Scám', bannedWords('scam')), 'ignores case and accents');
});

test('live chat over WebSocket: messages with id, reactions and deletion', async () => {
  const { app, luna, fan } = await setup();
  const ws = await (app as any).injectWS(`/ws/room/${luna.id}`, { headers: { cookie: `ftw_session=${fan.b.cookies.get('ftw_session')}` } });
  const inbox: any[] = [];
  ws.on('message', (d: Buffer) => inbox.push(JSON.parse(d.toString())));
  const wait = () => new Promise((r) => setTimeout(r, 150));
  await wait();
  ws.send(JSON.stringify({ type: 'react', emoji: '🔥' }));
  ws.send(JSON.stringify({ type: 'react', emoji: '<script>' }));
  await wait();
  ws.send(JSON.stringify({ type: 'chat', text: 'hello room' }));
  await wait();
  const chat = inbox.find((m) => m.type === 'chat');
  assert.ok(chat?.id, 'every message carries an id');
  assert.equal(inbox.filter((m) => m.type === 'reaction').length, 1, 'only allowed emojis');
  assert.equal((await luna.b.json(`/api/rooms/${luna.id}/mod`, { action: 'delete', messageId: chat.id })).statusCode, 200);
  await wait();
  assert.ok(inbox.some((m) => m.type === 'chat_delete' && m.id === chat.id));
  ws.terminate();
});

test('polls: free once, paid per vote, automatic close', async () => {
  const { ctx, luna, fan, fan2 } = await setup();
  assert.equal((await luna.b.json('/api/poll', { question: 'What should I do?', options: ['Dance', 'Sing'], minutes: 2 })).statusCode, 400, 'live only');
  await luna.b.json('/api/studio/live', { on: true });
  assert.equal((await luna.b.json('/api/poll', { question: 'What should I do?', options: ['Dance', 'Sing'], votePrice: 0, minutes: 2 })).statusCode, 200);
  assert.equal((await fan.b.json('/api/poll/vote', { creatorId: luna.id, option: 1 })).statusCode, 200);
  assert.equal((await fan.b.json('/api/poll/vote', { creatorId: luna.id, option: 0 })).statusCode, 400, 'one free vote per person');
  await luna.b.json('/api/poll/close');
  await luna.b.json('/api/poll', { question: 'Song', options: 'A\nB\nC', votePrice: 5, minutes: 1 });
  const v = await fan2.b.json('/api/poll/vote', { creatorId: luna.id, option: 2, times: 3 });
  assert.equal(v.json().poll.votes[2], 3);
  assert.equal(await balance(ctx.db, 'wallet', fan2.id), 985);
  await ctx.db.query("update polls set ends_at = now() - interval '1 second' where status = 'open'");
  await closeExpiredPolls(ctx);
  assert.equal((await ctx.db.one("select count(*)::int as n from polls where status = 'open'")).n, 0);
  assert.equal(await unbalancedTransactions(ctx.db), 0);
});

test('free raffle among present viewers and followers only', async () => {
  const { ctx, luna, fan, fan2 } = await setup();
  await luna.b.json('/api/studio/live', { on: true });
  assert.equal((await luna.b.json('/api/raffle', { prize: 'Greeting' })).statusCode, 400, 'with nobody present');
  ctx.hub.join(luna.id, fakeConn(fan.id));
  ctx.hub.join(luna.id, fakeConn(fan2.id));
  const r = await luna.b.json('/api/raffle', { prize: 'Greeting', audience: 'present' });
  assert.equal(r.json().entrants, 2);
  assert.ok(['Fan', 'Other'].includes(r.json().winner));
  await fan.b.form('/c/luna/follow', {});
  const f = await luna.b.json('/api/raffle', { prize: 'Another prize', audience: 'followers' });
  assert.equal(f.json().entrants, 1);
  assert.equal(f.json().winner, 'Fan');
});

test('ticketed show: sale, video access, no privates and cancellation with refund', async () => {
  const { ctx, luna, fan, fan2 } = await setup();
  await luna.b.json('/api/studio/live', { on: true });
  assert.equal((await luna.b.json('/api/tickets/create', { title: 'Special show', price: 200 })).statusCode, 200);
  assert.equal((await fan.b.json('/api/tickets/buy', { creatorId: luna.id })).json().balance, 800);
  assert.equal((await fan.b.json('/api/tickets/buy', { creatorId: luna.id })).statusCode, 400, 'one ticket per person');
  assert.equal(await balance(ctx.db, 'earnings', luna.id), 100);
  const start = await luna.b.json('/api/tickets/start');
  const showId = start.json().show.id;
  assert.equal((await fan.b.get(`/api/live/token?ticket=${showId}`)).statusCode, 200);
  assert.equal(jwtPayload((await luna.b.get(`/api/live/token?ticket=${showId}`)).json().token).video.canPublish, true);
  assert.equal((await fan2.b.get(`/api/live/token?ticket=${showId}`)).statusCode, 400, 'no ticket, no video');
  assert.equal((await fan2.b.json('/api/private/request', { creatorId: luna.id })).statusCode, 400, 'no privates during the show');
  const state = (await fan2.b.get(`/api/rooms/${luna.id}/state`)).json();
  assert.equal(state.ticketShow.status, 'live');
  assert.equal(state.ticketShow.sold, 1);
  // Cancelling refunds the tickets.
  assert.equal((await luna.b.json('/api/tickets/cancel')).json().refunded, 1);
  assert.equal(await balance(ctx.db, 'wallet', fan.id), 1000);
  assert.equal(await balance(ctx.db, 'earnings', luna.id), 0);
  assert.equal(await unbalancedTransactions(ctx.db), 0);
});

test('live dashboard: session earnings and top fans', async () => {
  const { luna, fan, fan2 } = await setup();
  await luna.b.json('/api/studio/live', { on: true });
  await fan.b.json('/api/tip', { creatorId: luna.id, amount: 100 });
  await fan2.b.json('/api/tip', { creatorId: luna.id, amount: 40 });
  await fan.b.form('/c/luna/follow', {});
  const s = (await luna.b.get('/api/studio/stats')).json().stats;
  assert.equal(s.earnedTokens, 70);
  assert.deepEqual(s.topFans.map((f: any) => f.name), ['Fan', 'Other']);
  assert.equal(s.byKind.tip.tokens, 140);
  assert.equal(s.newFollowers, 1);
});

test('cam2cam: only with an active private, publishes after enabling and charges the extra', async () => {
  const { ctx, luna, fan } = await setup();
  await luna.b.form('/studio/settings', {
    room_title: 'Room', bio: '', private_enabled: '1', private_price_per_min: '30', cam2cam_enabled: '1', cam2cam_price_per_min: '20', dm_price: '0',
  });
  await luna.b.json('/api/studio/live', { on: true });
  const id = (await fan.b.json('/api/private/request', { creatorId: luna.id })).json().id;
  assert.equal((await fan.b.json(`/api/private/${id}/cam2cam`, { on: true })).statusCode, 400, 'not before it starts');
  await luna.b.json(`/api/private/${id}/accept`);
  assert.equal(jwtPayload((await fan.b.get(`/api/live/token?show=${id}`)).json().token).video.canPublish, false);
  assert.equal((await fan.b.json(`/api/private/${id}/cam2cam`, { on: true })).json().cam2cam, true);
  assert.equal(jwtPayload((await fan.b.get(`/api/live/token?show=${id}`)).json().token).video.canPublish, true);
  const started = new Date((await ctx.db.one('select started_at from private_shows where id = $1', [id])).started_at).getTime();
  await billPrivates(ctx, started + 61_000);
  // Minute 1: 30 (no camera) · minute 2: 30 + 20.
  assert.equal(await balance(ctx.db, 'wallet', fan.id), 1000 - 30 - 50);
  assert.equal((await ctx.db.one('select tokens_billed from private_shows where id = $1', [id])).tokens_billed, 80);
});

test('notices: followers when the stream starts (discreet push) and schedule reminder', async () => {
  const { ctx, luna, fan } = await setup();
  const pushed: string[] = [];
  setPushSender(async (_ctx, _sub, payload) => {
    pushed.push(payload);
  });
  await fan.b.form('/c/luna/follow', {});
  await fan.b.json('/api/push/subscribe', { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } });
  await luna.b.json('/api/studio/live', { on: true });
  await new Promise((r) => setTimeout(r, 100));
  const n = await ctx.db.one("select title, url from notifications where user_id = $1 and kind = 'live'", [fan.id]);
  assert.match(n.title, /Luna is live/);
  assert.equal(n.url, '/c/luna');
  assert.equal(pushed.length, 1);
  assert.doesNotMatch(pushed[0], /Luna/, 'by default the push does not say who');
  assert.match((await fan.b.get('/')).body, /id="unread-notifications"[^>]*>1</);

  // Schedule: set with the browser's local time and reminder 15 minutes before.
  const soon = new Date(Date.now() + 10 * 60_000);
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await luna.b.form('/studio/schedule', { when: local, title: 'Thursday chat', tzOffset: String(soon.getTimezoneOffset()) });
  assert.match((await fan.b.get('/agenda')).body, /Thursday chat/);
  await sendReminders(ctx);
  assert.ok(await ctx.db.one("select 1 from notifications where user_id = $1 and kind = 'reminder'", [fan.id]));
  await sendReminders(ctx);
  assert.equal((await ctx.db.one("select count(*)::int as n from notifications where kind = 'reminder'")).n, 1, 'only one reminder');
});

test('local time: conversion with the browser offset', () => {
  assert.equal(parseLocal('2026-12-01T20:00', -60)!.toISOString(), '2026-12-01T19:00:00.000Z');
  assert.equal(parseLocal('2026-12-01T20:00', 300)!.toISOString(), '2026-12-02T01:00:00.000Z');
  assert.equal(parseLocal('tomorrow', 0), null);
});

test('direct messages: paid to the creator, free reply, limits and report', async () => {
  const { ctx, luna, fan, fan2 } = await setup();
  await luna.b.form('/studio/settings', {
    room_title: 'Room', bio: '', private_enabled: '1', private_price_per_min: '30', cam2cam_enabled: '1', cam2cam_price_per_min: '0', dm_price: '15',
  });
  await fan.b.form(`/messages/${luna.id}`, { body: 'Hi, when is the next stream?' });
  assert.equal(await balance(ctx.db, 'wallet', fan.id), 985);
  await luna.b.form(`/messages/${fan.id}`, { body: 'On Thursday 😊' });
  assert.equal(await balance(ctx.db, 'wallet', luna.id), 0, 'the creator replies for free');
  assert.match((await fan.b.get('/messages')).body, /On Thursday/);
  // Fans cannot message each other.
  await fan.b.form(`/messages/${fan2.id}`, { body: 'hello' });
  assert.equal((await ctx.db.one('select count(*)::int as n from dm_messages where recipient_id = $1', [fan2.id])).n, 0);
  // The creator cannot write to someone who never wrote to them.
  await luna.b.form(`/messages/${fan2.id}`, { body: 'hello' });
  assert.equal((await ctx.db.one('select count(*)::int as n from dm_messages where recipient_id = $1', [fan2.id])).n, 0);
  // Report a received message.
  const m = await ctx.db.one('select id from dm_messages where sender_id = $1', [luna.id]);
  await fan.b.form(`/messages/report/${m.id}`, {});
  assert.ok(await ctx.db.one('select 1 from reports where dm_message_id = $1', [m.id]));
  // Banned from the room: cannot write either.
  await luna.b.json(`/api/rooms/${luna.id}/ban`, { userId: fan.id });
  await fan.b.form(`/messages/${luna.id}`, { body: 'again' });
  assert.equal((await ctx.db.one('select count(*)::int as n from dm_messages where sender_id = $1', [fan.id])).n, 1);
  assert.equal(await unbalancedTransactions(ctx.db), 0);
});
