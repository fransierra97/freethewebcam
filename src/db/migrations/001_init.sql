create table settings (
  key text primary key,
  value jsonb not null
);

create table users (
  id serial primary key,
  email text not null unique,
  display_name text not null unique,
  password_hash text not null,
  is_admin boolean not null default false,
  creator_status text not null default 'none'
    check (creator_status in ('none', 'pending_kyc', 'pending_approval', 'approved', 'rejected', 'suspended')),
  status text not null default 'active' check (status in ('active', 'banned')),
  age_verified_at timestamptz,
  age_self_declared_at timestamptz,
  total_spent integer not null default 0,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table creator_profiles (
  user_id integer primary key references users(id) on delete cascade,
  slug text not null unique,
  bio text not null default '',
  room_title text not null default '',
  private_enabled boolean not null default true,
  private_price_per_min integer not null default 60 check (private_price_per_min > 0),
  is_live boolean not null default false,
  live_since timestamptz,
  goal_label text,
  goal_tokens integer check (goal_tokens is null or goal_tokens > 0),
  goal_progress integer not null default 0
);

create table tip_menu_items (
  id serial primary key,
  creator_id integer not null references users(id) on delete cascade,
  label text not null,
  price integer not null check (price > 0),
  position integer not null default 0
);

create table follows (
  follower_id integer not null references users(id) on delete cascade,
  creator_id integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, creator_id)
);

create table room_bans (
  creator_id integer not null references users(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (creator_id, user_id)
);

create table verifications (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('creator_kyc', 'viewer_age')),
  provider text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  provider_ref text,
  test boolean not null default false,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table provider_configs (
  id text primary key,
  enabled boolean not null default false,
  mode text not null default 'test' check (mode in ('test', 'live')),
  credentials_enc text,
  updated_at timestamptz not null default now()
);

-- Double-entry ledger: each transaction sums to zero.
create table accounts (
  id serial primary key,
  kind text not null check (kind in ('wallet', 'earnings', 'platform', 'purchases', 'payouts')),
  user_id integer references users(id) on delete restrict
);
create unique index accounts_user_kind on accounts (kind, user_id) where user_id is not null;
create unique index accounts_system_kind on accounts (kind) where user_id is null;

create table ledger_tx (
  id serial primary key,
  kind text not null check (kind in ('purchase', 'tip', 'menu', 'private', 'payout', 'payout_reversal', 'adjustment')),
  idempotency_key text unique,
  memo text not null default '',
  meta jsonb not null default '{}',
  test boolean not null default false,
  created_at timestamptz not null default now()
);

create table ledger_entries (
  id serial primary key,
  tx_id integer not null references ledger_tx(id),
  account_id integer not null references accounts(id),
  amount integer not null check (amount <> 0)
);
create index ledger_entries_account on ledger_entries (account_id);

create table purchases (
  id serial primary key,
  user_id integer not null references users(id),
  package_id text not null,
  tokens integer not null check (tokens > 0),
  price_cents integer not null,
  currency text not null,
  provider text not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  test boolean not null default false,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table private_shows (
  id serial primary key,
  creator_id integer not null references users(id),
  viewer_id integer not null references users(id),
  price_per_min integer not null,
  status text not null default 'requested'
    check (status in ('requested', 'active', 'ended', 'declined', 'cancelled')),
  minutes_billed integer not null default 0,
  tokens_billed integer not null default 0,
  end_reason text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);

create table payouts (
  id serial primary key,
  creator_id integer not null references users(id),
  tokens integer not null check (tokens > 0),
  amount_cents integer not null,
  currency text not null,
  status text not null default 'requested' check (status in ('requested', 'paid', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table reports (
  id serial primary key,
  reporter_id integer not null references users(id),
  creator_id integer not null references users(id),
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolution text,
  created_at timestamptz not null default now()
);

create table audit_log (
  id serial primary key,
  actor_id integer references users(id),
  action text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

insert into accounts (kind) values ('platform'), ('purchases'), ('payouts');
