-- Marketplace fee import and order profit.
-- Additive only. Does not touch public.batches or public.sales_lines.
-- Does not update order_versions or order_lines. Fee rows are soft-deleted.
--
-- Apply by hand in the Supabase SQL Editor, once, after 0015_sync_queue.sql.
-- Do not run this from the app, do not call /api/seed, and do not apply it from CI.
--
--   1. Open Supabase → SQL Editor.
--   2. Paste this file and run it.
--   3. Confirm: select to_regclass('public.order_fees');
--
-- Assumptions recorded in the pull request:
--   * Unmatched order ids are not inserted.
--   * Re-import replaces active fees for the same order and marketplace.
--   * A settlement file with only zero fees stores one marker row so the order is not "unpaid".
--   * TikTok Ongkir is the seller shipping cost. Biaya layanan logistik is not added again.
--   * Missing HPP counts as 0. HPP everywhere is round(DPP * 1.11) * qty.

create table if not exists public.fee_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null default '',
  marketplace text not null,
  format text not null default '',
  uploaded_by text not null default '',
  created_at timestamptz not null default now(),
  row_count integer not null default 0,
  matched_count integer not null default 0,
  unmatched_count integer not null default 0,
  deleted_at timestamptz,
  deleted_by text,
  constraint fee_imports_marketplace_check check (marketplace in ('shopee', 'lazada', 'tiktok', 'blibli', 'template'))
);

create index if not exists fee_imports_created_idx
  on public.fee_imports (created_at desc)
  where deleted_at is null;

create table if not exists public.order_fees (
  id uuid primary key default gen_random_uuid(),
  no_pesanan text not null,
  sku text,
  fee_group text not null,
  fee_name_original text not null default '',
  marketplace text not null,
  amount_rp numeric not null,
  pct numeric,
  base text,
  reduces_profit boolean not null default true,
  allocated boolean not null default false,
  import_id uuid references public.fee_imports (id) on delete set null,
  source text not null default 'import',
  created_at timestamptz not null default now(),
  created_by text not null default '',
  deleted_at timestamptz,
  deleted_by text,
  constraint order_fees_group_check check (fee_group in (
    'Komisi',
    'Biaya layanan/program',
    'Biaya pembayaran',
    'Biaya proses pesanan',
    'Ongkir ditanggung penjual',
    'Komisi afiliasi',
    'Pajak',
    'Lain-lain'
  )),
  constraint order_fees_marketplace_check check (marketplace in ('shopee', 'lazada', 'tiktok', 'blibli', 'template')),
  constraint order_fees_source_check check (source in ('import', 'template'))
);

create index if not exists order_fees_import_idx on public.order_fees (import_id);

create index if not exists order_fees_active_order_idx
  on public.order_fees (no_pesanan)
  where deleted_at is null;

create index if not exists order_fees_active_market_idx
  on public.order_fees (marketplace, no_pesanan)
  where deleted_at is null;

create index if not exists order_fees_active_sku_idx
  on public.order_fees (sku)
  where deleted_at is null and sku is not null;

alter table public.fee_imports enable row level security;
alter table public.order_fees enable row level security;
revoke all on public.fee_imports, public.order_fees from public, anon;
grant select, insert, update, delete on public.fee_imports, public.order_fees to authenticated, service_role;

drop policy if exists "admin fee imports" on public.fee_imports;
create policy "admin fee imports" on public.fee_imports
  for all to authenticated using (true) with check (true);

drop policy if exists "admin order fees" on public.order_fees;
create policy "admin order fees" on public.order_fees
  for all to authenticated using (true) with check (true);

update public.roles
set permissions = (
  select coalesce(array_agg(distinct perm), '{}')
  from unnest(permissions || array['fees.view', 'fees.manage']::text[]) as perm
),
updated_at = now()
where name in ('Admin', 'Super Admin', 'E-Commerce Admin');

-- Profit-reducing fees per SKU. Order-level rows (sku is null) are spread by sales share.
-- The last SKU, ordered by sku, keeps the rounding remainder.
create or replace function public.sku_fee_shares(p_orders text[], p_profit_only boolean default true)
returns table (no_pesanan text, sku text, fee numeric)
language sql
stable
security invoker
set search_path = public
as $$
  with lines as (
    select v.no_pesanan, l.sku,
      sum(coalesce(l.revenue_per_unit, 0) * l.qty) as revenue,
      sum(l.qty) as qty
    from public.order_versions v
    join public.order_lines l on l.version_id = v.id
    where v.is_current
      and v.source not in ('cancel', 'manual_delete')
      and v.no_pesanan = any(coalesce(p_orders, '{}'::text[]))
      and coalesce(l.sku, '') <> ''
    group by v.no_pesanan, l.sku
  ),
  orders as (
    select no_pesanan, sum(revenue) as revenue, sum(qty) as qty, count(*) as n
    from lines
    group by no_pesanan
  ),
  direct as (
    select f.no_pesanan, f.sku, sum(f.amount_rp) as fee
    from public.order_fees f
    where f.deleted_at is null
      and f.sku is not null
      and (not p_profit_only or f.reduces_profit)
      and f.no_pesanan = any(coalesce(p_orders, '{}'::text[]))
    group by f.no_pesanan, f.sku
  ),
  shared as (
    select f.no_pesanan, sum(f.amount_rp) as fee
    from public.order_fees f
    where f.deleted_at is null
      and f.sku is null
      and (not p_profit_only or f.reduces_profit)
      and f.no_pesanan = any(coalesce(p_orders, '{}'::text[]))
    group by f.no_pesanan
  ),
  shares as (
    select
      l.no_pesanan,
      l.sku,
      case
        when o.revenue <> 0 then l.revenue / o.revenue
        when o.qty <> 0 then l.qty / o.qty
        else 1.0 / o.n
      end as share,
      row_number() over (partition by l.no_pesanan order by l.sku) as rn,
      count(*) over (partition by l.no_pesanan) as cnt
    from lines l
    join orders o on o.no_pesanan = l.no_pesanan
  ),
  shared_parts as (
    select
      s.no_pesanan,
      s.sku,
      s.rn,
      s.cnt,
      coalesce(sh.fee, 0) as total_fee,
      case when s.rn < s.cnt then round(coalesce(sh.fee, 0) * s.share, 2) else 0 end as partial
    from shares s
    left join shared sh on sh.no_pesanan = s.no_pesanan
  ),
  shared_split as (
    select
      no_pesanan,
      sku,
      case
        when total_fee = 0 then 0
        when rn < cnt then partial
        else total_fee - coalesce(sum(partial) over (partition by no_pesanan), 0)
      end as fee
    from shared_parts
  )
  select no_pesanan, sku, sum(fee) as fee
  from (
    select no_pesanan, sku, fee from direct
    union all
    select no_pesanan, sku, fee from shared_split where fee <> 0
  ) combined
  group by no_pesanan, sku;
$$;

revoke all on function public.sku_fee_shares(text[], boolean) from public, anon;
grant execute on function public.sku_fee_shares(text[], boolean) to authenticated, service_role;

create or replace function public.fees_apply(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_actor text := coalesce(p->>'actor', '');
  v_market text := coalesce(p->>'marketplace', '');
  v_source text := coalesce(nullif(p->>'source', ''), 'import');
  v_import uuid := coalesce(nullif(p->>'importId', '')::uuid, gen_random_uuid());
  v_rows jsonb := coalesce(p->'rows', '[]'::jsonb);
  v_inserted integer := 0;
  v_replaced integer := 0;
  v_skipped integer := 0;
begin
  if v_market not in ('shopee', 'lazada', 'tiktok', 'blibli', 'template') then
    raise exception 'Marketplace tidak dikenal.';
  end if;
  if v_source not in ('import', 'template') then
    raise exception 'Sumber biaya tidak dikenal.';
  end if;
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
    raise exception 'Tidak ada baris biaya untuk disimpan.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(v_rows) as r(fee_group text)
    where coalesce(r.fee_group, '') not in (
      'Komisi', 'Biaya layanan/program', 'Biaya pembayaran', 'Biaya proses pesanan',
      'Ongkir ditanggung penjual', 'Komisi afiliasi', 'Pajak', 'Lain-lain'
    )
  ) then
    raise exception 'Grup biaya tidak dikenal.';
  end if;

  perform pg_advisory_xact_lock(hashtext('fees:' || v_market));

  insert into public.fee_imports (id, file_name, marketplace, format, uploaded_by)
  values (v_import, coalesce(p->>'fileName', ''), v_market, coalesce(p->>'format', ''), v_actor)
  on conflict (id) do nothing;

  with incoming as (
    select
      btrim(r.no_pesanan) as no_pesanan,
      nullif(btrim(r.sku), '') as sku,
      r.fee_group,
      coalesce(r.fee_name, '') as fee_name,
      coalesce(r.amount_rp, 0) as amount_rp,
      r.pct,
      nullif(btrim(r.base), '') as base,
      coalesce(r.reduces_profit, r.fee_group is distinct from 'Pajak') as reduces_profit,
      coalesce(r.allocated, false) as allocated
    from jsonb_to_recordset(v_rows) as r(
      no_pesanan text, sku text, fee_group text, fee_name text, amount_rp numeric,
      pct numeric, base text, reduces_profit boolean, allocated boolean
    )
    where coalesce(btrim(r.no_pesanan), '') <> ''
  ),
  known as (
    select i.*
    from incoming i
    where exists (
      select 1 from public.order_versions v
      where v.no_pesanan = i.no_pesanan
        and v.is_current
        and v.source not in ('cancel', 'manual_delete')
    )
  ),
  removed as (
    update public.order_fees f
    set deleted_at = now(), deleted_by = v_actor
    where f.deleted_at is null
      and f.marketplace = v_market
      and f.no_pesanan in (select no_pesanan from known)
    returning 1
  ),
  inserted as (
    insert into public.order_fees (
      no_pesanan, sku, fee_group, fee_name_original, marketplace, amount_rp, pct, base,
      reduces_profit, allocated, import_id, source, created_by
    )
    select
      no_pesanan, sku, fee_group, fee_name, v_market, amount_rp, pct, base,
      reduces_profit, allocated, v_import, v_source, v_actor
    from known
    returning 1
  )
  select
    (select count(*) from inserted),
    (select count(*) from removed),
    (select count(*) from incoming) - (select count(*) from known)
  into v_inserted, v_replaced, v_skipped;

  update public.fee_imports fi
  set
    row_count = (select count(*) from public.order_fees f where f.import_id = v_import and f.deleted_at is null),
    matched_count = coalesce(nullif(p->>'matchedOrders', '')::integer, fi.matched_count),
    unmatched_count = coalesce(nullif(p->>'unmatchedOrders', '')::integer, fi.unmatched_count)
  where fi.id = v_import;

  return jsonb_build_object(
    'importId', v_import,
    'inserted', coalesce(v_inserted, 0),
    'replaced', coalesce(v_replaced, 0),
    'skipped', coalesce(v_skipped, 0)
  );
end;
$$;

revoke all on function public.fees_apply(jsonb) from public, anon, authenticated;
grant execute on function public.fees_apply(jsonb) to service_role;

create or replace function public.match_fee_orders(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with keys as (
    select distinct btrim(r.no_pesanan) as no_pesanan, nullif(btrim(r.order_id), '') as order_id
    from jsonb_to_recordset(coalesce(p->'keys', '[]'::jsonb)) as r(no_pesanan text, order_id text)
    where coalesce(btrim(r.no_pesanan), '') <> ''
  ),
  current_orders as (
    select v.no_pesanan
    from public.order_versions v
    where v.is_current
      and v.source not in ('cancel', 'manual_delete')
  ),
  exact as (
    select k.no_pesanan as input, c.no_pesanan as resolved
    from keys k
    join current_orders c on c.no_pesanan = k.no_pesanan
  ),
  prefix as (
    select k.no_pesanan as input, min(c.no_pesanan) as resolved, count(distinct c.no_pesanan) as hits
    from keys k
    join current_orders c
      on k.order_id ~ '^[0-9]+$'
     and (
       c.no_pesanan = k.order_id
       or left(c.no_pesanan, length(k.order_id) + 1) = k.order_id || '-'
     )
    where not exists (select 1 from exact e where e.input = k.no_pesanan)
    group by k.no_pesanan
  ),
  matched as (
    select input, resolved from exact
    union all
    select input, resolved from prefix where hits = 1
  )
  select jsonb_build_object(
    'matched', coalesce((select jsonb_agg(jsonb_build_object('input', input, 'resolved', resolved)) from matched), '[]'::jsonb),
    'missing', coalesce((
      select jsonb_agg(k.no_pesanan order by k.no_pesanan)
      from keys k
      where not exists (select 1 from matched m where m.input = k.no_pesanan)
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.match_fee_orders(jsonb) from public, anon;
grant execute on function public.match_fee_orders(jsonb) to authenticated, service_role;

create or replace function public.fee_report(p jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  dfrom date := coalesce(nullif(p->>'from', '')::date, date '0001-01-01');
  dto date := coalesce(nullif(p->>'to', '')::date, date '9999-12-31');
  kind text := coalesce(p->>'kind', 'group');
  page_no integer := greatest(coalesce((p->>'page')::integer, 0), 0);
  size integer := least(greatest(coalesce((p->>'pageSize')::integer, 25), 1), 5000);
  result jsonb;
begin
  if kind not in ('affiliate', 'group', 'sku') then
    raise exception 'Jenis laporan biaya tidak dikenal.';
  end if;
  with orders as (
    select v.no_pesanan, v.channel, v.store_name, v.order_day
    from public.order_versions v
    where v.is_current
      and v.source not in ('cancel', 'manual_delete')
      and coalesce(v.data_status, 'active') = 'active'
      and v.order_day between dfrom and dto
      and (coalesce(jsonb_array_length(p->'channels'), 0) = 0 or v.channel in (select jsonb_array_elements_text(p->'channels')))
      and (coalesce(jsonb_array_length(p->'stores'), 0) = 0 or v.store_name in (select jsonb_array_elements_text(p->'stores')))
  ),
  affiliate_rows as (
    select
      o.no_pesanan,
      o.channel,
      o.store_name,
      o.order_day,
      sum(f.amount_rp) as amount,
      string_agg(distinct f.fee_name_original, ', ' order by f.fee_name_original) as fee_name
    from orders o
    join public.order_fees f on f.no_pesanan = o.no_pesanan and f.deleted_at is null and f.fee_group = 'Komisi afiliasi'
    group by o.no_pesanan, o.channel, o.store_name, o.order_day
    having sum(f.amount_rp) <> 0
  ),
  group_rows as (
    select o.channel, o.store_name, f.fee_group, sum(f.amount_rp) as amount, count(distinct o.no_pesanan) as orders
    from orders o
    join public.order_fees f on f.no_pesanan = o.no_pesanan and f.deleted_at is null
    group by o.channel, o.store_name, f.fee_group
  ),
  sku_rows as (
    select o.channel, o.store_name, sf.sku, sum(sf.fee) as amount, count(distinct sf.no_pesanan) as orders
    from public.sku_fee_shares((select coalesce(array_agg(no_pesanan), '{}'::text[]) from orders), false) sf
    join orders o on o.no_pesanan = sf.no_pesanan
    group by o.channel, o.store_name, sf.sku
  ),
  shaped as (
    select
      case kind
        when 'affiliate' then jsonb_build_object(
          'noPesanan', a.no_pesanan, 'channel', a.channel, 'storeName', a.store_name,
          'day', to_char(a.order_day, 'YYYY-MM-DD'), 'amount', a.amount, 'feeName', a.fee_name
        )
        when 'sku' then jsonb_build_object(
          'channel', s.channel, 'storeName', s.store_name, 'sku', s.sku, 'amount', s.amount, 'orders', s.orders
        )
        else jsonb_build_object(
          'channel', g.channel, 'storeName', g.store_name, 'feeGroup', g.fee_group, 'amount', g.amount, 'orders', g.orders
        )
      end as item,
      case kind when 'affiliate' then a.amount when 'sku' then s.amount else g.amount end as sort_amount
    from affiliate_rows a
    full join group_rows g on false
    full join sku_rows s on false
    where case kind when 'affiliate' then a.no_pesanan is not null when 'sku' then s.sku is not null else g.fee_group is not null end
  ),
  counted as (
    select count(*) as total from shaped
  ),
  page as (
    select item, row_number() over (order by sort_amount desc nulls last) as n
    from shaped
    order by sort_amount desc nulls last
    offset page_no * size
    limit size
  )
  select jsonb_build_object(
    'total', coalesce((select total from counted), 0),
    'page', page_no,
    'pages', greatest(1, ceil(coalesce((select total from counted), 0)::numeric / size)),
    'rows', coalesce((select jsonb_agg(item order by n) from page), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.fee_report(jsonb) from public, anon;
grant execute on function public.fee_report(jsonb) to authenticated, service_role;

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
      nullif(pr.name, '') as master_name,
      cost.unit_cost as dpp,
      coalesce(cost.carried, false) as carried,
      case when cost.unit_cost is null then 0 else round(cost.unit_cost * 1.11) * s.line_qty end as hpp_line,
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
  fee_ids as (
    select coalesce(array_agg(distinct no_pesanan), '{}'::text[]) as ids from filtered
  ),
  sku_fees as (
    select * from public.sku_fee_shares((select ids from fee_ids), true)
  ),
  order_fee_visible as (
    select sf.no_pesanan, sum(sf.fee) as fee
    from sku_fees sf
    where (sf.no_pesanan, sf.sku) in (select f.no_pesanan, f.sku from filtered f)
    group by sf.no_pesanan
  ),
  paid as (
    select f.no_pesanan
    from public.order_fees f
    where f.deleted_at is null
      and f.no_pesanan in (select no_pesanan from filtered)
    group by f.no_pesanan
  ),
  stats as (
    select
      no_pesanan,
      max(channel) as channel,
      max(store_name) as store_name,
      max(status) as status,
      max(order_day) as order_day,
      coalesce(sum(sub_total), 0) as gross,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp,
      coalesce(sum(line_qty), 0) as qty
    from filtered
    group by no_pesanan
  ),
  stats_fee as (
    select
      s.*,
      coalesce(f.fee, 0) as fee,
      (paid_row.no_pesanan is not null) as has_fee,
      s.net - s.hpp - coalesce(f.fee, 0) as profit
    from stats s
    left join order_fee_visible f on f.no_pesanan = s.no_pesanan
    left join paid paid_row on paid_row.no_pesanan = s.no_pesanan
  ),
  kpis as (
    select
      coalesce(sum(sub_total), 0) as gross,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(line_qty), 0) as qty,
      count(distinct no_pesanan) as orders,
      count(distinct order_day) as days,
      coalesce(sum(hpp_line), 0) as hpp,
      count(distinct sku) filter (where hpp_miss) as missing_skus,
      coalesce((select sum(fee) from stats_fee), 0) as fee
    from filtered
  ),
  trend as (
    select
      case
        when gran = 'month' then to_char(date_trunc('month', order_day), 'YYYY-MM')
        when gran = 'week' then to_char(date_trunc('week', order_day)::date, 'YYYY-MM-DD')
        else to_char(order_day, 'YYYY-MM-DD')
      end as bucket,
      coalesce(sum(gross), 0) as gross,
      coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp,
      coalesce(sum(fee), 0) as fee,
      count(*) as orders
    from stats_fee
    where order_day is not null
    group by 1
  ),
  channels as (
    select channel as key, coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp, coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(*) as orders
    from stats_fee group by channel
  ),
  stores as (
    select store_name as key, coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp, coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(*) as orders
    from stats_fee group by store_name
  ),
  product_base as (
    select sku, no_pesanan,
      coalesce(max(master_name), max(product_name)) as name,
      max(brand_name) as brand,
      max(category_name) as category,
      coalesce(sum(sub_total), 0) as gross,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp,
      coalesce(sum(line_qty), 0) as qty,
      bool_or(hpp_miss) as miss
    from filtered
    group by sku, no_pesanan
  ),
  product_fee as (
    select b.*, coalesce(sf.fee, 0) as fee
    from product_base b
    left join sku_fees sf on sf.no_pesanan = b.no_pesanan and sf.sku = b.sku
  ),
  products as (
    select sku, max(name) as name, max(brand) as brand, max(category) as category,
      coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net, coalesce(sum(hpp), 0) as hpp,
      coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(*) as orders, bool_or(miss) as miss
    from product_fee
    group by sku
  ),
  brand_rows as (
    select brand as key, coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp, coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty,
      count(distinct no_pesanan) as orders
    from product_fee where brand <> '' group by brand
  ),
  category_rows as (
    select category as key, coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp, coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty,
      count(distinct no_pesanan) as orders
    from product_fee where category <> '' group by category
  ),
  prov_lines as (
    select province as key, no_pesanan, sum(sub_total) as gross, sum(line_revenue) as net, sum(hpp_line) as hpp, sum(line_qty) as qty
    from filtered group by province, no_pesanan
  ),
  prov_share as (
    select pl.key, pl.no_pesanan, pl.gross, pl.net, pl.hpp, pl.qty,
      coalesce(sf.fee, 0) * case when st.net <> 0 then pl.net / st.net else 1.0 / count(*) over (partition by pl.no_pesanan) end as fee
    from prov_lines pl
    join stats st on st.no_pesanan = pl.no_pesanan
    left join order_fee_visible sf on sf.no_pesanan = pl.no_pesanan
  ),
  provinces as (
    select key, coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net, coalesce(sum(hpp), 0) as hpp,
      coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(distinct no_pesanan) as orders
    from prov_share group by key
  ),
  city_lines as (
    select city as key, no_pesanan, sum(sub_total) as gross, sum(line_revenue) as net, sum(hpp_line) as hpp, sum(line_qty) as qty
    from filtered group by city, no_pesanan
  ),
  city_share as (
    select cl.key, cl.no_pesanan, cl.gross, cl.net, cl.hpp, cl.qty,
      coalesce(sf.fee, 0) * case when st.net <> 0 then cl.net / st.net else 1.0 / count(*) over (partition by cl.no_pesanan) end as fee
    from city_lines cl
    join stats st on st.no_pesanan = cl.no_pesanan
    left join order_fee_visible sf on sf.no_pesanan = cl.no_pesanan
  ),
  cities as (
    select key, coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net, coalesce(sum(hpp), 0) as hpp,
      coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(distinct no_pesanan) as orders
    from city_share group by key
  ),
  missing as (
    select sku from filtered where hpp_miss group by sku order by sku limit 4
  ),
  loss_stores as (
    select channel, store_name, count(*) as orders, sum(profit) as loss
    from stats_fee
    where profit < 0
    group by channel, store_name
  ),
  unpaid_stores as (
    select channel, store_name, count(*) as orders, sum(net) as net
    from stats_fee
    where not has_fee
      and upper(coalesce(status, '')) not like 'CANCEL%'
    group by channel, store_name
  )
  select jsonb_build_object(
    'kpis', (select jsonb_build_object(
      'gross', gross, 'net', net, 'disc', gross - net, 'qty', qty, 'orders', orders, 'days', days,
      'aov', case when orders = 0 then 0 else net / orders end,
      'hpp', hpp, 'fee', fee, 'marketing', 0, 'profit', net - hpp - fee,
      'missingSkus', missing_skus,
      'missingSkuSample', coalesce((select jsonb_agg(sku) from missing), '[]'::jsonb)
    ) from kpis),
    'trend', coalesce((select jsonb_agg(jsonb_build_object(
      'bucket', bucket, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee, 'orders', orders
    ) order by bucket) from trend), '[]'::jsonb),
    'channels', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee, 'qty', qty, 'orders', orders
    ) order by net desc) from channels), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee, 'qty', qty, 'orders', orders
    ) order by net desc) from stores), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
      'sku', sku, 'key', sku, 'name', name, 'brand', brand, 'category', category,
      'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee, 'qty', qty, 'orders', orders, 'miss', miss
    ) order by net desc) from products), '[]'::jsonb),
    'brands', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee, 'qty', qty, 'orders', orders
    ) order by net desc) from brand_rows), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee, 'qty', qty, 'orders', orders
    ) order by net desc) from category_rows), '[]'::jsonb),
    'provinces', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee, 'qty', qty, 'orders', orders
    ) order by net desc) from provinces), '[]'::jsonb),
    'cities', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee, 'qty', qty, 'orders', orders
    ) order by net desc) from cities), '[]'::jsonb),
    'lossStores', coalesce((select jsonb_agg(jsonb_build_object(
      'channel', channel, 'storeName', store_name, 'orders', orders, 'loss', loss
    ) order by loss asc) from loss_stores), '[]'::jsonb),
    'unpaidStores', coalesce((select jsonb_agg(jsonb_build_object(
      'channel', channel, 'storeName', store_name, 'orders', orders, 'net', net
    ) order by net desc) from unpaid_stores), '[]'::jsonb)
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
      coalesce(nullif(p->>'dataStatus', ''), 'active') as data_status,
      coalesce(p->>'sync', '') as sync_mode,
      coalesce(p->>'loss', '') in ('1', 'true', 't') as want_loss,
      coalesce(p->>'unpaid', '') in ('1', 'true', 't') as want_unpaid
  ),
  base as (
    select
      s.line_id, s.version_id, s.no_pesanan, s.tanggal, s.order_day, s.channel, s.store_name,
      s.sku, s.product_name, s.line_qty, s.unit_price, s.sub_total, s.total_nilai_pesanan,
      s.total_diskon, s.unit_diskon, s.revenue_per_unit, s.line_revenue, s.customer_name,
      s.customer_code, s.province, s.city, s.kurir, s.status,
      s.data_status, s.content_updated_at, s.return_case, s.parent_no_pesanan, s.loss_sibling,
      st.synced_at, st.last_sync_status, st.accurate_id,
      c.unit_cost as hpp,
      coalesce(c.carried, false) as hpp_carried,
      (c.unit_cost is null) as hpp_missing,
      case when c.unit_cost is null then 0 else round(c.unit_cost * 1.11) * s.line_qty end as hpp_amt,
      ov.source as order_source
    from public.v_order_lines_master s
    left join public.order_versions ov on ov.id = s.version_id
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
        coalesce(jsonb_array_length(p->'channels'), 0) = 0
        or s.channel in (select jsonb_array_elements_text(p->'channels'))
      )
      and (
        coalesce(jsonb_array_length(p->'stores'), 0) = 0
        or s.store_name in (select jsonb_array_elements_text(p->'stores'))
      )
      and (
        b.sync_mode = ''
        or (
          b.sync_mode = 'need'
          and s.data_status <> 'deleted'
          and (st.synced_at is null or s.content_updated_at > st.synced_at)
        )
        or (
          b.sync_mode = 'done'
          and st.synced_at is not null
          and (s.content_updated_at is null or s.content_updated_at <= st.synced_at)
        )
      )
      and (
        b.q = ''
        or lower(concat_ws(' ', s.no_pesanan, s.sku, s.product_name, s.customer_name, s.store_name, s.city, s.channel)) like '%' || b.q || '%'
      )
  ),
  ids as (
    select coalesce(array_agg(distinct no_pesanan), '{}'::text[]) as ids from base
  ),
  sku_fees as (
    select * from public.sku_fee_shares((select ids from ids), true)
  ),
  raw_fee as (
    select no_pesanan,
      coalesce(sum(amount_rp) filter (where reduces_profit), 0) as fee,
      count(*) > 0 as has_fee
    from public.order_fees
    where deleted_at is null
      and no_pesanan in (select no_pesanan from base)
    group by no_pesanan
  ),
  lined as (
    select
      b.*,
      coalesce(sf.fee, 0) as sku_fee,
      sum(b.line_revenue) over (partition by b.no_pesanan, b.sku) as sku_revenue,
      count(*) over (partition by b.no_pesanan, b.sku) as sku_lines
    from base b
    left join sku_fees sf on sf.no_pesanan = b.no_pesanan and sf.sku = b.sku
  ),
  priced as (
    select
      l.*,
      case
        when l.sku_revenue <> 0 then l.sku_fee * l.line_revenue / l.sku_revenue
        when l.sku_lines > 0 then l.sku_fee / l.sku_lines
        else 0
      end as line_fee
    from lined l
  ),
  order_profit as (
    select
      pr.no_pesanan,
      sum(pr.line_revenue) - sum(pr.hpp_amt) - coalesce(max(r.fee), 0) as profit,
      coalesce(bool_or(r.has_fee), false) as has_fee,
      bool_or(upper(coalesce(pr.status, '')) like 'CANCEL%') as cancelled
    from priced pr
    left join raw_fee r on r.no_pesanan = pr.no_pesanan
    group by pr.no_pesanan
  ),
  filtered as (
    select pr.*, op.profit as order_profit
    from priced pr
    join order_profit op on op.no_pesanan = pr.no_pesanan
    cross join bounds b
    where (not b.want_loss or op.profit < 0)
      and (not b.want_unpaid or (not op.has_fee and not op.cancelled))
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
          hpp_missing as "hppMissing",
          line_revenue - hpp_amt - line_fee as "grossProfit",
          order_profit as "orderProfit",
          data_status as "dataStatus",
          to_char(content_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as "contentUpdatedAt",
          return_case as "returnCase",
          parent_no_pesanan as "parentNoPesanan",
          loss_sibling as "lossSibling",
          to_char(synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as "syncedAt",
          (last_sync_status = 'tersinkron' or coalesce(accurate_id, '') <> '') as synced,
          order_source as source
        from filtered
        order by order_day desc, no_pesanan, line_id
        offset (select page_no from bounds) * (select size from bounds)
        limit (select size from bounds)
      ) t
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.orders_page(jsonb) to authenticated;

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
      s.no_pesanan,
      s.sku,
      coalesce(nullif(pr.name, ''), s.product_name, s.sku) as product_name,
      coalesce(c.name, '(Tanpa kategori)') as category_name,
      coalesce(b.name, '(Tanpa brand)') as brand_name,
      s.line_qty,
      s.line_revenue,
      cost.unit_cost,
      coalesce(cost.carried, false) as carried,
      case when cost.unit_cost is null then 0 else round(cost.unit_cost * 1.11) * s.line_qty end as hpp_amt,
      (cost.unit_cost is null) as miss
    from public.v_sales_current s
    left join public.products pr on pr.sku = s.sku
    left join public.categories c on c.id = pr.category_id
    left join public.brands b on b.id = pr.brand_id
    left join lateral public.effective_product_cost(s.sku, s.order_day) cost on true
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
  fee_ids as (
    select coalesce(array_agg(distinct no_pesanan), '{}'::text[]) as ids from filtered
  ),
  sku_fees as (
    select * from public.sku_fee_shares((select ids from fee_ids), true)
  ),
  per_order as (
    select
      f.sku,
      f.no_pesanan,
      max(f.product_name) as name,
      max(f.category_name) as category,
      max(f.brand_name) as brand,
      coalesce(sum(f.line_qty), 0) as qty,
      coalesce(sum(f.line_revenue), 0) as net,
      coalesce(sum(f.hpp_amt), 0) as hpp,
      bool_or(f.miss) as miss,
      bool_or(f.carried) as carried,
      bool_or(f.unit_cost is not null) as has_hpp,
      coalesce(max(sf.fee), 0) as fee
    from filtered f
    left join sku_fees sf on sf.no_pesanan = f.no_pesanan and sf.sku = f.sku
    group by f.sku, f.no_pesanan
  ),
  products as (
    select
      sku,
      max(name) as name,
      max(category) as category,
      max(brand) as brand,
      coalesce(sum(qty), 0) as qty,
      coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp,
      coalesce(sum(net - hpp - fee), 0) as profit,
      bool_or(miss) as miss,
      bool_or(carried) as carried,
      bool_or(has_hpp) as has_hpp
    from per_order
    group by sku
  ),
  brands as (
    select brand as name, coalesce(sum(net), 0) as net, coalesce(sum(qty), 0) as qty, coalesce(sum(net - hpp - fee), 0) as profit
    from per_order
    group by brand
  ),
  categories as (
    select category as name, coalesce(sum(net), 0) as net, coalesce(sum(qty), 0) as qty, coalesce(sum(net - hpp - fee), 0) as profit
    from per_order
    group by category
  ),
  coverage as (
    select count(*) as skus, count(*) filter (where has_hpp) as with_hpp from products
  )
  select jsonb_build_object(
    'coverage', (select jsonb_build_object(
      'skus', skus,
      'withHpp', with_hpp,
      'percent', case when skus = 0 then 0 else round(100.0 * with_hpp / skus, 1) end
    ) from coverage),
    'byNet', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'name', name, 'category', category, 'brand', brand, 'qty', qty, 'net', net, 'hpp', hpp, 'profit', profit, 'carried', carried, 'miss', miss) order by net desc) from products), '[]'::jsonb),
    'byQty', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'name', name, 'category', category, 'brand', brand, 'qty', qty, 'net', net, 'hpp', hpp, 'profit', profit, 'carried', carried, 'miss', miss) order by qty desc) from products), '[]'::jsonb),
    'byProfit', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'name', name, 'category', category, 'brand', brand, 'qty', qty, 'net', net, 'hpp', hpp, 'profit', profit, 'carried', carried, 'miss', miss) order by profit desc) from products), '[]'::jsonb),
    'brandsByNet', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'net', net, 'profit', profit) order by net desc) from brands), '[]'::jsonb),
    'brandsByProfit', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'net', net, 'profit', profit) order by profit desc) from brands), '[]'::jsonb),
    'categoriesByNet', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'net', net, 'profit', profit) order by net desc) from categories), '[]'::jsonb),
    'categoriesByProfit', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'net', net, 'profit', profit) order by profit desc) from categories), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

grant execute on function public.dashboard_report(jsonb), public.orders_page(jsonb), public.product_report(jsonb) to authenticated;
