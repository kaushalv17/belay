-- Belay Phase 2: policy layer (budgets, rate limits, approvals)
-- Safe to run on an existing belay_actions table.

alter table belay_actions add column if not exists cost double precision not null default 0;
alter table belay_actions add column if not exists reason text;

-- Speeds up budget / rate-limit aggregate queries and the approvals inbox.
create index if not exists belay_actions_scope_created_idx
  on belay_actions (scope, created_at);
