-- Leases for periodic tasks: with several instances, only one bills private shows at a time.
create table leases (
  name text primary key,
  holder text not null,
  expires_at timestamptz not null
);
