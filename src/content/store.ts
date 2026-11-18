/**
 * Encrypted storage for album photos and videos.
 * AES-256-CTR with a random IV per file: any byte range can be decrypted
 * so videos can be seeked without decrypting the whole file.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { Ctx } from '../context.ts';

export const LIMITS = {
  image: 25 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024,
  itemsPerAlbum: 60,
};

export const ALLOWED: Record<string, 'image' | 'video'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
};

function key(ctx: Ctx): Buffer {
  return createHash('sha256').update(`ftw-content:${ctx.cfg.appSecret}`).digest();
}

export function contentDir(ctx: Ctx): string {
  const dir = join(ctx.cfg.dataDir, 'content');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** IV for block n: adds n to the initial IV as a 128-bit integer. */
export function ivAt(iv: Buffer, block: bigint): Buffer {
  let value = BigInt(`0x${iv.toString('hex')}`) + block;
  value &= (1n << 128n) - 1n;
  return Buffer.from(value.toString(16).padStart(32, '0'), 'hex');
}

/** Stores a stream encrypted. Returns name, IV and size. */
export async function storeStream(ctx: Ctx, input: Readable): Promise<{ file: string; iv: string; bytes: number }> {
  const iv = randomBytes(16);
  const file = `${randomBytes(12).toString('hex')}.bin`;
  const path = join(contentDir(ctx), file);
  const cipher = createCipheriv('aes-256-ctr', key(ctx), iv);
  try {
    await pipeline(input, cipher, createWriteStream(path, { mode: 0o600 }));
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
  return { file, iv: iv.toString('hex'), bytes: statSync(path).size };
}

/** Reads a decrypted range [start, end] (both inclusive). */
export function readRange(ctx: Ctx, file: string, ivHex: string, start: number, end: number): Readable {
  const iv = Buffer.from(ivHex, 'hex');
  const blockStart = Math.floor(start / 16) * 16;
  const decipher = createDecipheriv('aes-256-ctr', key(ctx), ivAt(iv, BigInt(blockStart / 16)));
  const skip = start - blockStart;
  const source = createReadStream(join(contentDir(ctx), file), { start: blockStart, end });
  let skipped = 0;
  const out = source.pipe(decipher);
  if (!skip) return out;
  // Discard the bytes in the first block that come before “start”.
  return out.pipe(
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (skipped < skip) {
          const cut = Math.min(skip - skipped, chunk.length);
          skipped += cut;
          chunk = chunk.subarray(cut);
        }
        cb(null, chunk);
      },
    }),
  );
}

export async function readAll(ctx: Ctx, file: string, ivHex: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const size = statSync(join(contentDir(ctx), file)).size;
  if (!size) return Buffer.alloc(0);
  for await (const c of readRange(ctx, file, ivHex, 0, size - 1)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function removeFile(ctx: Ctx, file: string): void {
  rmSync(join(contentDir(ctx), file), { force: true });
}

/** Checks that the first bytes match the declared type. */
export function magicMatches(mime: string, head: Buffer): boolean {
  const ascii = (a: number, b: number) => head.subarray(a, b).toString('latin1');
  switch (mime) {
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return ascii(0, 4) === 'GIF8';
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'video/mp4':
    case 'video/quicktime':
      return ascii(4, 8) === 'ftyp';
    case 'video/webm':
      return head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    default:
      return false;
  }
}

export async function readHead(ctx: Ctx, file: string, ivHex: string, n = 16): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of readRange(ctx, file, ivHex, 0, n - 1)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
