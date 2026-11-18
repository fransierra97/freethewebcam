-- Dedicated account for tokens given away by the admin (promotions, demo, compensation),
-- so they don't mix with what the platform earns.
alter table accounts drop constraint accounts_kind_check;
alter table accounts add constraint accounts_kind_check
  check (kind in ('wallet', 'earnings', 'platform', 'purchases', 'payouts', 'promotions'));
insert into accounts (kind) values ('promotions');
