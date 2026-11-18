/**
 * Performer records (18 U.S.C. 2257 and 28 CFR Part 75) and broadcast sessions.
 * Reference: https://www.ecfr.gov/current/title-28/chapter-I/part-75 — this is not legal advice.
 *
 * - Per performer: legal name, date of birth, all aliases, details and a copy of the ID document.
 * - Per broadcast: date and who appears (and the recording, if enabled).
 * - Personal data is encrypted in the database; the document copy is encrypted on disk.
 * - Kept for 7 years after the last modification (§ 75.4): never deleted from the application.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import type { Queryable } from '../db/index.ts';
import { audit, UserError, type User } from '../auth/users.ts';
import { newToken, sha256 } from '../auth/password.ts';
import { decryptBuffer, decryptJson, encryptBuffer, encryptJson } from '../providers/secrets.ts';

export const CONSENT_VERSION = '2026-11-v1';
export const CONSENT_TEXT = [
  'I declare that I am at least 18 years old and that the details and document I provide are true.',
  'I take part in this room\'s broadcasts voluntarily and can stop at any time.',
  'I authorize these details and the copy of my document to be stored to meet legal record-keeping obligations, for as long as the law requires.',
  'I understand that parts of the broadcasts may be recorded for compliance and moderation purposes.',
];

const PII_PURPOSE = 'records-pii';
const FILE_PURPOSE = 'records-file';
const ALLOWED_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const MAX_ID_COPY_BYTES = 10 * 1024 * 1024;

export interface PerformerPii {
  legalName: string;
  dateOfBirth: string; // YYYY-MM-DD
  aliases: string[];
  idType: string;
  idNumber: string;
  idIssuer: string;
  idExpiry: string;
}

export interface PerformerRecord {
  id: number;
  owner_id: number;
  user_id: number | null;
  kind: 'primary' | 'co_performer';
  stage_name: string;
  pii_enc: string | null;
  id_copy_file: string | null;
  consent_version: string | null;
  consent_signed_at: Date | null;
  status: 'pending' | 'submitted' | 'verified' | 'rejected' | 'removed';
  review_note: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function recordsDir(ctx: Ctx): string {
  const dir = join(ctx.cfg.dataDir, 'records');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ageOn(dateOfBirth: string, on = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const m = on.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

export function validatePii(p: PerformerPii): string | null {
  if (p.legalName.trim().length < 3) return 'Enter your full legal name.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth) || Number.isNaN(Date.parse(p.dateOfBirth))) return 'Invalid date of birth.';
  if (ageOn(p.dateOfBirth) < 18) return 'You must be at least 18 years old.';
  if (!p.idType.trim() || p.idNumber.trim().length < 3 || !p.idIssuer.trim()) return 'Complete the document details.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.idExpiry)) return 'Invalid document expiry date.';
  if (Date.parse(p.idExpiry) < Date.now()) return 'The document has expired.';
  return null;
}

export async function getRecord(q: Queryable, id: number): Promise<PerformerRecord | undefined> {
  return q.one('select * from performer_records where id = $1', [id]);
}

export async function primaryRecord(q: Queryable, ownerId: number): Promise<PerformerRecord | undefined> {
  return q.one("select * from performer_records where owner_id = $1 and kind = 'primary'", [ownerId]);
}

export async function ensurePrimaryRecord(q: Queryable, user: User, stageName: string): Promise<PerformerRecord> {
  const existing = await primaryRecord(q, user.id);
  if (existing) return existing;
  return (await q.one<PerformerRecord>(
    "insert into performer_records (owner_id, user_id, kind, stage_name) values ($1, $1, 'primary', $2) returning *",
    [user.id, stageName],
  ))!;
}

export function readPii(ctx: Ctx, r: PerformerRecord): PerformerPii | null {
  return r.pii_enc ? decryptJson<PerformerPii>(ctx.cfg.appSecret, r.pii_enc, PII_PURPOSE) : null;
}

export function readIdCopy(ctx: Ctx, r: PerformerRecord): { data: Buffer; type: string } | null {
  if (!r.id_copy_file) return null;
  const [name, type] = r.id_copy_file.split('|');
  return { data: decryptBuffer(ctx.cfg.appSecret, readFileSync(join(recordsDir(ctx), name)), FILE_PURPOSE), type };
}

/** The performer submits (or corrects) their details, the document copy and the consent. */
export async function submitRecord(
  ctx: Ctx,
  record: PerformerRecord,
  actor: User,
  input: { pii: PerformerPii; idCopy?: { data: Buffer; mimetype: string }; consent: boolean },
): Promise<void> {
  if (record.user_id !== actor.id) throw new UserError('This record is not yours.');
  if (record.status === 'verified' || record.status === 'removed') throw new UserError('This record is already closed. Ask the admin to reopen it.');
  const error = validatePii(input.pii);
  if (error) throw new UserError(error);
  if (!input.consent) throw new UserError('You must accept the declaration and consent.');
  let file = record.id_copy_file;
  if (input.idCopy && input.idCopy.data.length) {
    const ext = ALLOWED_TYPES[input.idCopy.mimetype];
    if (!ext) throw new UserError('The document copy must be JPG, PNG, WEBP or PDF.');
    if (input.idCopy.data.length > MAX_ID_COPY_BYTES) throw new UserError('The document copy is too large (max. 10 MB).');
    const name = `${record.id}-${randomBytes(8).toString('hex')}.${ext}.bin`;
    writeFileSync(join(recordsDir(ctx), name), encryptBuffer(ctx.cfg.appSecret, input.idCopy.data, FILE_PURPOSE), { mode: 0o600 });
    file = `${name}|${input.idCopy.mimetype}`;
  }
  if (!file) throw new UserError('Attach a copy of your ID document.');
  const pii = { ...input.pii, aliases: [...new Set([record.stage_name, ...input.pii.aliases].map((a) => a.trim()).filter(Boolean))] };
  await ctx.db.query(
    `update performer_records set pii_enc = $2, id_copy_file = $3, consent_version = $4, consent_signed_at = now(),
       status = 'submitted', review_note = null, updated_at = now() where id = $1`,
    [record.id, encryptJson(ctx.cfg.appSecret, pii, PII_PURPOSE), file, CONSENT_VERSION],
  );
  await audit(ctx.db, actor.id, 'record.submit', { recordId: record.id });
}

/** Invitation for a co-performer: returns the (single-use) link. */
export async function inviteCoPerformer(ctx: Ctx, owner: User, stageName: string): Promise<string> {
  const name = stageName.trim().slice(0, 60);
  if (name.length < 2) throw new UserError('Enter the person\'s stage name.');
  const token = newToken();
  const r = await ctx.db.one<{ id: number }>(
    "insert into performer_records (owner_id, kind, stage_name, invite_token_hash) values ($1, 'co_performer', $2, $3) returning id",
    [owner.id, name, sha256(token)],
  );
  await audit(ctx.db, owner.id, 'record.invite', { recordId: r!.id });
  return `${ctx.cfg.publicUrl}/performer/invite/${token}`;
}

export async function claimInvite(ctx: Ctx, token: string, user: User): Promise<PerformerRecord> {
  const r = await ctx.db.one<PerformerRecord>('select * from performer_records where invite_token_hash = $1', [sha256(token)]);
  if (!r) throw new UserError('Invalid or already used invitation.');
  if (r.owner_id === user.id) throw new UserError('You cannot accept your own invitation: open it with the other person\'s account.');
  await ctx.db.query('update performer_records set user_id = $2, invite_token_hash = null, updated_at = now() where id = $1', [r.id, user.id]);
  await audit(ctx.db, user.id, 'record.claim', { recordId: r.id });
  return (await getRecord(ctx.db, r.id))!;
}

/** Review by Admin: checks the details, the document and the identity verification. */
export async function reviewRecord(ctx: Ctx, recordId: number, reviewer: User, approve: boolean, note: string): Promise<void> {
  const r = await getRecord(ctx.db, recordId);
  if (!r) throw new UserError('Record not found.');
  if (approve) {
    if (r.status !== 'submitted') throw new UserError('Only a submitted record can be approved.');
    const kyc = r.user_id
      ? await ctx.db.one("select 1 from verifications where user_id = $1 and purpose = 'creator_kyc' and status = 'approved'", [r.user_id])
      : undefined;
    if (!kyc) throw new UserError('That person does not have an approved identity verification yet.');
  }
  await ctx.db.query(
    'update performer_records set status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now() where id = $1',
    [recordId, approve ? 'verified' : 'rejected', note.slice(0, 500) || null, reviewer.id],
  );
  await audit(ctx.db, reviewer.id, approve ? 'record.verify' : 'record.reject', { recordId });
}

export async function verifiedPerformers(q: Queryable, ownerId: number): Promise<PerformerRecord[]> {
  return q.query("select * from performer_records where owner_id = $1 and status = 'verified' order by kind, stage_name", [ownerId]);
}

/** Opens a broadcast session with the people appearing on camera. */
export async function openSession(ctx: Ctx, creator: User, title: string, coPerformerIds: number[]): Promise<number> {
  const { compliance } = await ctx.settings.get();
  return ctx.db.tx(async (q) => {
    await q.query('update broadcast_sessions set ended_at = now() where creator_id = $1 and ended_at is null', [creator.id]);
    const s = await q.one<{ id: number }>('insert into broadcast_sessions (creator_id, title) values ($1, $2) returning id', [creator.id, title]);
    const primary = await primaryRecord(q, creator.id);
    const ids = new Set<number>();
    if (primary && (primary.status === 'verified' || !compliance.require2257)) ids.add(primary.id);
    for (const id of coPerformerIds) {
      const r = await getRecord(q, id);
      if (!r || r.owner_id !== creator.id || r.kind !== 'co_performer') throw new UserError('Invalid co-performer.');
      if (r.status !== 'verified') throw new UserError(`${r.stage_name} does not have a verified record yet: they cannot appear on camera.`);
      ids.add(r.id);
    }
    for (const id of ids) await q.query('insert into broadcast_performers (session_id, record_id) values ($1, $2)', [s!.id, id]);
    return s!.id;
  });
}

export async function closeSession(q: Queryable, creatorId: number): Promise<void> {
  await q.query('update broadcast_sessions set ended_at = now() where creator_id = $1 and ended_at is null', [creatorId]);
}

export async function currentSession(q: Queryable, creatorId: number): Promise<{ id: number } | undefined> {
  return q.one('select id from broadcast_sessions where creator_id = $1 and ended_at is null order by id desc limit 1', [creatorId]);
}

function csv(value: unknown): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Index for the custodian of records: one row per performer and alias, with their broadcasts.
 * Sorted alphabetically by legal name and cross-referenced to each alias (§ 75.2(a)(3)).
 */
export async function exportIndex(ctx: Ctx): Promise<string> {
  const records = await ctx.db.query<PerformerRecord & { owner: string }>(
    `select r.*, u.display_name as owner from performer_records r join users u on u.id = r.owner_id
     where r.pii_enc is not null order by r.id`,
  );
  const rows: string[][] = [];
  for (const r of records) {
    const pii = readPii(ctx, r)!;
    const sessions = await ctx.db.query<{ id: number; started_at: Date; title: string }>(
      `select s.id, s.started_at, s.title from broadcast_performers bp join broadcast_sessions s on s.id = bp.session_id
       where bp.record_id = $1 order by s.started_at`,
      [r.id],
    );
    const works = sessions.map((s) => `#${s.id} ${new Date(s.started_at).toISOString().slice(0, 10)} ${s.title}`).join(' | ');
    for (const name of [pii.legalName, ...pii.aliases]) {
      rows.push([
        name,
        pii.legalName,
        pii.aliases.join('; '),
        pii.dateOfBirth,
        `${pii.idType} ${pii.idNumber} (${pii.idIssuer}, expires ${pii.idExpiry})`,
        `R-${r.id}`,
        r.status,
        r.owner,
        works,
      ]);
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0], 'en'));
  const header = ['Name (legal or alias)', 'Legal name', 'Aliases', 'Date of birth', 'Document', 'Record', 'Status', 'Room', 'Broadcasts'];
  return [header, ...rows].map((r) => r.map(csv).join(',')).join('\n') + '\n';
}
