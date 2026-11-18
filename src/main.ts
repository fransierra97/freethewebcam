import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';
import { createContext, openDb, startTimers } from './server.ts';
import { seedDemo } from './demo/seed.ts';

const cfg = loadConfig();
const db = await openDb(cfg);
const ctx = await createContext(cfg, db);
if (cfg.demo) await seedDemo(ctx);
// With a single instance, after a restart we close private shows that were left open.
if (!cfg.redisUrl) {
  await db.query("update private_shows set status = 'ended', end_reason = 'Server restart', ended_at = now() where status = 'active'");
}
const stopTimers = startTimers(ctx);
const app = await buildApp(ctx, { logger: cfg.production });
await app.listen({ port: cfg.port, host: cfg.host });

const { site } = await ctx.settings.get();
console.log(`\nFreeTheWebcam listening on ${cfg.publicUrl}`);
if (!site.setupComplete) console.log(`Setup pending: open ${cfg.publicUrl}/setup?token=${cfg.setupToken}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopTimers();
    ctx.hub.close();
    await app.close();
    await db.close();
    process.exit(0);
  });
}
