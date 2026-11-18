-- Real integrations: provider reference and refund states.
alter table purchases add column provider_ref text;
alter table purchases drop constraint purchases_status_check;
alter table purchases add constraint purchases_status_check
  check (status in ('pending', 'paid', 'failed', 'refunded', 'chargeback'));
alter table ledger_tx drop constraint ledger_tx_kind_check;
alter table ledger_tx add constraint ledger_tx_kind_check
  check (kind in ('purchase', 'purchase_reversal', 'tip', 'menu', 'private', 'payout', 'payout_reversal', 'adjustment'));
create index verifications_provider_ref on verifications (provider, provider_ref);

-- Notifications received from providers (for auditing and debugging).
create table webhook_log (
  id serial primary key,
  provider text not null,
  ok boolean not null,
  note text not null default '',
  ip text,
  created_at timestamptz not null default now()
);
