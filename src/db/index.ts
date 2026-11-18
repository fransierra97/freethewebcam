import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

function wrap(run: (sql: string, params?: unknown[]) => Promise<any[]>): Queryable {
  return {
    query: run,
    async one(sql, params) {
      const rows = await run(sql, params);
      return rows[0];
    },
  };
}

export function createPgDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const base = wrap(async (sql, params) => (await pool.query(sql, params as any[])).rows);
  return {
    ...base,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(wrap(async (sql, params) => (await client.query(sql, params as any[])).rows));
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

/** Embedded Postgres (WASM) for the demo and tests: no database server needed. */
export async function createEmbeddedDb(dataDir?: string): Promise<Db> {
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  // PGlite uses a single connection: we serialize so transactions do not interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const base = wrap((sql, params) => serial(async () => (await lite.query(sql, params as any[])).rows as any[]));
  return {
    ...base,
    tx(fn) {
      return serial(() =>
        lite.transaction(async (t) => fn(wrap(async (sql, params) => (await t.query(sql, params as any[])).rows as any[]))),
      );
    },
    async exec(sql) {
      await serial(() => lite.exec(sql));
    },
    close: () => lite.close(),
  };
}

export async function migrate(db: Db): Promise<void> {
  await db.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = join(import.meta.dirname, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const done = await db.one('select 1 from schema_migrations where name = $1', [file]);
    if (done) continue;
    await db.exec(`begin;\n${readFileSync(join(dir, file), 'utf8')}\ninsert into schema_migrations (name) values ('${file}');\ncommit;`);
  }
}
