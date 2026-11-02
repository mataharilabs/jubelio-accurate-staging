-- Phase 1: roles, audit, notifications, Jubelio pull jobs.
-- Additive. Does not drop data and does not touch batches or sales_lines.
-- Run after 0002_ecommerce.sql. Does not create auth users.

alter table public.imports drop constraint if exists imports_source_check;
alter table public.imports add constraint imports_source_check
  check (source in ('raw', 'clean', 'sample', 'api'));

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null default '',
  role_id uuid not null references public.roles(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_email text not null,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb
);

create index if not exists audit_log_at_idx on public.audit_log (at desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null,
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  read_by text[] not null default '{}'
);

create index if not exists notifications_created_idx on public.notifications (created_at desc);

create table if not exists public.jubelio_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('running', 'done', 'failed')),
  trigger text not null,
  triggered_by text not null,
  days text[] not null,
  day text,
  page integer not null default 1,
  list_done boolean not null default false,
  pending_ids bigint[] not null default '{}',
  stats jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.jubelio_bundles (
  item_id bigint primary key,
  item_code text,
  item_name text,
  components jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.roles (name, permissions, is_system)
values (
  'Super Admin',
  array[
    'dashboard.view','dashboard.export','orders.view','orders.edit','orders.export',
    'import.upload','import.pull','sync.view','sync.confirm','sync.execute',
    'mappings.manage','weights.manage','settings.manage','users.manage','roles.manage','audit.view'
  ],
  true
)
on conflict (name) do update
  set permissions = excluded.permissions, is_system = true, updated_at = now();

alter table public.roles enable row level security;
alter table public.app_users enable row level security;
alter table public.audit_log enable row level security;
alter table public.notifications enable row level security;
alter table public.jubelio_jobs enable row level security;
alter table public.jubelio_bundles enable row level security;

revoke all on public.roles, public.app_users, public.audit_log, public.notifications, public.jubelio_jobs, public.jubelio_bundles from public, anon;
grant select, insert, update, delete on public.roles, public.app_users, public.audit_log, public.notifications, public.jubelio_jobs, public.jubelio_bundles to authenticated;

drop policy if exists "admin roles" on public.roles;
drop policy if exists "admin app users" on public.app_users;
drop policy if exists "admin audit" on public.audit_log;
drop policy if exists "admin notifications" on public.notifications;
drop policy if exists "admin jubelio jobs" on public.jubelio_jobs;
drop policy if exists "admin jubelio bundles" on public.jubelio_bundles;
create policy "admin roles" on public.roles for all to authenticated using (true) with check (true);
create policy "admin app users" on public.app_users for all to authenticated using (true) with check (true);
create policy "admin audit" on public.audit_log for all to authenticated using (true) with check (true);
create policy "admin notifications" on public.notifications for all to authenticated using (true) with check (true);
create policy "admin jubelio jobs" on public.jubelio_jobs for all to authenticated using (true) with check (true);
create policy "admin jubelio bundles" on public.jubelio_bundles for all to authenticated using (true) with check (true);

-- Promote an existing login (do not create an auth user). Replace the email, then run:
-- insert into public.app_users (email, role_id, active)
-- select 'admin@example.com', id, true from public.roles where name = 'Super Admin'
-- on conflict (email) do update set role_id = excluded.role_id, active = true, updated_at = now();
