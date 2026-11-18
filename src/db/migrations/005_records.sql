-- Performer records (18 U.S.C. 2257 / 28 CFR 75) and broadcast sessions.
-- Personal data is encrypted (pii_enc) and the ID copy is encrypted on disk.
create table performer_records (
  id serial primary key,
  owner_id integer not null references users(id),          -- creator whose room they appear in
  user_id integer references users(id),                     -- performer's account (the creator or a co-performer)
  kind text not null check (kind in ('primary', 'co_performer')),
  stage_name text not null,
  pii_enc text,                                             -- legal name, date of birth, alias, document
  id_copy_file text,                                        -- encrypted file with the ID document copy
  consent_version text,
  consent_signed_at timestamptz,
  invite_token_hash text unique,
  status text not null default 'pending' check (status in ('pending', 'submitted', 'verified', 'rejected', 'removed')),
  review_note text,
  reviewed_by integer references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index performer_records_primary on performer_records (owner_id) where kind = 'primary';

create table broadcast_sessions (
  id serial primary key,
  creator_id integer not null references users(id),
  title text not null default '',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  recording_path text
);

create table broadcast_performers (
  session_id integer not null references broadcast_sessions(id),
  record_id integer not null references performer_records(id),
  primary key (session_id, record_id)
);

alter table private_shows add column session_id integer references broadcast_sessions(id);
