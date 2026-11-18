import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl: string;
  redisUrl: string;
  trustProxy: string;
  appSecret: string;
  setupToken: string;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  /** Internal URL of the LiveKit API (from the server). */
  livekitApiUrl: string;
  ingressEnabled: boolean;
  egressEnabled: boolean;
  /** Recordings and HLS folder as seen by the application. */
  mediaDir: string;
  /** The same folder as seen by the egress container. */
  egressOutputDir: string;
  geoHeader: string;
  defaultCountry: string;
  demo: boolean;
  production: boolean;
}

function persistedSecret(dataDir: string, name: string, bytes: number): string {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, name);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const value = randomBytes(bytes).toString('hex');
  writeFileSync(file, value + '\n', { mode: 0o600 });
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const dataDir = resolve(env.DATA_DIR ?? './data');
  const port = Number(env.PORT ?? 3000);
  const appSecret = env.APP_SECRET || persistedSecret(dataDir, 'app-secret', 32);
  if (production && appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters long');
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir,
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? '',
    // Only trust the X-Forwarded-For header if the request comes from here (local proxy or internal network).
    trustProxy: env.TRUST_PROXY ?? 'loopback,uniquelocal',
    appSecret,
    setupToken: env.SETUP_TOKEN || persistedSecret(dataDir, 'setup-token', 12),
    livekitUrl: env.LIVEKIT_URL ?? 'ws://localhost:7880',
    livekitApiKey: env.LIVEKIT_API_KEY ?? 'devkey',
    livekitApiSecret: env.LIVEKIT_API_SECRET ?? 'secret',
    livekitApiUrl: (env.LIVEKIT_API_URL ?? (env.LIVEKIT_URL ?? 'ws://localhost:7880').replace(/^ws/, 'http')).replace(/\/$/, ''),
    ingressEnabled: env.INGRESS_ENABLED === '1',
    egressEnabled: env.EGRESS_ENABLED === '1',
    mediaDir: resolve(env.MEDIA_DIR ?? join(dataDir, 'media')),
    egressOutputDir: (env.EGRESS_OUTPUT_DIR ?? '/out').replace(/\/$/, ''),
    geoHeader: (env.GEO_HEADER ?? 'cf-ipcountry').toLowerCase(),
    defaultCountry: (env.DEFAULT_COUNTRY ?? '').toUpperCase(),
    demo: env.DEMO === '1',
    production,
  };
}
