/**
 * Control frames from live streams.
 * - The creator's browser sends a frame every N seconds while streaming.
 * - It is stored encrypted and scanned with the active detector (if any).
 * - Hash match: the stream is cut, the creator is suspended and a case is opened.
 * - Classifier suspicion: the stream is cut and an urgent case is opened for human review.
 * - With no incidents, frames are deleted after the configured number of days. With a case, they are kept 1 year
 *   (18 U.S.C. 2258A requires keeping reported material for 1 year).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { audit, UserError } from '../auth/users.ts';
import { currentSession } from '../compliance/records.ts';
import { activePrivate, creatorById } from '../live/actions.ts';
import { endLive } from '../live/lifecycle.ts';
import { decryptBuffer, encryptBuffer } from '../providers/secrets.ts';
import { MODERATION_ORDER, MODERATION_SCANNERS, type ScanResult } from '../providers/adapters/moderation.ts';

const PURPOSE = 'moderation-frame';
export const MAX_FRAME_BYTES = 1_000_000;

function framesDir(ctx: Ctx): string {
  const dir = join(ctx.cfg.dataDir, 'frames');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function isJpeg(data: Buffer): boolean {
  return data.length > 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

export async function storeFrame(ctx: Ctx, creatorId: number, data: Buffer): Promise<number> {
  if (!isJpeg(data)) throw new UserError('The frame must be a JPEG.');
  if (data.length > MAX_FRAME_BYTES) throw new UserError('Frame too large.');
  const creator = await creatorById(ctx.db, creatorId);
  if (!creator?.is_live) throw new UserError('You are not live.');
  const session = await currentSession(ctx.db, creatorId);
  const priv = await activePrivate(ctx.db, creatorId);
  const name = `${creatorId}-${Date.now()}-${randomBytes(6).toString('hex')}.jpg.bin`;
  writeFileSync(join(framesDir(ctx), name), encryptBuffer(ctx.cfg.appSecret, data, PURPOSE), { mode: 0o600 });
  const row = await ctx.db.one<{ id: number }>(
    'insert into moderation_frames (creator_id, session_id, private_show_id, file, bytes) values ($1, $2, $3, $4, $5) returning id',
    [creatorId, session?.id ?? null, priv?.id ?? null, name, data.length],
  );
  return row!.id;
}

export function readFrame(ctx: Ctx, file: string): Buffer {
  return decryptBuffer(ctx.cfg.appSecret, readFileSync(join(framesDir(ctx), file)), PURPOSE);
}

/** Scans a frame with the first active detector. In test mode, the simulated detector finds nothing. */
export async function scanFrame(ctx: Ctx, frameId: number): Promise<ScanResult & { scanner: string | null }> {
  const frame = await ctx.db.one<{ id: number; file: string; creator_id: number }>('select id, file, creator_id from moderation_frames where id = $1', [frameId]);
  if (!frame?.file) throw new Error('Frame not found');
  const provider = await ctx.providers.pick(MODERATION_ORDER, 'moderation');
  if (!provider) {
    await ctx.db.query("update moderation_frames set scan_status = 'skipped' where id = $1", [frameId]);
    return { verdict: 'clear', detail: 'no active detector', scanner: null };
  }
  let result: ScanResult;
  try {
    result =
      provider.mode === 'test'
        ? { verdict: 'clear', detail: 'simulated detector (test mode)' }
        : await MODERATION_SCANNERS[provider.manifest.id].scan(await ctx.providers.env(provider.manifest.id), readFrame(ctx, frame.file));
  } catch (err) {
    await ctx.db.query("update moderation_frames set scan_status = 'error', scanner = $2, scan_detail = $3 where id = $1", [
      frameId,
      provider.manifest.id,
      (err as Error).message.slice(0, 500),
    ]);
    return { verdict: 'clear', detail: 'detector error', scanner: provider.manifest.id };
  }
  await ctx.db.query('update moderation_frames set scan_status = $2, scanner = $3, scan_detail = $4 where id = $1', [
    frameId,
    result.verdict,
    provider.manifest.id,
    result.detail.slice(0, 1000),
  ]);
  if (result.verdict !== 'clear') await raiseIncident(ctx, frame.creator_id, frameId, result.verdict === 'match' ? 'hash_match' : 'classifier', result.detail);
  return { ...result, scanner: provider.manifest.id };
}

/** Scans any image with the active detector, without storing anything. */
export async function scanImage(ctx: Ctx, data: Buffer, mime: string): Promise<ScanResult & { scanner: string | null }> {
  const provider = await ctx.providers.pick(MODERATION_ORDER, 'moderation');
  if (!provider) return { verdict: 'clear', detail: 'no active detector', scanner: null };
  if (provider.mode === 'test') return { verdict: 'clear', detail: 'simulated detector (test mode)', scanner: provider.manifest.id };
  const result = await MODERATION_SCANNERS[provider.manifest.id].scan(await ctx.providers.env(provider.manifest.id), data, mime);
  return { ...result, scanner: provider.manifest.id };
}

/** Opens a case: cuts the stream and, if it is a confirmed match, suspends the creator. */
export async function raiseIncident(
  ctx: Ctx,
  creatorId: number,
  frameId: number | null,
  kind: 'hash_match' | 'classifier' | 'manual',
  detail: string,
  actorId: number | null = null,
  albumItemId: number | null = null,
): Promise<number> {
  const row = await ctx.db.one<{ id: number }>(
    'insert into moderation_incidents (creator_id, frame_id, kind, detail, album_item_id) values ($1, $2, $3, $4, $5) returning id',
    [creatorId, frameId, kind, detail.slice(0, 1000), albumItemId],
  );
  // Keep the evidence: all frames from that session, for 1 year.
  await ctx.db.query(
    `update moderation_frames set retain_until = now() + interval '1 year'
     where creator_id = $1 and (id = $2 or session_id = (select session_id from moderation_frames where id = $2))`,
    [creatorId, frameId],
  );
  await endLive(ctx, creatorId, 'Cut by moderation');
  if (kind !== 'classifier') {
    await ctx.db.query("update users set creator_status = 'suspended' where id = $1", [creatorId]);
  }
  await audit(ctx.db, actorId, `moderation.incident.${kind}`, { incidentId: row!.id, creatorId, frameId });
  return row!.id;
}

/** Deletes expired frames that are not retained by a case. */
export async function cleanupFrames(ctx: Ctx): Promise<number> {
  const { compliance } = await ctx.settings.get();
  const old = await ctx.db.query<{ id: number; file: string }>(
    `select id, file from moderation_frames
     where file is not null and created_at < now() - make_interval(days => $1)
       and (retain_until is null or retain_until < now())`,
    [compliance.frameRetentionDays],
  );
  for (const f of old) {
    rmSync(join(framesDir(ctx), f.file), { force: true });
    await ctx.db.query('update moderation_frames set file = null where id = $1', [f.id]);
  }
  return old.length;
}
