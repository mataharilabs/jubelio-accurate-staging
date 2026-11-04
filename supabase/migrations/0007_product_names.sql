-- Product names from the Jubelio item master. Run after 0005.
-- Does not touch batches, sales_lines, product_costs, or existing order rows.

alter table public.products
  add column if not exists name_source text;

alter table public.products
  drop constraint if exists products_name_source_check;

alter table public.products
  add constraint products_name_source_check
  check (name_source is null or name_source in ('item', 'line'));

create table if not exists public.product_name_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('running', 'done', 'failed')),
  trigger text not null check (trigger in ('manual', 'cron')),
  started_by text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  sku_count integer not null default 0,
  changed_count integer not null default 0,
  fallback_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  error text,
  pending_skus text[] not null default '{}',
  sample jsonb not null default '[]'::jsonb,
  lease_token text,
  lease_until timestamptz
);

alter table public.product_name_runs enable row level security;
revoke all on public.product_name_runs from public, anon;
grant select, insert, update, delete on public.product_name_runs to authenticated;
drop policy if exists "admin product name runs" on public.product_name_runs;
create policy "admin product name runs" on public.product_name_runs for all to authenticated using (true) with check (true);
