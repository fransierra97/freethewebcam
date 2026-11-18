-- Live features: cam2cam, notifications, schedule, messages, ticketed shows,
-- chat moderation, polls and giveaways.

alter table ledger_tx drop constraint ledger_tx_kind_check;
alter table ledger_tx add constraint ledger_tx_kind_check
  check (kind in ('purchase', 'purchase_reversal', 'tip', 'menu', 'private', 'payout', 'payout_reversal', 'adjustment',
                  'ticket', 'ticket_refund', 'dm', 'poll'));

alter table creator_profiles add column cam2cam_enabled boolean not null default true;
alter table creator_profiles add column cam2cam_price_per_min integer not null default 0 check (cam2cam_price_per_min >= 0);
alter table creator_profiles add column dm_price integer not null default 0 check (dm_price >= 0);
alter table creator_profiles add column chat_slow_seconds integer not null default 0 check (chat_slow_seconds between 0 and 600);
alter table creator_profiles add column chat_followers_only boolean not null default false;
alter table creator_profiles add column chat_banned_words text not null default '';

alter table private_shows add column cam2cam_on boolean not null default false;
alter table private_shows add column cam2cam_price integer not null default 0;

alter table users add column notify_discreet boolean not null default true;

create table notifications (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  url text not null default '/',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user on notifications (user_id, id desc);

create table push_subscriptions (
  id serial primary key,
  user_id integer not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table scheduled_shows (
  id serial primary key,
  creator_id integer not null references users(id) on delete cascade,
  starts_at timestamptz not null,
  title text not null,
  reminded boolean not null default false,
  created_at timestamptz not null default now()
);
create index scheduled_shows_time on scheduled_shows (starts_at);

create table dm_messages (
  id serial primary key,
  sender_id integer not null references users(id) on delete cascade,
  recipient_id integer not null references users(id) on delete cascade,
  body text not null,
  price integer not null default 0,
  tx_id integer references ledger_tx(id),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index dm_messages_pair on dm_messages (least(sender_id, recipient_id), greatest(sender_id, recipient_id), id);
create index dm_messages_recipient on dm_messages (recipient_id, read_at);

alter table reports add column dm_message_id integer references dm_messages(id);

create table ticket_shows (
  id serial primary key,
  creator_id integer not null references users(id),
  title text not null,
  price integer not null check (price > 0),
  status text not null default 'selling' check (status in ('selling', 'live', 'ended', 'cancelled')),
  session_id integer references broadcast_sessions(id),
  egress_id text,
  recording_path text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);
create unique index ticket_shows_one_open on ticket_shows (creator_id) where status in ('selling', 'live');

create table tickets (
  show_id integer not null references ticket_shows(id),
  user_id integer not null references users(id),
  tx_id integer references ledger_tx(id),
  refunded boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (show_id, user_id)
);

create table room_moderators (
  creator_id integer not null references users(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (creator_id, user_id)
);

create table room_mutes (
  creator_id integer not null references users(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  until timestamptz not null,
  primary key (creator_id, user_id)
);

create table polls (
  id serial primary key,
  creator_id integer not null references users(id),
  question text not null,
  options jsonb not null,
  vote_price integer not null default 0 check (vote_price >= 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index polls_one_open on polls (creator_id) where status = 'open';

create table poll_votes (
  id serial primary key,
  poll_id integer not null references polls(id),
  user_id integer not null references users(id),
  option_index integer not null,
  weight integer not null default 1,
  tx_id integer references ledger_tx(id),
  created_at timestamptz not null default now()
);
create index poll_votes_poll on poll_votes (poll_id);

create table raffles (
  id serial primary key,
  creator_id integer not null references users(id),
  prize text not null,
  audience text not null check (audience in ('present', 'followers')),
  entrants integer not null,
  winner_id integer references users(id),
  created_at timestamptz not null default now()
);
