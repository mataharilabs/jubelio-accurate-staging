-- Unpaid orders are marketplace channels only.
-- Additive. Replaces dashboard_report and orders_page from 0016_order_fees.sql.
-- Does not touch batches, sales_lines, or order rows.
--
-- Apply by hand after 0016_order_fees.sql.
-- Confirm: select public.is_marketplace_channel('Shopee'), public.is_marketplace_channel('Website');

create or replace function public.is_marketplace_channel(p_channel text)
returns boolean
language sql
immutable
security invoker
set search_path = public
as $$
  select coalesce(btrim(p_channel), '') <> ''
    and btrim(p_channel) !~* '(website|webstore|web[[:space:]-]?store|offline|\mpos\M|internal|staff|kasir|\mmanual\M)';
$$;

revoke all on function public.is_marketplace_channel(text) from public, anon;
grant execute on function public.is_marketplace_channel(text) to authenticated, service_role;

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
      and public.is_marketplace_channel(channel)
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
      and (not b.want_unpaid or (not op.has_fee and not op.cancelled and public.is_marketplace_channel(pr.channel)))
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

grant execute on function public.dashboard_report(jsonb), public.orders_page(jsonb) to authenticated;
