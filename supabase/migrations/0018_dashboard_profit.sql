-- Dashboard profit: returns stay countable but are out of the default totals,
-- fee coverage, store x channel rows, and the GMV Max double-count guard.
-- Profit bersih = revenue - HPP (DPP x 1.11, missing = 0) - biaya platform - marketing.
-- Marketing is applied in the app. This function does not subtract it.
-- PPh 22 stays recorded and is not subtracted (reduces_profit is false).
-- TikTok "Biaya iklan GMV Max" and "Voucher GMV Max" are recorded but not
-- subtracted: that spend is already in Marketing.
--
-- Additive only. Does not touch batches, sales_lines, or order rows.
-- Apply by hand in the Supabase SQL Editor after 0017. Do not call /api/seed.
--
--   select proname from pg_proc where proname in ('dashboard_report', 'orders_page', 'sku_fee_shares');


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
      and (
        not p_profit_only
        or lower(btrim(coalesce(f.fee_name_original, ''))) not in ('biaya iklan gmv max', 'voucher gmv max')
      )
      and f.no_pesanan = any(coalesce(p_orders, '{}'::text[]))
      and exists (select 1 from lines l where l.no_pesanan = f.no_pesanan and l.sku = f.sku)
    group by f.no_pesanan, f.sku
  ),
  shared as (
    select f.no_pesanan, sum(f.amount_rp) as fee
    from public.order_fees f
    where f.deleted_at is null
      and (
        f.sku is null
        or not exists (select 1 from lines l where l.no_pesanan = f.no_pesanan and l.sku = f.sku)
      )
      and (not p_profit_only or f.reduces_profit)
      and (
        not p_profit_only
        or lower(btrim(coalesce(f.fee_name_original, ''))) not in ('biaya iklan gmv max', 'voucher gmv max')
      )
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
  include_returns boolean := coalesce(p->>'includeReturns', '') in ('1', 'true', 't');
  result jsonb;
begin
  with scoped as materialized (
    select
      s.no_pesanan,
      s.order_day,
      s.channel,
      s.store_name,
      s.status,
      s.province,
      s.city,
      s.sku,
      s.product_name,
      s.sub_total,
      s.line_revenue,
      s.line_qty,
      coalesce(br.name, '') as brand_name,
      coalesce(cat.name, '') as category_name,
      nullif(pr.name, '') as master_name,
      case when cost.unit_cost is null then 0 else round(cost.unit_cost * 1.11) * s.line_qty end as hpp_line,
      (cost.unit_cost is null) as hpp_miss,
      (
        upper(btrim(coalesce(s.status, ''))) in ('CANCELED', 'CANCELLED', 'CANCEL')
        or upper(btrim(coalesce(s.status, ''))) like 'CANCEL%'
      ) as is_cancel,
      upper(btrim(coalesce(s.status, ''))) = 'RETURNED' as is_return,
      lower(btrim(coalesce(s.channel, ''))) in ('shopee', 'tiktok', 'tokopedia', 'lazada', 'blibli') as is_mp
    from public.v_sales_current s
    left join public.products pr on pr.sku = s.sku
    left join public.brands br on br.id = pr.brand_id
    left join public.categories cat on cat.id = pr.category_id
    left join lateral public.effective_product_cost(s.sku, s.order_day) cost on true
    where s.order_day between dfrom and dto
      and (coalesce(jsonb_array_length(p->'stores'), 0) = 0 or s.store_name in (select jsonb_array_elements_text(p->'stores')))
      and (coalesce(jsonb_array_length(p->'provinces'), 0) = 0 or s.province in (select jsonb_array_elements_text(p->'provinces')))
      and (coalesce(jsonb_array_length(p->'cities'), 0) = 0 or s.city in (select jsonb_array_elements_text(p->'cities')))
      and (coalesce(jsonb_array_length(p->'couriers'), 0) = 0 or s.kurir in (select jsonb_array_elements_text(p->'couriers')))
      and (coalesce(jsonb_array_length(p->'skus'), 0) = 0 or s.sku in (select jsonb_array_elements_text(p->'skus')))
      and (coalesce(jsonb_array_length(p->'brands'), 0) = 0 or coalesce(br.name, '') in (select jsonb_array_elements_text(p->'brands')))
      and (coalesce(jsonb_array_length(p->'categories'), 0) = 0 or coalesce(cat.name, '') in (select jsonb_array_elements_text(p->'categories')))
  ),
  kept as (
    select * from scoped
    where not is_cancel
      and (include_returns or not is_return)
      and (
        coalesce(jsonb_array_length(p->'statuses'), 0) = 0
        or status in (select jsonb_array_elements_text(p->'statuses'))
      )
  ),
  filtered as (
    select * from kept
    where (
      coalesce(jsonb_array_length(p->'channels'), 0) = 0
      or channel in (select jsonb_array_elements_text(p->'channels'))
    )
  ),
  returned as (
    select * from scoped
    where is_return
      and not is_cancel
      and (
        coalesce(jsonb_array_length(p->'channels'), 0) = 0
        or channel in (select jsonb_array_elements_text(p->'channels'))
      )
  ),
  fee_ids as (
    select coalesce(array_agg(distinct no_pesanan), '{}'::text[]) as ids from kept
  ),
  sku_fees as (
    select * from public.sku_fee_shares((select ids from fee_ids), true)
  ),
  fee_kept as (
    select sf.no_pesanan, sum(sf.fee) as fee
    from sku_fees sf
    where (sf.no_pesanan, sf.sku) in (select k.no_pesanan, k.sku from kept k)
    group by sf.no_pesanan
  ),
  has_fee as (
    select f.no_pesanan
    from public.order_fees f
    where f.deleted_at is null
      and f.no_pesanan in (select no_pesanan from kept)
    group by f.no_pesanan
  ),
  recorded as (
    select no_pesanan
    from public.order_payments
    where deleted_at is null
      and no_pesanan in (select no_pesanan from filtered)
    group by no_pesanan
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
      coalesce(sum(line_qty), 0) as qty,
      bool_or(hpp_miss) as miss,
      bool_or(is_mp) as is_mp
    from filtered
    group by no_pesanan
  ),
  stats_fee as (
    select
      s.*,
      coalesce(f.fee, 0) as fee,
      (h.no_pesanan is not null) as has_fee,
      (rec.no_pesanan is not null) as has_payment,
      case when s.is_mp then s.net else 0 end as mp_net,
      case when s.is_mp and h.no_pesanan is not null then s.net else 0 end as mp_covered,
      s.net - s.hpp - coalesce(f.fee, 0) as profit
    from stats s
    left join fee_kept f on f.no_pesanan = s.no_pesanan
    left join has_fee h on h.no_pesanan = s.no_pesanan
    left join recorded rec on rec.no_pesanan = s.no_pesanan
  ),
  alloc_orders as (
    select
      no_pesanan,
      max(channel) as channel,
      max(store_name) as store_name,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp
    from kept
    group by no_pesanan
  ),
  alloc_base as (
    select
      o.store_name as store,
      o.channel,
      coalesce(sum(o.net), 0) as net,
      coalesce(sum(o.hpp), 0) as hpp,
      coalesce(sum(f.fee), 0) as fee
    from alloc_orders o
    left join fee_kept f on f.no_pesanan = o.no_pesanan
    group by o.store_name, o.channel
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
      coalesce((select sum(fee) from stats_fee), 0) as fee,
      coalesce((select sum(mp_net) from stats_fee), 0) as mp_net,
      coalesce((select sum(mp_covered) from stats_fee), 0) as mp_covered
    from filtered
  ),
  return_kpi as (
    select
      count(distinct no_pesanan) as orders,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(line_qty), 0) as qty
    from returned
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
      coalesce(sum(hpp), 0) as hpp, coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(*) as orders,
      coalesce(sum(mp_net), 0) as mp_net, coalesce(sum(mp_covered), 0) as mp_covered, bool_or(miss) as miss
    from stats_fee group by channel
  ),
  stores as (
    select store_name as key, coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp, coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(*) as orders,
      coalesce(sum(mp_net), 0) as mp_net, coalesce(sum(mp_covered), 0) as mp_covered, bool_or(miss) as miss
    from stats_fee group by store_name
  ),
  matrix as (
    select store_name as store, channel,
      coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp, coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(*) as orders,
      coalesce(sum(mp_net), 0) as mp_net, coalesce(sum(mp_covered), 0) as mp_covered, bool_or(miss) as miss
    from stats_fee
    group by store_name, channel
  ),
  product_base as (
    select sku, no_pesanan, max(channel) as channel,
      coalesce(max(master_name), max(product_name)) as name,
      max(brand_name) as brand,
      max(category_name) as category,
      coalesce(sum(sub_total), 0) as gross,
      coalesce(sum(line_revenue), 0) as net,
      coalesce(sum(hpp_line), 0) as hpp,
      coalesce(sum(line_qty), 0) as qty,
      bool_or(hpp_miss) as miss,
      max(status) as status
    from filtered
    group by sku, no_pesanan
  ),
  product_fee as (
    select b.*, coalesce(sf.fee, 0) as fee
    from product_base b
    left join sku_fees sf on sf.no_pesanan = b.no_pesanan and sf.sku = b.sku
  ),
  return_sku as (
    select sku,
      coalesce(sum(line_qty), 0) as qty,
      coalesce(sum(line_revenue), 0) as net,
      count(distinct no_pesanan) as orders
    from returned
    where coalesce(sku, '') <> ''
    group by sku
  ),
  products as (
    select p.sku, p.name, p.brand, p.category, p.gross, p.net, p.hpp, p.fee, p.qty, p.orders, p.miss,
      coalesce(r.qty, 0) as return_qty,
      coalesce(r.net, 0) as return_net,
      coalesce(r.orders, 0) as return_orders
    from (
      select sku, max(name) as name, max(brand) as brand, max(category) as category,
        coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net, coalesce(sum(hpp), 0) as hpp,
        coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(*) as orders, bool_or(miss) as miss
      from product_fee
      group by sku
    ) p
    left join return_sku r on r.sku = p.sku
  ),
  product_channels as (
    select sku, max(name) as name, channel,
      coalesce(sum(qty), 0) as qty,
      coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp,
      coalesce(sum(fee), 0) as fee,
      count(*) as orders,
      bool_or(miss) as miss
    from product_fee
    group by sku, channel
  ),
  top_profit as (
    select sku, max(name) as name,
      coalesce(sum(qty), 0) as qty,
      coalesce(sum(net), 0) as net,
      coalesce(sum(net - hpp - fee), 0) as profit,
      bool_or(miss) as miss
    from product_fee
    group by sku
    order by profit desc
    limit 10
  ),
  brand_rows as (
    select brand as key, coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp, coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty,
      count(distinct no_pesanan) as orders, bool_or(miss) as miss
    from product_fee where brand <> '' group by brand
  ),
  category_rows as (
    select category as key, coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net,
      coalesce(sum(hpp), 0) as hpp, coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty,
      count(distinct no_pesanan) as orders, bool_or(miss) as miss
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
    left join fee_kept sf on sf.no_pesanan = pl.no_pesanan
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
    left join fee_kept sf on sf.no_pesanan = cl.no_pesanan
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
      and not has_payment
      and coalesce(net, 0) <> 0
    group by channel, store_name
  )
  select jsonb_build_object(
    'kpis', (select jsonb_build_object(
      'gross', gross, 'net', net, 'disc', gross - net, 'qty', qty, 'orders', orders, 'days', days,
      'aov', case when orders = 0 then 0 else net / orders end,
      'hpp', hpp, 'fee', fee, 'marketing', 0, 'profit', net - hpp - fee,
      'missingSkus', missing_skus,
      'missingSkuSample', coalesce((select jsonb_agg(sku) from missing), '[]'::jsonb),
      'returnsOrders', coalesce((select orders from return_kpi), 0),
      'returnsNet', coalesce((select net from return_kpi), 0),
      'returnsQty', coalesce((select qty from return_kpi), 0),
      'mpNet', mp_net,
      'mpCovered', mp_covered
    ) from kpis),
    'trend', coalesce((select jsonb_agg(jsonb_build_object(
      'bucket', bucket, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee, 'orders', orders
    ) order by bucket) from trend), '[]'::jsonb),
    'channels', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee,
      'qty', qty, 'orders', orders, 'mpNet', mp_net, 'mpCovered', mp_covered, 'miss', miss
    ) order by net desc) from channels), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee,
      'qty', qty, 'orders', orders, 'mpNet', mp_net, 'mpCovered', mp_covered, 'miss', miss
    ) order by net desc) from stores), '[]'::jsonb),
    'matrix', coalesce((select jsonb_agg(jsonb_build_object(
      'store', store, 'channel', channel, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee,
      'qty', qty, 'orders', orders, 'profit', net - hpp - fee, 'mpNet', mp_net, 'mpCovered', mp_covered, 'miss', miss
    ) order by net desc) from matrix), '[]'::jsonb),
    'allocBase', coalesce((select jsonb_agg(jsonb_build_object(
      'store', store, 'channel', channel, 'net', net, 'hpp', hpp, 'fee', fee
    )) from alloc_base), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
      'sku', sku, 'key', sku, 'name', name, 'brand', brand, 'category', category,
      'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee,
      'qty', qty, 'orders', orders, 'miss', miss,
      'returnQty', return_qty, 'returnNet', return_net, 'returnOrders', return_orders
    ) order by net desc) from products), '[]'::jsonb),
    'productChannels', coalesce((select jsonb_agg(jsonb_build_object(
      'sku', sku, 'name', name, 'channel', channel, 'qty', qty, 'net', net, 'hpp', hpp, 'fee', fee,
      'profit', net - hpp - fee, 'orders', orders, 'miss', miss
    ) order by sku, net desc) from product_channels), '[]'::jsonb),
    'topProfit', coalesce((select jsonb_agg(jsonb_build_object(
      'sku', sku, 'name', name, 'qty', qty, 'net', net, 'profit', profit, 'miss', miss
    ) order by profit desc) from top_profit), '[]'::jsonb),
    'brands', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee,
      'qty', qty, 'orders', orders, 'miss', miss
    ) order by net desc) from brand_rows), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
      'key', key, 'gross', gross, 'net', net, 'hpp', hpp, 'fee', fee, 'profit', net - hpp - fee,
      'qty', qty, 'orders', orders, 'miss', miss
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
      coalesce(p->>'unpaid', '') in ('1', 'true', 't') as want_unpaid,
      coalesce(p->>'excludeReturns', '') in ('1', 'true', 't') as exclude_returns,
      coalesce(p->>'excludeCancelled', '') in ('1', 'true', 't') as exclude_cancelled
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
      and (
        coalesce(jsonb_array_length(p->'skus'), 0) = 0
        or s.sku in (select jsonb_array_elements_text(p->'skus'))
      )
      and (
        not b.exclude_returns
        or upper(btrim(coalesce(s.status, ''))) <> 'RETURNED'
      )
      and (
        not b.exclude_cancelled
        or not (
          upper(btrim(coalesce(s.status, ''))) in ('CANCELED', 'CANCELLED', 'CANCEL')
          or upper(btrim(coalesce(s.status, ''))) like 'CANCEL%'
        )
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
      coalesce(sum(amount_rp) filter (
        where reduces_profit
          and lower(btrim(coalesce(fee_name_original, ''))) not in ('biaya iklan gmv max', 'voucher gmv max')
      ), 0) as fee,
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
  raw_pay as (
    select no_pesanan
    from public.order_payments
    where deleted_at is null
      and no_pesanan in (select no_pesanan from base)
    group by no_pesanan
  ),
  order_lines_all as (
    select
      s.no_pesanan,
      s.line_revenue,
      s.status,
      case when c.unit_cost is null then 0 else round(c.unit_cost * 1.11) * s.line_qty end as hpp_amt
    from public.v_order_lines_master s
    left join lateral public.effective_product_cost(s.sku, s.order_day) c on true
    cross join bounds b
    where s.no_pesanan in (select no_pesanan from base)
      and (b.data_status = 'all' or s.data_status = b.data_status)
  ),
  order_profit as (
    select
      a.no_pesanan,
      sum(a.line_revenue) as net,
      sum(a.line_revenue) - sum(a.hpp_amt) - coalesce(max(r.fee), 0) as profit,
      coalesce(bool_or(r.has_fee), false) as has_fee,
      bool_or(pay.no_pesanan is not null) as has_payment,
      bool_or(coalesce(a.status, '') in ('CANCELED', 'CANCELLED', 'CANCEL')) as cancelled
    from order_lines_all a
    left join raw_fee r on r.no_pesanan = a.no_pesanan
    left join raw_pay pay on pay.no_pesanan = a.no_pesanan
    group by a.no_pesanan
  ),
  filtered as (
    select pr.*, op.profit as order_profit, op.has_fee as order_has_fee, op.has_payment as order_has_payment
    from priced pr
    join order_profit op on op.no_pesanan = pr.no_pesanan
    cross join bounds b
    where (not b.want_loss or (op.profit < 0 and not op.cancelled))
      and (not b.want_unpaid or (
        not op.has_fee and not op.has_payment and not op.cancelled and op.net <> 0
      ))
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
      select jsonb_agg(to_jsonb(t) order by
        case when coalesce(p->>'sort', '') = 'profit' then t."orderProfit" end asc nulls last,
        t.day desc, t."noPesanan", t."lineId")
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
          case
            when order_has_fee then 'settlement'
            when order_has_payment then 'manual'
            else null
          end as "paidVia",
          data_status as "dataStatus",
          to_char(content_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as "contentUpdatedAt",
          return_case as "returnCase",
          parent_no_pesanan as "parentNoPesanan",
          loss_sibling as "lossSibling",
          to_char(synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as "syncedAt",
          (last_sync_status = 'tersinkron' or coalesce(accurate_id, '') <> '') as synced,
          order_source as source
        from filtered
        order by
          case when coalesce(p->>'sort', '') = 'profit' then order_profit end asc nulls last,
          order_day desc, no_pesanan, line_id
        offset (select page_no from bounds) * (select size from bounds)
        limit (select size from bounds)
      ) t
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.sku_fee_shares(text[], boolean) to authenticated, service_role;
grant execute on function public.dashboard_report(jsonb), public.orders_page(jsonb) to authenticated;
