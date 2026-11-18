import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';
import { createEmbeddedDb, createPgDb, migrate, type Db } from './db/index.ts';
import { Hub } from './live/hub.ts';
import { createBus } from './live/bus.ts';
import { createMediaServices } from './live/media.ts';
import type { Queryable } from './db/index.ts';
import { billPrivates } from './live/privates.ts';
import { endLive } from './live/lifecycle.ts';
import { cleanupFrames } from './moderation/frames.ts';
import { closeExpiredPolls } from './live/engage.ts';
import { sendReminders } from './notify/notify.ts';
import { ProviderService } from './providers/service.ts';
import { SettingsStore } from './settings.ts';

export async function openDb(cfg: Config, opts: { memory?: boolean } = {}): Promise<Db> {
  if (cfg.databaseUrl) return createPgDb(cfg.databaseUrl);
  return createEmbeddedDb(opts.memory ? undefined : join(cfg.dataDir, 'pgdata'));
}

export async function createContext(cfg: Config, db: Db): Promise<Ctx> {
  await migrate(db);
  const ctx: Ctx = {
    cfg,
    db,
    settings: new SettingsStore(db),
    providers: new ProviderService(db, cfg.appSecret, cfg.publicUrl),
    hub: new Hub(await createBus(cfg.redisUrl)),
    media: createMediaServices(cfg),
  };
  // If the creator closes the tab without ending, the live stream shuts down on its own.
  ctx.hub.onOwnerGone = (creatorId) => {
    void (async () => {
      await endLive(ctx, creatorId, 'The creator disconnected');
    })().catch((err) => console.error('onOwnerGone', err));
  };
  return ctx;
}

/** Takes (or renews) a named lock. Returns true if this instance holds it. */
export async function acquireLease(q: Queryable, name: string, holder: string, seconds: number): Promise<boolean> {
  const row = await q.one(
    `insert into leases (name, holder, expires_at) values ($1, $2, now() + make_interval(secs => $3))
     on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at
       where leases.expires_at < now() or leases.holder = excluded.holder
     returning holder`,
    [name, holder, seconds],
  );
  return row?.holder === holder;
}

export function startTimers(ctx: Ctx): () => void {
  const billing = setInterval(() => {
    acquireLease(ctx.db, 'billing', ctx.hub.instance, 15)
      .then(async (mine) => {
        if (!mine) return;
        await billPrivates(ctx);
        await closeExpiredPolls(ctx);
        await sendReminders(ctx);
      })
      .catch((err) => console.error('billPrivates', err));
  }, 5_000);
  // When the first instance starts nobody is connected: nobody is still “live”.
  // With several instances (Redis) leave it alone: the others may have live streams in progress.
  if (!ctx.cfg.redisUrl) {
    void ctx.db.query('update creator_profiles set is_live = false where is_live');
    void ctx.db.query('update broadcast_sessions set ended_at = now() where ended_at is null');
  }
  const cleanup = setInterval(() => {
    acquireLease(ctx.db, 'cleanup', ctx.hub.instance, 3000)
      .then((mine) => (mine ? cleanupFrames(ctx) : undefined))
      .catch((err) => console.error('cleanupFrames', err));
  }, 60 * 60 * 1000);
  cleanup.unref();
  return () => {
    clearInterval(billing);
    clearInterval(cleanup);
  };
}
