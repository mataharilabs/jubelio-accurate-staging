-- Phase 3: products, categories, brands, HPP history, and SQL reports.
-- Run after 0004_jubelio_job_lease.sql. Do not drop sku_costs.
-- Does not touch batches or sales_lines.

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists public.products (
  sku text primary key,
  name text not null default '',
  category_id uuid references public.categories(id) on delete set null,
  brand_id uuid references public.brands(id) on delete set null,
  active boolean not null default true,
  jubelio_item_id bigint,
  accurate_item_id text,
  accurate_found text not null default 'unknown' check (accurate_found in ('true', 'false', 'unknown')),
  first_sold_at date,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.product_costs (
  id uuid primary key default gen_random_uuid(),
  sku text not null references public.products(sku) on delete cascade,
  cost_date date not null,
  unit_cost numeric not null,
  source text not null check (source in ('accurate', 'manual')),
  fetched_at timestamptz not null default now(),
  sync_run_id uuid,
  note text not null default '',
  unique (sku, cost_date, source)
);

create index if not exists product_costs_sku_idx on public.product_costs (sku, cost_date desc, fetched_at desc);

create table if not exists public.hpp_sync_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('running', 'done', 'failed')),
  trigger text not null check (trigger in ('manual', 'cron')),
  started_by text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  sku_count integer not null default 0,
  ok_count integer not null default 0,
  not_found_count integer not null default 0,
  error_count integer not null default 0,
  error text,
  pending_skus text[] not null default '{}',
  lease_token text,
  lease_until timestamptz
);

alter table public.product_costs
  drop constraint if exists product_costs_sync_run_id_fkey;
alter table public.product_costs
  add constraint product_costs_sync_run_id_fkey
  foreign key (sync_run_id) references public.hpp_sync_runs(id) on delete set null;

-- Latest HPP. Same day: manual wins over Accurate. A newer date wins over both.
create or replace view public.v_product_cost
with (security_invoker = true) as
select distinct on (sku)
  sku, unit_cost, source, cost_date, fetched_at
from public.product_costs
order by sku, cost_date desc, case when source = 'manual' then 0 else 1 end, fetched_at desc;

insert into public.products (sku, name, first_sold_at, accurate_found)
select
  l.sku,
  coalesce((
    select l2.product_name
    from public.order_lines l2
    join public.order_versions v2 on v2.id = l2.version_id
    where l2.sku = l.sku
      and v2.is_current
      and v2.source not in ('cancel', 'manual_delete')
      and coalesce(l2.product_name, '') <> ''
    group by l2.product_name
    order by count(*) desc, l2.product_name
    limit 1
  ), ''),
  min(v.order_day),
  'unknown'
from public.order_lines l
join public.order_versions v on v.id = l.version_id
where v.is_current
  and v.source not in ('cancel', 'manual_delete')
  and coalesce(l.sku, '') <> ''
group by l.sku
on conflict (sku) do nothing;

update public.roles
set permissions = (
  select coalesce(array_agg(distinct perm), '{}')
  from unnest(permissions || array['products.view', 'products.manage', 'hpp.sync']::text[]) as perm
),
updated_at = now()
where name = 'Super Admin';

insert into public.roles (name, permissions, is_system)
values (
  'Admin',
  array['dashboard.view', 'orders.view', 'orders.export', 'products.view', 'products.manage', 'hpp.sync'],
  true
)
on conflict (name) do update
set permissions = (
  select coalesce(array_agg(distinct perm), '{}')
  from unnest(public.roles.permissions || excluded.permissions) as perm
),
is_system = true,
updated_at = now();

create or replace function public.orders_page(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select
      coalesce(nullif(p->>'from', '')::date, nullif(p->>'day', '')::date, date '0001-01-01') as dfrom,
      coalesce(nullif(p->>'to', '')::date, nullif(p->>'day', '')::date, date '9999-12-31') as dto,
      lower(coalesce(p->>'q', '')) as q,
      greatest(coalesce((p->>'page')::integer, 0), 0) as page_no,
      least(greatest(coalesce((p->>'pageSize')::integer, 30), 1), 2000) as size
  ),
  filtered as (
    select
      s.line_id, s.version_id, s.no_pesanan, s.tanggal, s.order_day, s.channel, s.store_name,
      s.sku, s.product_name, s.line_qty, s.unit_price, s.sub_total, s.total_nilai_pesanan,
      s.total_diskon, s.unit_diskon, s.revenue_per_unit, s.line_revenue, s.customer_name,
      s.customer_code, s.province, s.city, s.kurir, s.status,
      c.unit_cost as hpp
    from public.v_sales_current s
    left join public.v_product_cost c on c.sku = s.sku
    cross join bounds b
    where s.order_day between b.dfrom and b.dto
      and (
        coalesce(jsonb_array_length(p->'statuses'), 0) = 0
        or s.status in (select jsonb_array_elements_text(p->'statuses'))
      )
      and (
        b.q = ''
        or lower(concat_ws(' ', s.no_pesanan, s.sku, s.product_name, s.customer_name, s.store_name, s.city, s.channel)) like '%' || b.q || '%'
      )
  ),
  counted as (
    select count(*) as total, count(distinct no_pesanan) as orders from filtered
  )
  select jsonb_build_object(
    'total', coalesce((select total from counted), 0),
    'orders', coalesce((select orders from counted), 0),
    'page', (select page_no from bounds),
    'pages', greatest(1, ceil(coalesce((select total from counted), 0)::numeric / (select size from bounds))),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.day desc, t."noPesanan", t."lineId")
      from (
        select
          line_id as "lineId",
          version_id as "versionId",
          no_pesanan as "noPesanan",
          to_char(tanggal at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as tanggal,
          to_char(order_day, 'YYYY-MM-DD') as day,
          channel,
          store_name as "storeName",
          sku,
          product_name as "productName",
          line_qty as qty,
          unit_price as "unitPrice",
          sub_total as "subTotal",
          total_nilai_pesanan as "totalNilaiPesanan",
          total_diskon as "totalDiskon",
          unit_diskon as "unitDiskon",
          revenue_per_unit as "revenuePerUnit",
          customer_name as "customerName",
          customer_code as "customerCode",
          province,
          city,
          kurir,
          status,
          hpp,
          case when hpp is null then null else line_revenue - hpp * line_qty end as "grossProfit"
        from filtered
        order by order_day desc, no_pesanan, line_id
        offset (select page_no from bounds) * (select size from bounds)
        limit (select size from bounds)
      ) t
    ), '[]'::jsonb)
  );
$$;

create or replace function public.product_report(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  dfrom date := coalesce(nullif(p->>'from', '')::date, date '0001-01-01');
  dto date := coalesce(nullif(p->>'to', '')::date, date '9999-12-31');
  result jsonb;
begin
  with filtered as (
    select
      s.sku,
      coalesce(nullif(pr.name, ''), s.product_name, s.sku) as product_name,
      coalesce(c.name, '(Tanpa kategori)') as category_name,
      coalesce(b.name, '(Tanpa brand)') as brand_name,
      s.line_qty,
      s.line_revenue,
      cost.unit_cost
    from public.v_sales_current s
    left join public.products pr on pr.sku = s.sku
    left join public.categories c on c.id = pr.category_id
    left join public.brands b on b.id = pr.brand_id
    left join public.v_product_cost cost on cost.sku = s.sku
    where s.order_day between dfrom and dto
      and (
        coalesce(jsonb_array_length(p->'statuses'), 0) > 0
          and s.status in (select jsonb_array_elements_text(p->'statuses'))
        or coalesce(jsonb_array_length(p->'statuses'), 0) = 0
          and coalesce(s.status, '') not in ('CANCELED', 'CANCELLED', 'CANCEL')
      )
      and (
        coalesce(jsonb_array_length(p->'channels'), 0) = 0
        or s.channel in (select jsonb_array_elements_text(p->'channels'))
      )
      and (
        coalesce(jsonb_array_length(p->'stores'), 0) = 0
        or s.store_name in (select jsonb_array_elements_text(p->'stores'))
      )
      and (
        coalesce(jsonb_array_length(p->'brands'), 0) = 0
        or coalesce(b.name, '(Tanpa brand)') in (select jsonb_array_elements_text(p->'brands'))
      )
      and (
        coalesce(jsonb_array_length(p->'categories'), 0) = 0
        or coalesce(c.name, '(Tanpa kategori)') in (select jsonb_array_elements_text(p->'categories'))
      )
  ),
  products as (
    select
      sku,
      max(product_name) as name,
      max(category_name) as category,
      max(brand_name) as brand,
      coalesce(sum(line_qty), 0) as qty,
      coalesce(sum(line_revenue), 0) as net,
      max(unit_cost) as hpp,
      case when max(unit_cost) is null then null else coalesce(sum(line_revenue), 0) - max(unit_cost) * coalesce(sum(line_qty), 0) end as profit
    from filtered
    group by sku
  ),
  brands as (
    select
      brand_name as name,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(line_qty), 0) as qty,
      sum(case when unit_cost is null then null else line_revenue - unit_cost * line_qty end) as profit
    from filtered
    group by brand_name
  ),
  categories as (
    select
      category_name as name,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(line_qty), 0) as qty,
      sum(case when unit_cost is null then null else line_revenue - unit_cost * line_qty end) as profit
    from filtered
    group by category_name
  ),
  coverage as (
    select count(*) as skus, count(hpp) as with_hpp from products
  )
  select jsonb_build_object(
    'coverage', (select jsonb_build_object(
      'skus', skus,
      'withHpp', with_hpp,
      'percent', case when skus = 0 then 0 else round(100.0 * with_hpp / skus, 1) end
    ) from coverage),
    'byNet', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'name', name, 'category', category, 'brand', brand, 'qty', qty, 'net', net, 'hpp', hpp, 'profit', profit) order by net desc) from products), '[]'::jsonb),
    'byQty', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'name', name, 'category', category, 'brand', brand, 'qty', qty, 'net', net, 'hpp', hpp, 'profit', profit) order by qty desc) from products), '[]'::jsonb),
    'byProfit', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'name', name, 'category', category, 'brand', brand, 'qty', qty, 'net', net, 'hpp', hpp, 'profit', profit) order by profit desc) from products where profit is not null), '[]'::jsonb),
    'brandsByNet', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'net', net, 'profit', profit) order by net desc) from brands), '[]'::jsonb),
    'brandsByProfit', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'net', net, 'profit', profit) order by profit desc nulls last) from brands where profit is not null), '[]'::jsonb),
    'categoriesByNet', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'net', net, 'profit', profit) order by net desc) from categories), '[]'::jsonb),
    'categoriesByProfit', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'net', net, 'profit', profit) order by profit desc nulls last) from categories where profit is not null), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

alter table public.categories enable row level security;
alter table public.brands enable row level security;
alter table public.products enable row level security;
alter table public.product_costs enable row level security;
alter table public.hpp_sync_runs enable row level security;

revoke all on public.categories, public.brands, public.products, public.product_costs, public.hpp_sync_runs from public, anon;
grant select, insert, update, delete on public.categories, public.brands, public.products, public.product_costs, public.hpp_sync_runs to authenticated;
grant select on public.v_product_cost to authenticated;
grant execute on function public.orders_page(jsonb), public.product_report(jsonb) to authenticated;

drop policy if exists "admin categories" on public.categories;
drop policy if exists "admin brands" on public.brands;
drop policy if exists "admin products" on public.products;
drop policy if exists "admin product costs" on public.product_costs;
drop policy if exists "admin hpp runs" on public.hpp_sync_runs;
create policy "admin categories" on public.categories for all to authenticated using (true) with check (true);
create policy "admin brands" on public.brands for all to authenticated using (true) with check (true);
create policy "admin products" on public.products for all to authenticated using (true) with check (true);
create policy "admin product costs" on public.product_costs for all to authenticated using (true) with check (true);
create policy "admin hpp runs" on public.hpp_sync_runs for all to authenticated using (true) with check (true);
