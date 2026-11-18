-- Legal texts edited by the operator (if there is no row, the template in config/legal is used).
create table legal_pages (
  slug text primary key,
  body text not null,
  updated_by integer references users(id),
  updated_at timestamptz not null default now()
);
