import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Ctx } from '../src/context.ts';
import { createEmbeddedDb, createPgDb } from '../src/db/index.ts';
import { createContext } from '../src/server.ts';

import { getUser } from '../src/auth/users.ts';
import { ensurePrimaryRecord, reviewRecord, submitRecord } from '../src/compliance/records.ts';

export const HOST = 'test.local';

/** Completes and verifies a creator's 2257 record (test data). */
export async function verifyRecord(ctx: Ctx, userId: number): Promise<number> {
  const user = (await getUser(ctx.db, userId))!;
  const admin = (await ctx.db.one('select id from users where is_admin order by id limit 1'))!;
  const r = await ensurePrimaryRecord(ctx.db, user, user.display_name);
  await submitRecord(ctx, r, user, {
    pii: { legalName: 'Test Legal Name', dateOfBirth: '1990-05-05', aliases: [], idType: 'Passport', idNumber: 'X1234567', idIssuer: 'ES', idExpiry: '2034-01-01' },
    idCopy: { data: Buffer.from('%PDF-1.4 test'), mimetype: 'application/pdf' },
    consent: true,
  });
  await reviewRecord(ctx, r.id, (await getUser(ctx.db, admin.id))!, true, '');
  return r.id;
}

export async function makeApp(env: Record<string, string> = {}): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ftw-test-'));
  const cfg = loadConfig({ DATA_DIR: dataDir, SETUP_TOKEN: 'setup-secret', PUBLIC_URL: `http://${HOST}`, ...env });
  // With TEST_DATABASE_URL the tests run against a real PostgreSQL server (network protocol, pg driver).
  const url = process.env.TEST_DATABASE_URL;
  const db = url ? createPgDb(url) : await createEmbeddedDb();
  if (url) await db.exec('drop schema public cascade; create schema public;');
  const ctx = await createContext(cfg, db);
  const app = await buildApp(ctx);
  return { app, ctx };
}

/** Test client that keeps cookies like a browser. */
export class Browser {
  cookies = new Map<string, string>();
  app: FastifyInstance;
  constructor(app: FastifyInstance) {
    this.app = app;
  }

  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private store(res: any) {
    for (const c of res.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      const expired = c.maxAge === 0 || (c.expires && c.expires.getTime() < Date.now()) || c.value === '';
      if (expired) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
  }

  async get(url: string) {
    const res = await this.app.inject({ method: 'GET', url, headers: { host: HOST, cookie: this.cookieHeader() } });
    this.store(res);
    return res;
  }

  async form(url: string, data: Record<string, string | string[]>, headers: Record<string, string> = {}) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) for (const item of Array.isArray(v) ? v : [v]) body.append(k, item);
    const res = await this.app.inject({
      method: 'POST',
      url,
      payload: body.toString(),
      headers: { host: HOST, origin: `http://${HOST}`, cookie: this.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    this.store(res);
    return res;
  }

  async json(url: string, data: unknown = {}) {
    const res = await this.app.inject({
      method: 'POST',
      url,
      payload: JSON.stringify(data),
      headers: { host: HOST, origin: `http://${HOST}`, cookie: this.cookieHeader(), 'content-type': 'application/json' },
    });
    this.store(res);
    return res;
  }

  async login(email: string, password: string) {
    const res = await this.form('/login', { email, password });
    if (!this.cookies.has('ftw_session')) throw new Error(`login failed for ${email}: ${res.statusCode}`);
  }
}

export const SETUP = {
  token: 'setup-secret',
  siteName: 'Test',
  mode: 'group',
  markets: ['US', 'EU', 'LATAM'],
  email: 'admin@example.com',
  displayName: 'Admin',
  password: 'password123',
  adminIsCreator: '1',
  ageRestricted: '1',
};

/** Decodes the payload part of a JWT (without verifying the signature). */
export function jwtPayload(token: string): any {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}
