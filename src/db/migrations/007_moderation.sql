-- Sample frames from live streams and moderation cases.
create table moderation_frames (
  id serial primary key,
  creator_id integer not null references users(id),
  session_id integer references broadcast_sessions(id),
  private_show_id integer references private_shows(id),
  file text,                                   -- encrypted file in DATA_DIR/frames (null if already deleted)
  bytes integer not null,
  scan_status text not null default 'pending' check (scan_status in ('pending', 'clear', 'suspect', 'match', 'error', 'skipped')),
  scanner text,
  scan_detail text,
  reviewed_by integer references users(id),
  reviewed_at timestamptz,
  retain_until timestamptz,                    -- mandatory retention (e.g. 1 year after a report)
  created_at timestamptz not null default now()
);
create index moderation_frames_creator on moderation_frames (creator_id, created_at desc);
create index moderation_frames_status on moderation_frames (scan_status) where scan_status in ('suspect', 'match');

create table moderation_incidents (
  id serial primary key,
  creator_id integer not null references users(id),
  frame_id integer references moderation_frames(id),
  kind text not null check (kind in ('hash_match', 'classifier', 'manual')),
  status text not null default 'open' check (status in ('open', 'reported', 'dismissed')),
  detail text not null default '',
  external_report_id text,
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by integer references users(id)
);
