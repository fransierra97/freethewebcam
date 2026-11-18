/**
 * Runs the tests against a PostgreSQL server over the network (`pg` driver), as in production.
 * Uses PGlite with its protocol server so Docker or an installed Postgres is not needed.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = join(import.meta.dirname, '..');
const port = 54329;
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();

const files = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => join('test', f));
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TEST_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` },
});
child.on('exit', async (code) => {
  await server.stop();
  await db.close();
  process.exit(code ?? 1);
});
