/**
 * One-command local demo: starts LiveKit in dev mode and the platform with sample data.
 * Requires `livekit-server` on the PATH (macOS: brew install livekit).
 */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, openSync } from 'node:fs';

const root = join(import.meta.dirname, '..');
const hasLivekit = spawnSync('livekit-server', ['--version']).status === 0;
if (!hasLivekit) {
  console.error('Cannot find livekit-server. Install it (macOS: brew install livekit) or set LIVEKIT_URL.');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR ?? join(root, 'data/demo');
mkdirSync(dataDir, { recursive: true });
const livekitLog = openSync(join(dataDir, 'livekit.log'), 'a');
// Listens only on this machine: the development keys (devkey/secret) are public.
const livekit = spawn('livekit-server', ['--dev', '--bind', '127.0.0.1'], { stdio: ['ignore', livekitLog, livekitLog] });
const app = spawn(process.execPath, [join(root, 'src/main.ts')], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, DEMO: '1', DATA_DIR: dataDir, LIVEKIT_URL: 'ws://localhost:7880', HOST: process.env.HOST ?? '127.0.0.1' },
});
console.log(`LiveKit at ws://localhost:7880 (log at ${join(dataDir, 'livekit.log')})`);

const stop = () => {
  app.kill('SIGTERM');
  livekit.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.on('exit', (code) => {
  livekit.kill('SIGTERM');
  process.exit(code ?? 0);
});
