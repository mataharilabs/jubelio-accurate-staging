-- Payments, the unpaid rule, and fee SKUs that are not on the order.
-- 0016_order_fees.sql is already applied. Do not edit it. This file replaces
-- sku_fee_shares, dashboard_report, and orders_page, and adds order_payments.
-- Does not touch batches, sales_lines, or order rows. Soft-delete only.
--
-- Apply by hand after 0016. Confirm:
--   select to_regclass('public.order_payments');
--   select proname from pg_proc where proname = 'payments_apply';

-- Drop the marketplace-only helper if an earlier draft of this file was applied.
drop function if exists public.is_marketplace_channel(text);

-- Fee rows whose SKU is not among the order's line SKUs (Lazada MRI001001L-10 vs line MRI001001L,
-- Blibli 40100083 vs 40100083-01) are spread by sales share, same as a null SKU.
-- Direct rows are only (no_pesanan, sku) pairs that exist on the order lines.
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

create table if not exists public.order_payments (
  id uuid primary key default gen_random_uuid(),
  no_pesanan text not null,
  amount_rp numeric not null,
  paid_at date not null default current_date,
  method text not null default '',
  note text not null default '',
  source text not null default 'manual',
  import_id uuid,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  deleted_at timestamptz,
  deleted_by text,
  constraint order_payments_source_check check (source in ('manual', 'template'))
);

create index if not exists order_payments_active_order_idx
  on public.order_payments (no_pesanan)
  where deleted_at is null;

alter table public.order_payments enable row level security;
revoke all on public.order_payments from public, anon;
grant select, insert, update, delete on public.order_payments to authenticated, service_role;

drop policy if exists "admin order payments" on public.order_payments;
create policy "admin order payments" on public.order_payments
  for all to authenticated using (true) with check (true);

create or replace function public.payments_apply(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_actor text := coalesce(p->>'actor', '');
  v_action text := coalesce(nullif(p->>'action', ''), 'save');
  v_source text := coalesce(nullif(p->>'source', ''), 'manual');
  v_import uuid := nullif(p->>'importId', '')::uuid;
  v_rows jsonb := coalesce(p->'rows', '[]'::jsonb);
  v_inserted integer := 0;
  v_replaced integer := 0;
  v_skipped integer := 0;
begin
  if v_action = 'delete' then
    with removed as (
      update public.order_payments
      set deleted_at = now(), deleted_by = v_actor
      where deleted_at is null
        and id in (
          select value::uuid from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) as value
        )
      returning 1
    )
    select count(*) into v_replaced from removed;
    return jsonb_build_object('inserted', 0, 'replaced', coalesce(v_replaced, 0), 'skipped', 0);
  end if;

  if v_source not in ('manual', 'template') then
    raise exception 'Sumber pembayaran tidak dikenal.';
  end if;
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
    raise exception 'Tidak ada pembayaran untuk disimpan.';
  end if;

  perform pg_advisory_xact_lock(hashtext('payments'));

  with incoming as (
    select distinct on (btrim(r.no_pesanan))
      btrim(r.no_pesanan) as no_pesanan,
      r.amount_rp,
      coalesce(r.paid_at, current_date) as paid_at,
      coalesce(r.method, '') as method,
      coalesce(r.note, '') as note
    from jsonb_to_recordset(v_rows) as r(
      no_pesanan text, amount_rp numeric, paid_at date, method text, note text
    )
    where coalesce(btrim(r.no_pesanan), '') <> ''
      and r.amount_rp is not null
    order by btrim(r.no_pesanan), r.paid_at desc nulls last
  ),
  known as (
    select i.*
    from incoming i
    where exists (
      select 1 from public.order_versions v
      where v.no_pesanan = i.no_pesanan
        and v.is_current
        and v.source not in ('cancel', 'manual_delete')
        and coalesce(v.status, '') not in ('CANCELED', 'CANCELLED', 'CANCEL')
    )
  ),
  removed as (
    update public.order_payments pay
    set deleted_at = now(), deleted_by = v_actor
    where pay.deleted_at is null
      and pay.no_pesanan in (select no_pesanan from known)
    returning 1
  ),
  inserted as (
    insert into public.order_payments (
      no_pesanan, amount_rp, paid_at, method, note, source, import_id, created_by
    )
    select no_pesanan, amount_rp, paid_at, method, note, v_source, v_import, v_actor
    from known
    returning 1
  )
  select
    (select count(*) from inserted),
    (select count(*) from removed),
    (select count(*) from incoming) - (select count(*) from known)
  into v_inserted, v_replaced, v_skipped;

  return jsonb_build_object(
    'inserted', coalesce(v_inserted, 0),
    'replaced', coalesce(v_replaced, 0),
    'skipped', coalesce(v_skipped, 0)
  );
end;
$$;

revoke all on function public.payments_apply(jsonb) from public, anon, authenticated;
grant execute on function public.payments_apply(jsonb) to service_role;

create or replace function public.payments_page(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select
      lower(coalesce(p->>'q', '')) as q,
      greatest(coalesce((p->>'page')::integer, 0), 0) as page_no,
      least(greatest(coalesce((p->>'pageSize')::integer, 25), 1), 2000) as size
  ),
  listed as (
    select
      pay.id,
      pay.no_pesanan,
      coalesce(v.channel, '') as channel,
      coalesce(v.store_name, '') as store_name,
      coalesce(net.net, 0) as net,
      pay.amount_rp,
      pay.amount_rp - coalesce(net.net, 0) as diff,
      pay.paid_at,
      pay.method,
      pay.note,
      pay.created_by,
      pay.created_at
    from public.order_payments pay
    left join public.order_versions v on v.no_pesanan = pay.no_pesanan and v.is_current
    left join lateral (
      select sum(s.line_revenue) as net
      from public.v_sales_current s
      where s.no_pesanan = pay.no_pesanan
    ) net on true
    cross join bounds b
    where pay.deleted_at is null
      and (
        b.q = ''
        or lower(pay.no_pesanan) like '%' || b.q || '%'
        or lower(coalesce(v.channel, '')) like '%' || b.q || '%'
        or lower(coalesce(v.store_name, '')) like '%' || b.q || '%'
      )
  ),
  counted as (
    select count(*) as total from listed
  )
  select jsonb_build_object(
    'total', coalesce((select total from counted), 0),
    'page', (select page_no from bounds),
    'pages', greatest(1, ceil(coalesce((select total from counted), 0)::numeric / (select size from bounds))),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(t) order by t."paidAt" desc, t."noPesanan")
      from (
        select
          id,
          no_pesanan as "noPesanan",
          channel,
          store_name as "storeName",
          net,
          amount_rp as "amountRp",
          diff,
          to_char(paid_at, 'YYYY-MM-DD') as "paidAt",
          method,
          note,
          created_by as "createdBy"
        from listed
        order by paid_at desc, no_pesanan
        offset (select page_no from bounds) * (select size from bounds)
        limit (select size from bounds)
      ) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.payments_page(jsonb) from public, anon;
grant execute on function public.payments_page(jsonb) to authenticated, service_role;

create or replace function public.payment_order_lookup(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with hit as (
    select v.no_pesanan, v.channel, v.store_name, v.status
    from public.order_versions v
    where v.is_current
      and v.no_pesanan = btrim(coalesce(p->>'noPesanan', ''))
      and v.source not in ('cancel', 'manual_delete')
    limit 1
  ),
  net as (
    select coalesce(sum(s.line_revenue), 0) as net
    from public.v_sales_current s
    where s.no_pesanan = (select no_pesanan from hit)
  ),
  flags as (
    select
      exists (
        select 1 from public.order_fees f
        where f.deleted_at is null and f.no_pesanan = (select no_pesanan from hit)
      ) as has_fee,
      exists (
        select 1 from public.order_payments pay
        where pay.deleted_at is null and pay.no_pesanan = (select no_pesanan from hit)
      ) as has_payment
  )
  select case
    when not exists (select 1 from hit) then jsonb_build_object('found', false)
    else jsonb_build_object(
      'found', true,
      'noPesanan', (select no_pesanan from hit),
      'channel', (select channel from hit),
      'storeName', (select store_name from hit),
      'net', (select net from net),
      'cancelled', coalesce((select status from hit), '') in ('CANCELED', 'CANCELLED', 'CANCEL'),
      'paidVia', case
        when (select has_fee from flags) then 'settlement'
        when (select has_payment from flags) then 'manual'
        else null
      end,
      'unpaid', (select net from net) <> 0
        and not (select has_fee from flags)
        and not (select has_payment from flags)
        and coalesce((select status from hit), '') not in ('CANCELED', 'CANCELLED', 'CANCEL')
    )
  end;
$$;

revoke all on function public.payment_order_lookup(jsonb) from public, anon;
grant execute on function public.payment_order_lookup(jsonb) to authenticated, service_role;

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
  recorded as (
    select no_pesanan
    from public.order_payments
    where deleted_at is null
      and no_pesanan in (select no_pesanan from stats)
    group by no_pesanan
  ),
  stats_fee as (
    select
      s.*,
      coalesce(f.fee, 0) as fee,
      (paid_row.no_pesanan is not null) as has_fee,
      (rec.no_pesanan is not null) as has_payment,
      s.net - s.hpp - coalesce(f.fee, 0) as profit
    from stats s
    left join order_fee_visible f on f.no_pesanan = s.no_pesanan
    left join paid paid_row on paid_row.no_pesanan = s.no_pesanan
    left join recorded rec on rec.no_pesanan = s.no_pesanan
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
  products as (
    select sku, max(name) as name, max(brand) as brand, max(category) as category,
      coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net, coalesce(sum(hpp), 0) as hpp,
      coalesce(sum(fee), 0) as fee, coalesce(sum(qty), 0) as qty, count(*) as orders, bool_or(miss) as miss
    from product_fee
    group by sku
  ),
  top_profit as (
    select sku, max(name) as name,
      coalesce(sum(qty), 0) as qty,
      coalesce(sum(net), 0) as net,
      coalesce(sum(net - hpp - fee), 0) as profit,
      bool_or(miss) as miss
    from product_fee
    where coalesce(status, '') not in ('CANCELED', 'CANCELLED', 'CANCEL')
    group by sku
    order by profit desc
    limit 10
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
      and coalesce(status, '') not in ('CANCELED', 'CANCELLED', 'CANCEL')
    group by channel, store_name
  ),
  unpaid_stores as (
    select channel, store_name, count(*) as orders, sum(net) as net
    from stats_fee
    where not has_fee
      and not has_payment
      and coalesce(net, 0) <> 0
      and coalesce(status, '') not in ('CANCELED', 'CANCELLED', 'CANCEL')
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
    'topProfit', coalesce((select jsonb_agg(jsonb_build_object(
      'sku', sku, 'name', name, 'qty', qty, 'net', net, 'profit', profit, 'miss', miss
    ) order by profit desc) from top_profit), '[]'::jsonb),
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
  raw_pay as (
    select no_pesanan
    from public.order_payments
    where deleted_at is null
      and no_pesanan in (select no_pesanan from base)
    group by no_pesanan
  ),
  order_profit as (
    select
      pr.no_pesanan,
      sum(pr.line_revenue) as net,
      sum(pr.line_revenue) - sum(pr.hpp_amt) - coalesce(max(r.fee), 0) as profit,
      coalesce(bool_or(r.has_fee), false) as has_fee,
      bool_or(pay.no_pesanan is not null) as has_payment,
      bool_or(coalesce(pr.status, '') in ('CANCELED', 'CANCELLED', 'CANCEL')) as cancelled
    from priced pr
    left join raw_fee r on r.no_pesanan = pr.no_pesanan
    left join raw_pay pay on pay.no_pesanan = pr.no_pesanan
    group by pr.no_pesanan
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
        order by order_day desc, no_pesanan, line_id
        offset (select page_no from bounds) * (select size from bounds)
        limit (select size from bounds)
      ) t
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.dashboard_report(jsonb), public.orders_page(jsonb) to authenticated;
