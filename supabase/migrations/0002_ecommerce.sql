-- Dashboard E-Commerce, versioned orders, mappings, and sync history.
-- Run after 0001_init.sql in the Supabase SQL editor (project uqzzmrugbuxeivawqfld).
-- The app uses SUPABASE_SERVICE_ROLE_KEY on the server. Service role bypasses RLS.
-- Views use security_invoker so they honor RLS for any direct API access.
-- unit_cogs is reserved: gross profit can later be revenue − unit_cogs × qty.

create table if not exists public.imports (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  source text not null check (source in ('raw', 'clean', 'sample')),
  created_at timestamptz not null default now(),
  created_by text,
  order_count integer not null default 0,
  line_count integer not null default 0,
  new_versions integer not null default 0,
  unchanged integer not null default 0,
  from_day date,
  to_day date
);

create table if not exists public.order_versions (
  id uuid primary key default gen_random_uuid(),
  no_pesanan text not null,
  version_no integer not null,
  import_id uuid references public.imports(id) on delete set null,
  source text not null check (source in ('import_raw', 'import_clean', 'manual_edit', 'manual_delete', 'cancel')),
  created_at timestamptz not null default now(),
  created_by text,
  is_current boolean not null default true,
  tanggal timestamptz,
  order_day date,
  channel text not null default '',
  store_name text not null default '',
  customer_name text not null default '',
  customer_code text not null default '',
  province text not null default '',
  city text not null default '',
  kurir text not null default '',
  status text not null default '',
  lokasi_gudang text,
  total_nilai_pesanan numeric,
  total_diskon numeric not null default 0,
  qty numeric not null default 0,
  revenue numeric,
  unique (no_pesanan, version_no)
);

create unique index if not exists order_versions_one_current
  on public.order_versions (no_pesanan) where is_current;
create index if not exists order_versions_day_idx
  on public.order_versions (order_day) where is_current;
create index if not exists order_versions_status_idx
  on public.order_versions (status) where is_current;

create table if not exists public.order_lines (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.order_versions(id) on delete cascade,
  line_no integer not null,
  sku text not null default '',
  product_name text not null default '',
  qty numeric not null default 0,
  unit_price numeric,
  sub_total numeric,
  unit_diskon numeric,
  revenue_per_unit numeric,
  missing_weight boolean not null default false,
  bundle_key text,
  unit_cogs numeric,
  flags text[] not null default '{}'
);

comment on column public.order_lines.unit_cogs is
  'Reserved for future COGS. Null until a cost table is loaded. Gross profit = revenue_per_unit * qty - unit_cogs * qty.';

create index if not exists order_lines_version_idx on public.order_lines (version_id);
create index if not exists order_lines_sku_idx on public.order_lines (sku);

create table if not exists public.sku_costs (
  sku text primary key,
  unit_cogs numeric not null,
  effective_from date not null default current_date,
  note text not null default ''
);

comment on table public.sku_costs is
  'Empty until COGS is supplied. Join on sku to compute gross profit later.';

create table if not exists public.order_changes (
  id uuid primary key default gen_random_uuid(),
  no_pesanan text not null,
  from_version_id uuid references public.order_versions(id) on delete set null,
  to_version_id uuid references public.order_versions(id) on delete cascade,
  field text not null,
  kind text not null check (kind in ('changed', 'added', 'removed')),
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);

create index if not exists order_changes_order_idx on public.order_changes (no_pesanan, created_at);

create table if not exists public.sync_states (
  no_pesanan text primary key,
  last_synced_version_id uuid references public.order_versions(id) on delete set null,
  accurate_id text,
  accurate_number text,
  last_sync_status text check (last_sync_status in ('tersinkron', 'gagal', 'void')),
  decision text check (decision in ('confirmed', 'ignored')),
  decision_version_id uuid references public.order_versions(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text,
  order_count integer not null default 0,
  success_count integer not null default 0,
  fail_count integer not null default 0,
  total_nilai numeric not null default 0,
  revenue numeric not null default 0,
  note text not null default ''
);

create table if not exists public.sync_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.sync_batches(id) on delete cascade,
  no_pesanan text not null,
  version_id uuid references public.order_versions(id) on delete set null,
  category text not null,
  action text not null check (action in ('create', 'update', 'delete')),
  status text not null check (status in ('berhasil', 'gagal')),
  accurate_id text,
  accurate_number text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists sync_batch_items_batch_idx on public.sync_batch_items (batch_id);
create index if not exists sync_batch_items_order_idx on public.sync_batch_items (no_pesanan, created_at);

create table if not exists public.channel_store_map (
  id uuid primary key default gen_random_uuid(),
  channel_raw text not null default '',
  store_raw text not null default '',
  channel text not null default '',
  store_name text not null default '',
  needs_review boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (channel_raw, store_raw)
);

create table if not exists public.province_map (
  id uuid primary key default gen_random_uuid(),
  raw text not null default '',
  official text not null default '',
  needs_review boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (raw)
);

create table if not exists public.city_map (
  id uuid primary key default gen_random_uuid(),
  province_raw text not null default '',
  city_raw text not null default '',
  official text not null default '',
  needs_review boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (province_raw, city_raw)
);

create table if not exists public.review_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('channel_store', 'province', 'city', 'bobot')),
  raw_key text not null,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  unique (kind, raw_key)
);

create or replace view public.v_sales_current
with (security_invoker = true) as
select
  v.id as version_id,
  v.no_pesanan,
  v.order_day,
  v.tanggal,
  v.channel,
  v.store_name,
  v.customer_name,
  v.customer_code,
  v.province,
  v.city,
  v.kurir,
  v.status,
  v.lokasi_gudang,
  v.total_nilai_pesanan,
  v.total_diskon,
  l.id as line_id,
  l.sku,
  l.product_name,
  l.qty as line_qty,
  l.unit_price,
  l.sub_total,
  l.unit_diskon,
  l.revenue_per_unit,
  coalesce(l.revenue_per_unit, 0) * l.qty as line_revenue,
  l.missing_weight,
  l.bundle_key,
  l.unit_cogs,
  case
    when l.unit_cogs is null then null
    else coalesce(l.revenue_per_unit, 0) * l.qty - l.unit_cogs * l.qty
  end as gross_profit
from public.order_versions v
join public.order_lines l on l.version_id = v.id
where v.is_current
  and v.source not in ('cancel', 'manual_delete');

create or replace function public.dashboard_report(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  dfrom date := coalesce(nullif(p->>'from', '')::date, date '0001-01-01');
  dto date := coalesce(nullif(p->>'to', '')::date, date '9999-12-31');
  gran text := coalesce(nullif(p->>'granularity', ''), 'day');
  result jsonb;
begin
  with filtered as (
    select *
    from public.v_sales_current s
    where s.order_day between dfrom and dto
      and (
        coalesce(jsonb_array_length(p->'channels'), 0) = 0
        or s.channel in (select jsonb_array_elements_text(p->'channels'))
      )
      and (
        coalesce(jsonb_array_length(p->'stores'), 0) = 0
        or s.store_name in (select jsonb_array_elements_text(p->'stores'))
      )
      and (
        coalesce(jsonb_array_length(p->'provinces'), 0) = 0
        or s.province in (select jsonb_array_elements_text(p->'provinces'))
      )
      and (
        coalesce(jsonb_array_length(p->'cities'), 0) = 0
        or s.city in (select jsonb_array_elements_text(p->'cities'))
      )
      and (
        coalesce(jsonb_array_length(p->'statuses'), 0) = 0
        or s.status in (select jsonb_array_elements_text(p->'statuses'))
      )
      and (
        coalesce(jsonb_array_length(p->'couriers'), 0) = 0
        or s.kurir in (select jsonb_array_elements_text(p->'couriers'))
      )
      and (
        coalesce(jsonb_array_length(p->'skus'), 0) = 0
        or s.sku in (select jsonb_array_elements_text(p->'skus'))
      )
  ),
  kpis as (
    select
      coalesce(sum(sub_total), 0) as gross,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(line_qty), 0) as qty,
      count(distinct no_pesanan) as orders,
      count(distinct order_day) as days
    from filtered
  ),
  trend as (
    select
      case
        when gran = 'month' then to_char(date_trunc('month', order_day), 'YYYY-MM')
        when gran = 'week' then to_char(date_trunc('week', order_day)::date, 'YYYY-MM-DD')
        else to_char(order_day, 'YYYY-MM-DD')
      end as bucket,
      coalesce(sum(sub_total), 0) as gross,
      coalesce(sum(line_revenue), 0) as net,
      count(distinct no_pesanan) as orders
    from filtered
    where order_day is not null
    group by 1
    order by 1
  ),
  channels as (
    select channel as key, coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders
    from filtered group by channel
  ),
  stores as (
    select store_name as key, coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders
    from filtered group by store_name
  ),
  products as (
    select sku, max(product_name) as name, coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders
    from filtered group by sku
  ),
  provinces as (
    select province as key, coalesce(sum(line_revenue), 0) as net, coalesce(sum(line_qty), 0) as qty,
      count(distinct no_pesanan) as orders
    from filtered group by province
  ),
  cities as (
    select city as key, coalesce(sum(line_revenue), 0) as net, coalesce(sum(line_qty), 0) as qty,
      count(distinct no_pesanan) as orders
    from filtered group by city
  )
  select jsonb_build_object(
    'kpis', (select jsonb_build_object(
      'gross', gross, 'net', net, 'disc', gross - net, 'qty', qty, 'orders', orders, 'days', days,
      'aov', case when orders = 0 then 0 else net / orders end
    ) from kpis),
    'trend', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'gross', gross, 'net', net, 'orders', orders) order by bucket) from trend), '[]'::jsonb),
    'channels', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'gross', gross, 'net', net, 'qty', qty, 'orders', orders) order by gross desc) from channels), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'gross', gross, 'net', net, 'qty', qty, 'orders', orders) order by gross desc) from stores), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'key', sku, 'name', name, 'gross', gross, 'net', net, 'qty', qty, 'orders', orders) order by net desc) from products), '[]'::jsonb),
    'provinces', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'net', net, 'qty', qty, 'orders', orders) order by net desc) from provinces), '[]'::jsonb),
    'cities', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'net', net, 'qty', qty, 'orders', orders) order by net desc) from cities), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.dashboard_options()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'channels', coalesce((select jsonb_agg(x order by x) from (select distinct channel x from public.v_sales_current where channel <> '') s), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(x order by x) from (select distinct store_name x from public.v_sales_current where store_name <> '') s), '[]'::jsonb),
    'provinces', coalesce((select jsonb_agg(x order by x) from (select distinct province x from public.v_sales_current where province <> '') s), '[]'::jsonb),
    'cities', coalesce((select jsonb_agg(x order by x) from (select distinct city x from public.v_sales_current where city <> '') s), '[]'::jsonb),
    'statuses', coalesce((select jsonb_agg(x order by x) from (select distinct status x from public.v_sales_current where status <> '') s), '[]'::jsonb),
    'couriers', coalesce((select jsonb_agg(x order by x) from (select distinct kurir x from public.v_sales_current where kurir <> '') s), '[]'::jsonb),
    'skus', coalesce((select jsonb_agg(x order by x) from (select distinct sku x from public.v_sales_current where sku <> '') s), '[]'::jsonb),
    'minDay', (select to_char(min(order_day), 'YYYY-MM-DD') from public.v_sales_current),
    'maxDay', (select to_char(max(order_day), 'YYYY-MM-DD') from public.v_sales_current)
  );
$$;

revoke all on public.imports, public.order_versions, public.order_lines, public.sku_costs,
  public.order_changes, public.sync_states, public.sync_batches, public.sync_batch_items,
  public.channel_store_map, public.province_map, public.city_map, public.review_items
  from public, anon;
grant select, insert, update, delete on public.imports, public.order_versions, public.order_lines, public.sku_costs,
  public.order_changes, public.sync_states, public.sync_batches, public.sync_batch_items,
  public.channel_store_map, public.province_map, public.city_map, public.review_items
  to authenticated;
grant select on public.v_sales_current to authenticated;
grant execute on function public.dashboard_report(jsonb), public.dashboard_options() to authenticated;

alter table public.imports enable row level security;
alter table public.order_versions enable row level security;
alter table public.order_lines enable row level security;
alter table public.sku_costs enable row level security;
alter table public.order_changes enable row level security;
alter table public.sync_states enable row level security;
alter table public.sync_batches enable row level security;
alter table public.sync_batch_items enable row level security;
alter table public.channel_store_map enable row level security;
alter table public.province_map enable row level security;
alter table public.city_map enable row level security;
alter table public.review_items enable row level security;

create policy "admin imports" on public.imports for all to authenticated using (true) with check (true);
create policy "admin versions" on public.order_versions for all to authenticated using (true) with check (true);
create policy "admin lines" on public.order_lines for all to authenticated using (true) with check (true);
create policy "admin sku costs" on public.sku_costs for all to authenticated using (true) with check (true);
create policy "admin changes" on public.order_changes for all to authenticated using (true) with check (true);
create policy "admin sync states" on public.sync_states for all to authenticated using (true) with check (true);
create policy "admin sync batches" on public.sync_batches for all to authenticated using (true) with check (true);
create policy "admin sync items" on public.sync_batch_items for all to authenticated using (true) with check (true);
create policy "admin channel map" on public.channel_store_map for all to authenticated using (true) with check (true);
create policy "admin province map" on public.province_map for all to authenticated using (true) with check (true);
create policy "admin city map" on public.city_map for all to authenticated using (true) with check (true);
create policy "admin reviews" on public.review_items for all to authenticated using (true) with check (true);
