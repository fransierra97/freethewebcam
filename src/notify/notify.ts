/**
 * Notifications: stored on the site (bell), delivered live to open tabs
 * and, if the person enabled it, as a browser notification (Web Push).
 * Push notifications can be discreet: they do not say who or which site they come from.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as webpush from 'web-push';
import type { Ctx } from '../context.ts';

export interface Notice {
  kind: 'live' | 'reminder' | 'dm' | 'raffle' | 'system';
  title: string;
  body?: string;
  url?: string;
}

let vapid: { publicKey: string; privateKey: string } | null = null;

/** VAPID keys: from environment variables, or generated once and saved in the data folder. */
export function vapidKeys(ctx: Ctx): { publicKey: string; privateKey: string } {
  if (vapid) return vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const file = join(ctx.cfg.dataDir, 'vapid.json');
    if (existsSync(file)) vapid = JSON.parse(readFileSync(file, 'utf8'));
    else {
      vapid = webpush.generateVAPIDKeys();
      writeFileSync(file, JSON.stringify(vapid), { mode: 0o600 });
    }
  }
  return vapid!;
}

export async function unreadCounts(ctx: Ctx, userId: number): Promise<{ notifications: number; messages: number }> {
  const n = await ctx.db.one<{ n: number }>('select count(*)::int as n from notifications where user_id = $1 and read_at is null', [userId]);
  const m = await ctx.db.one<{ n: number }>('select count(*)::int as n from dm_messages where recipient_id = $1 and read_at is null', [userId]);
  return { notifications: n?.n ?? 0, messages: m?.n ?? 0 };
}

/** Sends Web Push. Expired subscriptions are deleted. Replaceable in tests. */
export let sendPush = async (ctx: Ctx, sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<void> => {
  const { site, compliance } = await ctx.settings.get();
  const keys = vapidKeys(ctx);
  webpush.setVapidDetails(compliance.contactEmail ? `mailto:${compliance.contactEmail}` : ctx.cfg.publicUrl, keys.publicKey, keys.privateKey);
  void site;
  await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600 });
};

export function setPushSender(fn: typeof sendPush): void {
  sendPush = fn;
}

export async function notify(ctx: Ctx, userId: number, n: Notice): Promise<void> {
  const row = await ctx.db.one<{ id: number }>(
    'insert into notifications (user_id, kind, title, body, url) values ($1, $2, $3, $4, $5) returning id',
    [userId, n.kind, n.title.slice(0, 200), (n.body ?? '').slice(0, 500), n.url ?? '/'],
  );
  ctx.hub.toUser(userId, { type: 'notification', id: row!.id, title: n.title, body: n.body ?? '', url: n.url ?? '/' });
  const subs = await ctx.db.query<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    'select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1',
    [userId],
  );
  if (!subs.length) return;
  const user = await ctx.db.one<{ notify_discreet: boolean }>('select notify_discreet from users where id = $1', [userId]);
  const { site } = await ctx.settings.get();
  const payload = JSON.stringify(
    user?.notify_discreet
      ? { title: 'You have a new notification', body: 'Open the app to see it.', url: '/notifications' }
      : { title: `${site.name}: ${n.title}`, body: n.body ?? '', url: n.url ?? '/' },
  );
  for (const s of subs) {
    try {
      await sendPush(ctx, s, payload);
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) await ctx.db.query('delete from push_subscriptions where id = $1', [s.id]);
    }
  }
}

/** Notifies the creator's followers. */
export async function notifyFollowers(ctx: Ctx, creatorId: number, n: Notice): Promise<number> {
  const rows = await ctx.db.query<{ follower_id: number }>(
    "select f.follower_id from follows f join users u on u.id = f.follower_id where f.creator_id = $1 and u.status = 'active'",
    [creatorId],
  );
  for (const r of rows) await notify(ctx, r.follower_id, n);
  return rows.length;
}

/** Schedule reminders: 15 minutes before each scheduled live show. */
export async function sendReminders(ctx: Ctx): Promise<void> {
  const due = await ctx.db.query<{ id: number; creator_id: number; title: string; slug: string; name: string }>(
    `update scheduled_shows s set reminded = true from creator_profiles p, users u
     where p.user_id = s.creator_id and u.id = s.creator_id and not s.reminded
       and s.starts_at between now() and now() + interval '15 minutes'
     returning s.id, s.creator_id, s.title, p.slug, u.display_name as name`,
  );
  for (const d of due) {
    await notifyFollowers(ctx, d.creator_id, { kind: 'reminder', title: `${d.name} starts soon`, body: d.title, url: `/c/${d.slug}` });
  }
}
