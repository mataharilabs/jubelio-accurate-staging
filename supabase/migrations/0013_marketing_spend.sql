-- Marketing spending (Fase 7). Additive only.
-- Does not touch public.batches or public.sales_lines.
-- Does not delete rows. Overwrite and hapus massal set deleted_at.
--
-- Apply by hand in the Supabase SQL Editor (project production), once, after
-- 0012_accurate_customers.sql. Do not run this from the app, do not call /api/seed,
-- and do not apply it automatically from CI.
--
--   1. Open Supabase → SQL Editor.
--   2. Paste this file and run it.
--   3. Confirm: select to_regclass('public.marketing_spend');
-- After it runs, Master Data → Marketing Spending can store ad reports.

create table if not exists public.marketing_spend (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid,
  line_no integer not null default 0,
  period_start date not null,
  period_end date not null,
  platform text not null,
  store_name text not null,
  campaign text not null default '',
  spend numeric not null default 0,
  impressions numeric,
  clicks numeric,
  orders numeric,
  ads_revenue numeric,
  source text not null check (source in ('file', 'manual', 'template')),
  source_file text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by text,
  constraint marketing_spend_period_order check (period_end >= period_start),
  constraint marketing_spend_same_month check (
    extract(year from period_start) = extract(year from period_end)
    and extract(month from period_start) = extract(month from period_end)
  )
);

create index if not exists marketing_spend_active_idx
  on public.marketing_spend (platform, store_name, period_start, period_end)
  where deleted_at is null;

create index if not exists marketing_spend_month_idx
  on public.marketing_spend (period_start)
  where deleted_at is null;

create table if not exists public.marketing_spend_audit (
  id uuid primary key default gen_random_uuid(),
  spend_id uuid,
  upload_id uuid,
  action text not null check (action in ('create', 'overwrite', 'delete')),
  actor text not null default '',
  at timestamptz not null default now(),
  platform text,
  store_name text,
  period_start date,
  period_end date,
  snapshot jsonb not null default '{}'::jsonb
);

create index if not exists marketing_spend_audit_upload_idx
  on public.marketing_spend_audit (upload_id, at);

alter table public.marketing_spend enable row level security;
alter table public.marketing_spend_audit enable row level security;
revoke all on public.marketing_spend, public.marketing_spend_audit from public, anon;
grant select, insert, update, delete on public.marketing_spend to authenticated;
grant select, insert on public.marketing_spend_audit to authenticated;

drop policy if exists "admin marketing spend" on public.marketing_spend;
create policy "admin marketing spend" on public.marketing_spend
  for all to authenticated using (true) with check (true);

drop policy if exists "admin marketing spend audit" on public.marketing_spend_audit;
create policy "admin marketing spend audit" on public.marketing_spend_audit
  for all to authenticated using (true) with check (true);

update public.roles
set permissions = (
  select coalesce(array_agg(distinct perm), '{}')
  from unnest(permissions || array['marketing.view', 'marketing.manage']::text[]) as perm
),
updated_at = now()
where name in ('Admin', 'Super Admin');
