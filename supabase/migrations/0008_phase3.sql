-- Phase 3: mapping dates, HPP updated_at, tutup buku lives in app_settings JSON,
-- return case, -R linkage, soft-delete flag, and the Accurate sync log.
-- Additive only. Does not touch public.batches or public.sales_lines.
-- Apply after 0007_product_names.sql. Do not delete production rows.

alter table public.order_versions add column if not exists data_status text not null default 'active';
alter table public.order_versions add column if not exists content_updated_at timestamptz;
alter table public.order_versions add column if not exists return_case smallint;
alter table public.order_versions add column if not exists parent_no_pesanan text;
alter table public.order_versions add column if not exists loss_sibling boolean not null default false;

do $$ begin
  alter table public.order_versions add constraint order_versions_data_status_check check (data_status in ('active', 'deleted'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.order_versions add constraint order_versions_return_case_check check (return_case is null or return_case in (1, 2, 3));
exception when duplicate_object then null;
end $$;

update public.order_versions
set content_updated_at = created_at
where content_updated_at is null;

alter table public.channel_store_map add column if not exists mapped_at timestamptz;
alter table public.province_map add column if not exists mapped_at timestamptz;
alter table public.city_map add column if not exists mapped_at timestamptz;
alter table public.bundle_weights add column if not exists confirmed_at timestamptz;
alter table public.product_costs add column if not exists updated_at timestamptz;
alter table public.sync_states add column if not exists synced_at timestamptz;

update public.channel_store_map
set mapped_at = updated_at
where mapped_at is null
  and needs_review = false
  and coalesce(channel, '') <> ''
  and coalesce(store_name, '') <> '';

update public.province_map
set mapped_at = updated_at
where mapped_at is null
  and needs_review = false
  and coalesce(official, '') <> '';

update public.city_map
set mapped_at = updated_at
where mapped_at is null
  and needs_review = false
  and coalesce(official, '') <> '';

update public.bundle_weights
set confirmed_at = updated_at
where confirmed_at is null;

update public.product_costs
set updated_at = fetched_at
where updated_at is null;

update public.sync_states
set synced_at = updated_at
where synced_at is null
  and (last_sync_status = 'tersinkron' or decision = 'ignored');

create table if not exists public.sync_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor text,
  action text not null check (action in ('sync', 'ignore', 'blocked')),
  no_pesanan text not null default '',
  detail jsonb not null default '{}'::jsonb,
  note text not null default ''
);

create index if not exists sync_log_created_idx on public.sync_log (created_at desc);

-- Master lines, including soft-deleted orders. Dashboard view below stays active-only.
create or replace view public.v_order_lines_master
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
  end as gross_profit,
  coalesce(v.data_status, 'active') as data_status,
  v.content_updated_at,
  v.return_case,
  v.parent_no_pesanan,
  coalesce(v.loss_sibling, false) as loss_sibling
from public.order_versions v
join public.order_lines l on l.version_id = v.id
where v.is_current
  and v.source not in ('cancel', 'manual_delete');

-- Same columns as 0002, plus the soft-delete filter. Column list is unchanged so replace is safe.
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
  and v.source not in ('cancel', 'manual_delete')
  and coalesce(v.data_status, 'active') = 'active';

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
    select
      s.*,
      coalesce(br.name, '') as brand_name,
      coalesce(cat.name, '') as category_name,
      cost.unit_cost as dpp,
      coalesce(cost.carried, false) as carried,
      round(coalesce(cost.unit_cost, 0) * 1.11 * s.line_qty) as hpp_line,
      (cost.unit_cost is null) as hpp_miss
    from public.v_sales_current s
    left join public.products pr on pr.sku = s.sku
    left join public.brands br on br.id = pr.brand_id
    left join public.categories cat on cat.id = pr.category_id
    left join lateral public.effective_product_cost(s.sku, s.order_day) cost on true
    where s.order_day between dfrom and dto
      and (coalesce(jsonb_array_length(p->'channels'), 0) = 0 or s.channel in (select jsonb_array_elements_text(p->'channels')))
      and (coalesce(jsonb_array_length(p->'stores'), 0) = 0 or s.store_name in (select jsonb_array_elements_text(p->'stores')))
      and (coalesce(jsonb_array_length(p->'provinces'), 0) = 0 or s.province in (select jsonb_array_elements_text(p->'provinces')))
      and (coalesce(jsonb_array_length(p->'cities'), 0) = 0 or s.city in (select jsonb_array_elements_text(p->'cities')))
      and (coalesce(jsonb_array_length(p->'statuses'), 0) = 0 or s.status in (select jsonb_array_elements_text(p->'statuses')))
      and (coalesce(jsonb_array_length(p->'couriers'), 0) = 0 or s.kurir in (select jsonb_array_elements_text(p->'couriers')))
      and (coalesce(jsonb_array_length(p->'skus'), 0) = 0 or s.sku in (select jsonb_array_elements_text(p->'skus')))
      and (coalesce(jsonb_array_length(p->'brands'), 0) = 0 or coalesce(br.name, '') in (select jsonb_array_elements_text(p->'brands')))
      and (coalesce(jsonb_array_length(p->'categories'), 0) = 0 or coalesce(cat.name, '') in (select jsonb_array_elements_text(p->'categories')))
  ),
  kpis as (
    select
      coalesce(sum(sub_total), 0) as gross,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(line_qty), 0) as qty,
      count(distinct no_pesanan) as orders,
      count(distinct order_day) as days,
      coalesce(sum(hpp_line), 0) as hpp,
      count(distinct sku) filter (where hpp_miss) as missing_skus
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
      coalesce(sum(hpp_line), 0) as hpp,
      count(distinct no_pesanan) as orders
    from filtered
    where order_day is not null
    group by 1
  ),
  channels as (
    select channel as key, coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp, coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders
    from filtered group by channel
  ),
  stores as (
    select store_name as key, coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp, coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders
    from filtered group by store_name
  ),
  products as (
    select sku, max(product_name) as name, max(brand_name) as brand, max(category_name) as category,
      coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp, coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders,
      bool_or(hpp_miss) as miss
    from filtered group by sku
  ),
  brand_rows as (
    select brand_name as key, coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp, coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders
    from filtered where brand_name <> '' group by brand_name
  ),
  category_rows as (
    select category_name as key, coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp, coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders
    from filtered where category_name <> '' group by category_name
  ),
  provinces as (
    select province as key, coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp, coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders
    from filtered group by province
  ),
  cities as (
    select city as key, coalesce(sum(sub_total), 0) as gross, coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp, coalesce(sum(line_qty), 0) as qty, count(distinct no_pesanan) as orders
    from filtered group by city
  ),
  missing as (
    select sku from filtered where hpp_miss group by sku order by sku limit 4
  )
  select jsonb_build_object(
    'kpis', (select jsonb_build_object(
      'gross', gross, 'net', net, 'disc', gross - net, 'qty', qty, 'orders', orders, 'days', days,
      'aov', case when orders = 0 then 0 else net / orders end,
      'hpp', hpp, 'fee', 0, 'marketing', 0, 'profit', net - hpp,
      'missingSkus', missing_skus,
      'missingSkuSample', coalesce((select jsonb_agg(sku) from missing), '[]'::jsonb)
    ) from kpis),
    'trend', coalesce((select jsonb_agg(jsonb_build_object(
      'bucket', bucket, 'gross', gross, 'net', net, 'hpp', hpp, 'profit', net - hpp, 'orders', orders
    ) order by bucket) from trend), '[]'::jsonb),
    'channels', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'profit', net - hpp, 'qty', qty, 'orders', orders
    ) order by net desc) from channels), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'profit', net - hpp, 'qty', qty, 'orders', orders
    ) order by net desc) from stores), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
      'sku', sku, 'key', sku, 'name', name, 'brand', brand, 'category', category,
      'gross', gross, 'net', net, 'hpp', hpp, 'profit', net - hpp, 'qty', qty, 'orders', orders, 'miss', miss
    ) order by net desc) from products), '[]'::jsonb),
    'brands', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'profit', net - hpp, 'qty', qty, 'orders', orders
    ) order by net desc) from brand_rows), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'profit', net - hpp, 'qty', qty, 'orders', orders
    ) order by net desc) from category_rows), '[]'::jsonb),
    'provinces', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'profit', net - hpp, 'qty', qty, 'orders', orders
    ) order by net desc) from provinces), '[]'::jsonb),
    'cities', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'profit', net - hpp, 'qty', qty, 'orders', orders
    ) order by net desc) from cities), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

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
      least(greatest(coalesce((p->>'pageSize')::integer, 25), 1), 2000) as size,
      coalesce(nullif(p->>'dataStatus', ''), 'active') as data_status
  ),
  filtered as (
    select
      s.line_id, s.version_id, s.no_pesanan, s.tanggal, s.order_day, s.channel, s.store_name,
      s.sku, s.product_name, s.line_qty, s.unit_price, s.sub_total, s.total_nilai_pesanan,
      s.total_diskon, s.unit_diskon, s.revenue_per_unit, s.line_revenue, s.customer_name,
      s.customer_code, s.province, s.city, s.kurir, s.status,
      s.data_status, s.content_updated_at, s.return_case, s.parent_no_pesanan, s.loss_sibling,
      st.synced_at, st.last_sync_status, st.accurate_id,
      c.unit_cost as hpp,
      coalesce(c.carried, false) as hpp_carried
    from public.v_order_lines_master s
    left join public.sync_states st on st.no_pesanan = s.no_pesanan
    left join lateral public.effective_product_cost(s.sku, s.order_day) c on true
    cross join bounds b
    where s.order_day between b.dfrom and b.dto
      and (b.data_status = 'all' or s.data_status = b.data_status)
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
          hpp_carried as "hppCarried",
          case when hpp is null then null else line_revenue - round(hpp * 1.11) * line_qty end as "grossProfit",
          data_status as "dataStatus",
          to_char(content_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as "contentUpdatedAt",
          return_case as "returnCase",
          parent_no_pesanan as "parentNoPesanan",
          loss_sibling as "lossSibling",
          to_char(synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as "syncedAt",
          (last_sync_status = 'tersinkron' or coalesce(accurate_id, '') <> '') as synced
        from filtered
        order by order_day desc, no_pesanan, line_id
        offset (select page_no from bounds) * (select size from bounds)
        limit (select size from bounds)
      ) t
    ), '[]'::jsonb)
  );
$$;

alter table public.sync_log enable row level security;
revoke all on public.sync_log from public, anon;
grant select, insert, update, delete on public.sync_log to authenticated;
grant select on public.v_order_lines_master to authenticated;
drop policy if exists "admin sync log" on public.sync_log;
create policy "admin sync log" on public.sync_log for all to authenticated using (true) with check (true);
