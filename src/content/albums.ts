/**
 * Private albums: the creator uploads photos and videos, says who appears (verified records),
 * admins review them and fans unlock them with tokens, album by album.
 */
import type { Readable } from 'node:stream';
import type { Ctx } from '../context.ts';
import type { Queryable } from '../db/index.ts';
import { audit, UserError, type User } from '../auth/users.ts';
import { canBroadcast } from '../access.ts';
import { InsufficientFunds, spend } from '../ledger/ledger.ts';
import { pushBalance } from '../live/actions.ts';
import { raiseIncident, scanImage } from '../moderation/frames.ts';
import { ALLOWED, LIMITS, magicMatches, readAll, readHead, removeFile, storeStream } from './store.ts';

export type AlbumStatus = 'draft' | 'pending_review' | 'published' | 'rejected' | 'removed';

export interface Album {
  id: number;
  creator_id: number;
  title: string;
  description: string;
  price: number;
  status: AlbumStatus;
  cover_file: string | null;
  cover_iv: string | null;
  cover_mime: string | null;
  review_note: string | null;
  created_at: Date;
  published_at: Date | null;
}

export interface AlbumItem {
  id: number;
  album_id: number;
  kind: 'image' | 'video';
  file: string;
  iv: string;
  mime: string;
  bytes: number;
  position: number;
  scan_status: string;
}

export const STATUS_LABEL: Record<AlbumStatus, string> = {
  draft: 'Draft',
  pending_review: 'In review',
  published: 'Published',
  rejected: 'Rejected',
  removed: 'Removed',
};

export async function getAlbum(q: Queryable, id: number): Promise<Album | undefined> {
  return q.one('select * from albums where id = $1', [id]);
}

export async function albumItems(q: Queryable, albumId: number): Promise<AlbumItem[]> {
  return q.query('select * from album_items where album_id = $1 order by position, id', [albumId]);
}

export async function isUnlocked(q: Queryable, albumId: number, userId: number): Promise<boolean> {
  return Boolean(await q.one('select 1 from album_unlocks where album_id = $1 and user_id = $2', [albumId, userId]));
}

/** Can they see the full content? The owner, admins, or whoever unlocked it. */
export async function canView(q: Queryable, album: Album, user: Pick<User, 'id' | 'is_admin'>): Promise<boolean> {
  if (album.creator_id === user.id || user.is_admin) return true;
  return isUnlocked(q, album.id, user.id);
}

function editable(album: Album, user: User): void {
  if (album.creator_id !== user.id) throw new UserError('This album is not yours.');
  if (album.status === 'removed') throw new UserError('The album has been removed.');
}

export async function createAlbum(ctx: Ctx, creator: User, title: string, price: number, description: string): Promise<number> {
  const t = title.trim().slice(0, 120);
  if (!t) throw new UserError('Enter a title.');
  if (!(Number.isInteger(price) && price >= 1 && price <= 100000)) throw new UserError('Invalid price.');
  const row = await ctx.db.one<{ id: number }>(
    'insert into albums (creator_id, title, price, description) values ($1, $2, $3, $4) returning id',
    [creator.id, t, price, description.trim().slice(0, 2000)],
  );
  // Whoever creates the album always appears in it.
  const primary = await ctx.db.one<{ id: number }>("select id from performer_records where owner_id = $1 and kind = 'primary'", [creator.id]);
  if (primary) await ctx.db.query('insert into album_performers (album_id, record_id) values ($1, $2)', [row!.id, primary.id]);
  await audit(ctx.db, creator.id, 'album.create', { albumId: row!.id });
  return row!.id;
}

export async function updateAlbum(ctx: Ctx, album: Album, creator: User, input: { title: string; price: number; description: string }) {
  editable(album, creator);
  const t = input.title.trim().slice(0, 120);
  if (!t) throw new UserError('Enter a title.');
  if (!(Number.isInteger(input.price) && input.price >= 1 && input.price <= 100000)) throw new UserError('Invalid price.');
  await ctx.db.query('update albums set title = $2, price = $3, description = $4 where id = $1', [album.id, t, input.price, input.description.trim().slice(0, 2000)]);
  await markChanged(ctx, album);
}

/** Who appears: the creator and any verified co-performers they select. */
export async function setPerformers(ctx: Ctx, album: Album, creator: User, recordIds: number[]): Promise<void> {
  editable(album, creator);
  const valid = await ctx.db.query<{ id: number }>(
    "select id from performer_records where owner_id = $1 and status = 'verified' and id = any($2::int[])",
    [creator.id, recordIds],
  );
  const primary = await ctx.db.one<{ id: number }>("select id from performer_records where owner_id = $1 and kind = 'primary'", [creator.id]);
  await ctx.db.tx(async (q) => {
    await q.query('delete from album_performers where album_id = $1', [album.id]);
    const ids = new Set([...valid.map((v) => v.id), ...(primary ? [primary.id] : [])]);
    for (const id of ids) await q.query('insert into album_performers (album_id, record_id) values ($1, $2)', [album.id, id]);
  });
  await markChanged(ctx, album);
}

/** Editing a published album sends it back to review. */
async function markChanged(ctx: Ctx, album: Album): Promise<void> {
  if (album.status === 'published' || album.status === 'rejected') {
    await ctx.db.query("update albums set status = 'draft' where id = $1", [album.id]);
  }
}

/** Stores an uploaded file (photo or video) encrypted. Photos are scanned with the active detector. */
export async function addItem(ctx: Ctx, album: Album, creator: User, stream: Readable & { truncated?: boolean }, mime: string): Promise<AlbumItem> {
  editable(album, creator);
  const kind = ALLOWED[mime];
  if (!kind) throw new UserError('Unsupported format. Photos: JPG, PNG, WEBP or GIF. Videos: MP4, WEBM or MOV.');
  const count = await ctx.db.one<{ n: number }>('select count(*)::int as n from album_items where album_id = $1', [album.id]);
  if ((count?.n ?? 0) >= LIMITS.itemsPerAlbum) throw new UserError(`An album can hold at most ${LIMITS.itemsPerAlbum} items.`);
  const saved = await storeStream(ctx, stream);
  if (stream.truncated || saved.bytes > LIMITS[kind]) {
    removeFile(ctx, saved.file);
    throw new UserError(kind === 'image' ? 'The photo is too large (max 25 MB).' : 'The video is too large (max 2 GB).');
  }
  if (!saved.bytes || !magicMatches(mime, await readHead(ctx, saved.file, saved.iv))) {
    removeFile(ctx, saved.file);
    throw new UserError('The file does not match its format.');
  }
  const item = (await ctx.db.one<AlbumItem>(
    `insert into album_items (album_id, kind, file, iv, mime, bytes, position, scan_status)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [album.id, kind, saved.file, saved.iv, mime, saved.bytes, count?.n ?? 0, kind === 'video' ? 'manual' : 'pending'],
  ))!;
  await markChanged(ctx, album);
  if (kind === 'image') await scanItem(ctx, album, item);
  return item;
}

async function scanItem(ctx: Ctx, album: Album, item: AlbumItem): Promise<void> {
  try {
    const r = await scanImage(ctx, await readAll(ctx, item.file, item.iv), item.mime);
    await ctx.db.query('update album_items set scan_status = $2 where id = $1', [item.id, r.scanner ? r.verdict : 'skipped']);
    if (r.verdict !== 'clear') {
      await ctx.db.query("update albums set status = 'rejected', review_note = 'Blocked by the automatic detector' where id = $1", [album.id]);
      await raiseIncident(ctx, album.creator_id, null, r.verdict === 'match' ? 'hash_match' : 'classifier', `Album #${album.id}: ${r.detail}`, null, item.id);
    }
  } catch (err) {
    await ctx.db.query("update album_items set scan_status = 'error' where id = $1", [item.id]);
    await audit(ctx.db, null, 'album.scan_failed', { itemId: item.id, error: (err as Error).message });
  }
}

export async function setCover(ctx: Ctx, album: Album, creator: User, stream: Readable & { truncated?: boolean }, mime: string): Promise<void> {
  editable(album, creator);
  if (ALLOWED[mime] !== 'image') throw new UserError('The cover must be an image.');
  const saved = await storeStream(ctx, stream);
  if (stream.truncated || saved.bytes > LIMITS.image || !magicMatches(mime, await readHead(ctx, saved.file, saved.iv))) {
    removeFile(ctx, saved.file);
    throw new UserError('Invalid cover (image up to 25 MB).');
  }
  if (album.cover_file) removeFile(ctx, album.cover_file);
  await ctx.db.query('update albums set cover_file = $2, cover_iv = $3, cover_mime = $4 where id = $1', [album.id, saved.file, saved.iv, mime]);
  await markChanged(ctx, album);
}

export async function deleteItem(ctx: Ctx, album: Album, creator: User, itemId: number): Promise<void> {
  editable(album, creator);
  const item = await ctx.db.one<AlbumItem>('select * from album_items where id = $1 and album_id = $2', [itemId, album.id]);
  if (!item) throw new UserError('Item not found.');
  // If someone already unlocked it or there was a case, the file is kept (records and evidence).
  const keep = (await ctx.db.one('select 1 from album_unlocks where album_id = $1', [album.id])) || item.scan_status === 'match';
  await ctx.db.query('delete from album_items where id = $1', [item.id]).catch(async () => {
    throw new UserError('This item is tied to a moderation case and cannot be deleted.');
  });
  if (!keep) removeFile(ctx, item.file);
  await markChanged(ctx, album);
}

export async function submitForReview(ctx: Ctx, album: Album, creator: User): Promise<void> {
  editable(album, creator);
  if (!['draft', 'rejected'].includes(album.status)) throw new UserError('This album cannot be submitted right now.');
  const can = await canBroadcast(ctx, creator);
  if (!can.ok) throw new UserError(can.reason!);
  const items = await ctx.db.one<{ n: number }>('select count(*)::int as n from album_items where album_id = $1', [album.id]);
  if (!items?.n) throw new UserError('Upload at least one photo or video.');
  const unverified = await ctx.db.one(
    "select 1 from album_performers ap join performer_records r on r.id = ap.record_id where ap.album_id = $1 and r.status <> 'verified'",
    [album.id],
  );
  if (unverified) throw new UserError('Everyone who appears must have a verified record.');
  await ctx.db.query("update albums set status = 'pending_review', review_note = null where id = $1", [album.id]);
  await audit(ctx.db, creator.id, 'album.submit', { albumId: album.id });
}

export async function reviewAlbum(ctx: Ctx, albumId: number, reviewer: User, approve: boolean, note: string): Promise<void> {
  const album = await getAlbum(ctx.db, albumId);
  if (!album || album.status !== 'pending_review') throw new UserError('That album is not pending review.');
  const flagged = await ctx.db.one("select 1 from album_items where album_id = $1 and scan_status in ('match', 'suspect')", [albumId]);
  if (approve && flagged) throw new UserError('The detector flagged items in this album: it cannot be approved.');
  await ctx.db.query(
    `update albums set status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(),
       published_at = case when $2 = 'published' then coalesce(published_at, now()) else published_at end where id = $1`,
    [albumId, approve ? 'published' : 'rejected', note.slice(0, 500) || null, reviewer.id],
  );
  await audit(ctx.db, reviewer.id, approve ? 'album.approve' : 'album.reject', { albumId });
}

export async function unlockAlbum(ctx: Ctx, viewer: User, albumId: number): Promise<number> {
  const album = await getAlbum(ctx.db, albumId);
  if (!album || album.status !== 'published') throw new UserError('This album is not available.');
  if (album.creator_id === viewer.id) throw new UserError('This is your own album.');
  if (await isUnlocked(ctx.db, albumId, viewer.id)) throw new UserError('You already unlocked it.');
  const banned = await ctx.db.one('select 1 from room_bans where creator_id = $1 and user_id = $2', [album.creator_id, viewer.id]);
  if (banned) throw new UserError('You cannot buy content from this creator.');
  const { economy } = await ctx.settings.get();
  try {
    await ctx.db.tx(async (q) => {
      const txId = await spend(q, {
        kind: 'album',
        fromUser: viewer.id,
        toCreator: album.creator_id,
        tokens: album.price,
        creatorSharePct: economy.creatorSharePct,
        memo: `Album: ${album.title}`,
        idempotencyKey: `album:${album.id}:${viewer.id}`,
        meta: { albumId: album.id },
      });
      await q.query('insert into album_unlocks (album_id, user_id, tx_id) values ($1, $2, $3) on conflict do nothing', [album.id, viewer.id, txId]);
    });
  } catch (err) {
    if (err instanceof InsufficientFunds) throw new UserError('You do not have enough tokens.');
    throw err;
  }
  await audit(ctx.db, viewer.id, 'album.unlock', { albumId });
  return pushBalance(ctx, viewer.id);
}

export async function publishedAlbums(q: Queryable, creatorId: number, viewerId: number) {
  return q.query<Album & { photos: number; videos: number; unlocked: boolean }>(
    `select a.*,
       (select count(*)::int from album_items i where i.album_id = a.id and i.kind = 'image') as photos,
       (select count(*)::int from album_items i where i.album_id = a.id and i.kind = 'video') as videos,
       exists(select 1 from album_unlocks u where u.album_id = a.id and u.user_id = $2) as unlocked
     from albums a where a.creator_id = $1 and a.status = 'published' order by a.published_at desc`,
    [creatorId, viewerId],
  );
}
