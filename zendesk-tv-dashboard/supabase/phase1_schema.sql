create extension if not exists pgcrypto;

create table if not exists public.snapshots (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null,
  snapshot_mode text,
  core_generated_at timestamptz,
  heavy_generated_at timestamptz,
  unsolved_count integer not null,
  attention_count integer not null,
  active_alert_count integer not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists snapshots_generated_at_idx on public.snapshots (generated_at desc);
create index if not exists snapshots_created_at_idx on public.snapshots (created_at desc);

create table if not exists public.worker_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  duration_ms integer not null,
  success boolean not null,
  error_message text,
  snapshot_mode text,
  poll_reason text not null,
  rate_limit_remaining integer,
  rate_limit_limit integer,
  rate_limit_reset_seconds integer,
  created_at timestamptz not null default now()
);

create index if not exists worker_runs_started_at_idx on public.worker_runs (started_at desc);
create index if not exists worker_runs_success_idx on public.worker_runs (success, started_at desc);

create table if not exists public.alert_events (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null,
  snapshot_mode text,
  metric text not null,
  label text not null,
  current_value integer not null,
  threshold integer not null,
  active boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists alert_events_generated_at_idx on public.alert_events (generated_at desc);
create index if not exists alert_events_metric_active_idx on public.alert_events (metric, active, generated_at desc);
