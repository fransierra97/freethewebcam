-- Private photo and video albums unlocked with tokens.
alter table ledger_tx drop constraint ledger_tx_kind_check;
alter table ledger_tx add constraint ledger_tx_kind_check
  check (kind in ('purchase', 'purchase_reversal', 'tip', 'menu', 'private', 'payout', 'payout_reversal', 'adjustment',
                  'ticket', 'ticket_refund', 'dm', 'poll', 'album'));

create table albums (
  id serial primary key,
  creator_id integer not null references users(id),
  title text not null,
  description text not null default '',
  price integer not null check (price > 0),
  status text not null default 'draft' check (status in ('draft', 'pending_review', 'published', 'rejected', 'removed')),
  cover_file text,
  cover_iv text,
  cover_mime text,
  review_note text,
  reviewed_by integer references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index albums_creator on albums (creator_id, status);

create table album_items (
  id serial primary key,
  album_id integer not null references albums(id) on delete cascade,
  kind text not null check (kind in ('image', 'video')),
  file text not null,
  iv text not null,
  mime text not null,
  bytes bigint not null,
  position integer not null default 0,
  scan_status text not null default 'pending' check (scan_status in ('pending', 'clear', 'suspect', 'match', 'error', 'skipped', 'manual')),
  created_at timestamptz not null default now()
);

create table album_performers (
  album_id integer not null references albums(id) on delete cascade,
  record_id integer not null references performer_records(id),
  primary key (album_id, record_id)
);

create table album_unlocks (
  album_id integer not null references albums(id),
  user_id integer not null references users(id),
  tx_id integer references ledger_tx(id),
  created_at timestamptz not null default now(),
  primary key (album_id, user_id)
);

alter table moderation_incidents add column album_item_id integer references album_items(id);
