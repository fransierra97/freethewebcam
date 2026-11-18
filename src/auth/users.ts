import type { Queryable } from '../db/index.ts';
import { hashPassword, newToken, sha256 } from './password.ts';

export type CreatorStatus = 'none' | 'pending_kyc' | 'pending_approval' | 'approved' | 'rejected' | 'suspended';

export interface User {
  id: number;
  email: string;
  display_name: string;
  is_admin: boolean;
  creator_status: CreatorStatus;
  status: 'active' | 'banned';
  age_verified_at: Date | null;
  age_self_declared_at: Date | null;
  total_spent: number;
  created_at: Date;
}

const USER_COLS =
  'u.id, u.email, u.display_name, u.is_admin, u.creator_status, u.status, u.age_verified_at, u.age_self_declared_at, u.total_spent, u.created_at';

export const SESSION_COOKIE = 'ftw_session';
const SESSION_DAYS = 30;

export class UserError extends Error {}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateRegistration(email: string, displayName: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Invalid email address.';
  if (!/^[\p{L}\p{N}_.-]{3,24}$/u.test(displayName)) return 'The name must be 3–24 letters, numbers, “_”, “.” or “-”.';
  if (password.length < 8) return 'The password must be at least 8 characters long.';
  return null;
}

export async function createUser(
  q: Queryable,
  input: { email: string; displayName: string; password: string; isAdmin?: boolean },
): Promise<User> {
  const email = normalizeEmail(input.email);
  const error = validateRegistration(email, input.displayName, input.password);
  if (error) throw new UserError(error);
  const taken = await q.one(
    'select 1 from users where email = $1 or lower(display_name) = lower($2)',
    [email, input.displayName],
  );
  if (taken) throw new UserError('That email or name is already in use.');
  const row = await q.one<{ id: number }>(
    'insert into users (email, display_name, password_hash, is_admin) values ($1, $2, $3, $4) returning id',
    [email, input.displayName, await hashPassword(input.password), input.isAdmin ?? false],
  );
  return (await getUser(q, row!.id))!;
}

export async function getUser(q: Queryable, id: number): Promise<User | undefined> {
  return q.one<User>(`select ${USER_COLS} from users u where u.id = $1`, [id]);
}

export async function findUserByEmail(q: Queryable, email: string): Promise<(User & { password_hash: string }) | undefined> {
  return q.one(`select ${USER_COLS}, u.password_hash from users u where u.email = $1`, [normalizeEmail(email)]);
}

export async function createSession(q: Queryable, userId: number): Promise<string> {
  const token = newToken();
  await q.query(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha256(token), userId],
  );
  return token;
}

export async function sessionUser(q: Queryable, token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined;
  return q.one<User>(
    `select ${USER_COLS} from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)],
  );
}

export async function destroySession(q: Queryable, token: string | undefined): Promise<void> {
  if (token) await q.query('delete from sessions where token_hash = $1', [sha256(token)]);
}

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'creator';
}

export async function ensureCreatorProfile(q: Queryable, user: User): Promise<void> {
  const exists = await q.one('select 1 from creator_profiles where user_id = $1', [user.id]);
  if (exists) return;
  let slug = slugify(user.display_name);
  if (await q.one('select 1 from creator_profiles where slug = $1', [slug])) slug = `${slug}-${user.id}`;
  await q.query('insert into creator_profiles (user_id, slug, room_title) values ($1, $2, $3)', [
    user.id,
    slug,
    `${user.display_name}'s live room`,
  ]);
}

export async function audit(q: Queryable, actorId: number | null, action: string, details: Record<string, unknown> = {}) {
  await q.query('insert into audit_log (actor_id, action, details) values ($1, $2, $3)', [
    actorId,
    action,
    JSON.stringify(details),
  ]);
}
