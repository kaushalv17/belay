// Idempotent DDL for the Quorvel Cloud ledger. Applied at boot by migrate().
export const SCHEMA_SQL = `
create table if not exists orgs (
  id          text primary key,
  name        text not null,
  plan        text not null default 'free',
  created_at  timestamptz not null default now()
);

create table if not exists api_keys (
  id           text primary key,
  org_id       text not null references orgs(id) on delete cascade,
  key_hash     text not null unique,
  key_prefix   text not null,
  name         text not null default 'default',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create table if not exists belay_actions (
  org_id           text not null references orgs(id) on delete cascade,
  idempotency_key  text not null,
  scope            text,
  tool             text not null,
  args             jsonb,
  cost             float8 not null default 0,
  status           text not null default 'pending',
  result           jsonb,
  error            text,
  reason           text,
  attempts         int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (org_id, idempotency_key)
);

create index if not exists belay_actions_status_idx on belay_actions (org_id, status, created_at);
create index if not exists belay_actions_scope_idx  on belay_actions (org_id, scope);
create index if not exists belay_actions_recent_idx on belay_actions (org_id, created_at desc);

-- Part 9: monthly metered-usage counters per org.
create table if not exists usage_counters (
  org_id  text not null references orgs(id) on delete cascade,
  period  text not null,
  count   bigint not null default 0,
  primary key (org_id, period)
);

-- Multi-tenancy: link Quorvel orgs to Clerk orgs + a membership roster.
alter table orgs add column if not exists clerk_org_id text;
create unique index if not exists orgs_clerk_org_id_idx on orgs (clerk_org_id);

create table if not exists memberships (
  clerk_user_id  text not null,
  org_id         text not null references orgs(id) on delete cascade,
  role           text not null default 'member',
  created_at     timestamptz not null default now(),
  primary key (clerk_user_id, org_id)
);
create index if not exists memberships_org_idx on memberships (org_id);

-- Phase 1/2/4/7: self-serve API keys, billing customer link, audit log.
alter table api_keys add column if not exists key_env text not null default 'live';
alter table api_keys add column if not exists scopes  text not null default 'actions:read,actions:write';
alter table api_keys add column if not exists created_by text;

alter table orgs add column if not exists paddle_customer_id text;
alter table orgs add column if not exists trial_ends_at timestamptz;
create index if not exists orgs_paddle_customer_idx on orgs (paddle_customer_id);

create table if not exists audit_log (
  id          text primary key,
  org_id      text not null references orgs(id) on delete cascade,
  actor_id    text,
  action      text not null,
  target      text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_org_idx on audit_log (org_id, created_at desc);
`
