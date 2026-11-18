/** Chat moderation for each room: moderators, mutes, slow mode, followers-only and banned words. */
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.ts';
import type { Queryable } from '../db/index.ts';
import { audit, UserError, type User } from '../auth/users.ts';

export const REACTIONS = ['❤️', '🔥', '😍', '😂', '👏', '💋'];

export interface ChatSettings {
  chat_slow_seconds: number;
  chat_followers_only: boolean;
  chat_banned_words: string;
}

export function messageId(): string {
  return `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

export async function chatSettings(q: Queryable, creatorId: number): Promise<ChatSettings> {
  return (
    (await q.one<ChatSettings>(
      'select chat_slow_seconds, chat_followers_only, chat_banned_words from creator_profiles where user_id = $1',
      [creatorId],
    )) ?? { chat_slow_seconds: 0, chat_followers_only: false, chat_banned_words: '' }
  );
}

export async function isModerator(q: Queryable, creatorId: number, userId: number): Promise<boolean> {
  return Boolean(await q.one('select 1 from room_moderators where creator_id = $1 and user_id = $2', [creatorId, userId]));
}

/** Creator, admin or a moderator appointed by the creator. */
export async function canModerate(q: Queryable, creatorId: number, user: Pick<User, 'id' | 'is_admin'>): Promise<boolean> {
  return user.id === creatorId || user.is_admin || (await isModerator(q, creatorId, user.id));
}

export function bannedWords(list: string): string[] {
  return list
    .split(/[,\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2);
}

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function containsBanned(text: string, list: string[]): boolean {
  const t = normalize(text);
  return list.some((w) => t.includes(normalize(w)));
}

/**
 * Checks whether someone can write now. Moderators have no limits.
 * Returns the reason if they cannot.
 */
export async function chatBlockReason(
  ctx: Ctx,
  creatorId: number,
  user: Pick<User, 'id' | 'is_admin'>,
  text: string,
  lastChatAt: number,
): Promise<string | null> {
  if (await canModerate(ctx.db, creatorId, user)) return null;
  const mute = await ctx.db.one<{ until: Date }>('select until from room_mutes where creator_id = $1 and user_id = $2 and until > now()', [creatorId, user.id]);
  if (mute) {
    const minutes = Math.max(1, Math.ceil((new Date(mute.until).getTime() - Date.now()) / 60000));
    return `You are muted in this room for ${minutes} more min.`;
  }
  const s = await chatSettings(ctx.db, creatorId);
  if (s.chat_followers_only) {
    const follows = await ctx.db.one('select 1 from follows where follower_id = $1 and creator_id = $2', [user.id, creatorId]);
    if (!follows) return 'Only followers of the room can write right now.';
  }
  if (s.chat_slow_seconds && Date.now() - lastChatAt < s.chat_slow_seconds * 1000) {
    return `Slow mode: one message every ${s.chat_slow_seconds} s.`;
  }
  if (containsBanned(text, bannedWords(s.chat_banned_words))) return 'Your message contains words that are not allowed in this room.';
  return null;
}

export async function muteUser(ctx: Ctx, creatorId: number, actor: User, userId: number, minutes: number): Promise<void> {
  if (userId === creatorId) throw new UserError('You cannot mute the creator.');
  if (!(minutes >= 1 && minutes <= 24 * 60)) throw new UserError('Invalid duration.');
  await ctx.db.query(
    `insert into room_mutes (creator_id, user_id, until) values ($1, $2, now() + make_interval(mins => $3))
     on conflict (creator_id, user_id) do update set until = excluded.until`,
    [creatorId, userId, minutes],
  );
  await audit(ctx.db, actor.id, 'chat.mute', { creatorId, userId, minutes });
  ctx.hub.toUser(userId, { type: 'system', creatorId, text: `You have been muted for ${minutes} min in this room.` });
}

export async function setModerator(ctx: Ctx, creator: User, displayName: string, add: boolean): Promise<void> {
  const target = await ctx.db.one<{ id: number }>('select id from users where lower(display_name) = lower($1)', [displayName.trim()]);
  if (!target) throw new UserError('No user with that name exists.');
  if (target.id === creator.id) throw new UserError('You already moderate your own room.');
  if (add) await ctx.db.query('insert into room_moderators (creator_id, user_id) values ($1, $2) on conflict do nothing', [creator.id, target.id]);
  else await ctx.db.query('delete from room_moderators where creator_id = $1 and user_id = $2', [creator.id, target.id]);
  await audit(ctx.db, creator.id, add ? 'chat.add_moderator' : 'chat.remove_moderator', { userId: target.id });
}
