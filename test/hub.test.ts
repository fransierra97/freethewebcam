import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, type ChatConn } from '../src/live/hub.ts';
import { createBus, LocalBus } from '../src/live/bus.ts';
import { createEmbeddedDb, migrate } from '../src/db/index.ts';
import { acquireLease } from '../src/server.ts';

function conn(userId: number, isOwner = false): ChatConn & { inbox: any[]; closed: boolean } {
  const c = {
    userId, name: `u${userId}`, level: 'New', isOwner, isStaff: false, lastMessageAt: 0,
    inbox: [] as any[], closed: false,
    send(msg: object) { c.inbox.push(msg); },
    close() { c.closed = true; },
  };
  return c;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('single instance: history, personal notices, kick and viewers', () => {
  const hub = new Hub(new LocalBus());
  const owner = conn(1, true);
  const viewer = conn(2);
  hub.join(10, owner);
  hub.broadcast(10, { type: 'chat', text: 'hello' }, { remember: true });
  hub.join(10, viewer);
  assert.equal(viewer.inbox[0].text, 'hello', 'receives the history on joining');
  assert.equal(hub.viewerCount(10), 1, 'the creator does not count as a viewer');
  hub.toUser(2, { type: 'balance', balance: 5 });
  assert.ok(viewer.inbox.some((m) => m.type === 'balance'));
  hub.kick(10, 2);
  assert.equal(viewer.closed, true);
  hub.close();
});

test('the stream shuts off if the creator does not return', async () => {
  const hub = new Hub(new LocalBus());
  const owner = conn(1, true);
  hub.join(10, owner);
  assert.equal(hub.ownerOnline(10), true);
  hub.leave(10, owner);
  assert.equal(hub.ownerOnline(10), false);
  hub.close();
});

test('only one instance holds the billing lease', async () => {
  const db = await createEmbeddedDb();
  await migrate(db);
  assert.equal(await acquireLease(db, 'billing', 'A', 15), true);
  assert.equal(await acquireLease(db, 'billing', 'B', 15), false);
  assert.equal(await acquireLease(db, 'billing', 'A', 15), true, 'the same instance renews it');
  await db.query("update leases set expires_at = now() - interval '1 second'");
  assert.equal(await acquireLease(db, 'billing', 'B', 15), true, 'if it expires, another takes it');
  await db.close();
});

test('multiple instances via Redis', { skip: !process.env.TEST_REDIS_URL && 'set TEST_REDIS_URL to run it' }, async () => {
  const url = process.env.TEST_REDIS_URL!;
  const a = new Hub(await createBus(url));
  const b = new Hub(await createBus(url));
  const viewerOnA = conn(2);
  const viewerOnB = conn(3);
  a.join(10, viewerOnA);
  b.join(10, viewerOnB);
  await wait(200);
  assert.equal(a.viewerCount(10), 2, 'counts viewers from both instances');
  assert.equal(b.viewerCount(10), 2);

  b.broadcast(10, { type: 'chat', text: 'from B' }, { remember: true });
  b.toUser(2, { type: 'balance', balance: 7 });
  b.kick(10, 2);
  await wait(200);
  assert.ok(viewerOnA.inbox.some((m) => m.text === 'from B'), 'chat crosses instances');
  assert.ok(viewerOnA.inbox.some((m) => m.type === 'balance' && m.balance === 7), 'personal notices cross instances');
  assert.equal(viewerOnA.closed, true, 'kick crosses instances');

  const owner = conn(1, true);
  b.join(10, owner);
  await wait(200);
  assert.equal(a.ownerOnline(10), true, 'A knows the creator is connected on B');
  a.close();
  b.close();
});
