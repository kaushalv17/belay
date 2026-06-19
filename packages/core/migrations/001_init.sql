-- Belay durable ledger schema
-- Run this once against your Postgres database (e.g. Neon).

create table if not exists belay_actions (
  id              bigserial primary key,
  idempotency_key text not null unique,
  scope           text,
  tool            text not null,
  args            jsonb not null,
  status          text not null default 'pending',
    -- pending | running | succeeded | failed | awaiting_approval
  result          jsonb,
  error           text,
  attempts        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists belay_actions_status_idx on belay_actions (status);
create index if not exists belay_actions_tool_idx on belay_actions (tool);
