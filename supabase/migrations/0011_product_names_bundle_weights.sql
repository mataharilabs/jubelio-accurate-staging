-- Additive: master product names on the dashboard, ordered-SKU lookup,
-- and per-component bundle weights. Does not drop columns or rows.
-- Does not touch public.batches or public.sales_lines.
--
-- bundle_weights.bobot is kept. Allocation reads bundle_components.weight_pct.
-- Backfill (prices are not on bundle_weights, so they are not used):
--   1. If every component of a paket is found on jubelio_bundles, weight_pct is proportional to qty.
--   2. Otherwise the split is equal.
--   3. A legacy key is parsed as parent + '-' + component when jubelio or products.sku
--      matches the longest hyphen-suffix. A key that still cannot be split becomes
--      its own paket at 100%.
--   4. Percentages are truncated to 4 decimals. The last component (by component_sku)
--      absorbs the remainder so each paket totals 100.

comment on column public.bundle_weights.bobot is
  'Legacy per-item multiplier. Kept for compatibility. Allocation reads bundle_components.weight_pct.';

create table if not exists public.bundle_components (
  id uuid primary key default gen_random_uuid(),
  bundle_sku text not null,
  component_sku text not null,
  qty numeric not null default 1 check (qty > 0),
  weight_pct numeric(14, 4) not null check (weight_pct >= 0 and weight_pct <= 100),
  position integer not null default 0,
  legacy_key text,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (bundle_sku, component_sku)
);

create unique index if not exists bundle_components_legacy_key_idx
  on public.bundle_components (legacy_key)
  where legacy_key is not null;

create index if not exists bundle_components_bundle_idx
  on public.bundle_components (bundle_sku, position);

alter table public.bundle_components enable row level security;
revoke all on public.bundle_components from public, anon;
grant select, insert, update, delete on public.bundle_components to authenticated;
drop policy if exists "admin bundle components" on public.bundle_components;
create policy "admin bundle components" on public.bundle_components
  for all to authenticated using (true) with check (true);

insert into public.bundle_components (bundle_sku, component_sku, qty, weight_pct, position, legacy_key, confirmed_at)
select
  bundle_sku,
  component_sku,
  qty,
  case
    when rn = cnt then 100 - coalesce(sum(truncated) filter (where rn < cnt) over (partition by bundle_sku), 0)
    else truncated
  end as weight_pct,
  rn - 1 as position,
  legacy_key,
  confirmed_at
from (
  select
    pair.*,
    trunc(100.0 * pair.basis / sum(pair.basis) over (partition by pair.bundle_sku), 4) as truncated,
    row_number() over (partition by pair.bundle_sku order by pair.component_sku, pair.legacy_key) as rn,
    count(*) over (partition by pair.bundle_sku) as cnt
  from (
    select
      picked.bundle_sku,
      picked.component_sku,
      picked.qty,
      picked.legacy_key,
      picked.confirmed_at,
      case when mode.by_qty then picked.qty else 1 end as basis
    from (
      select distinct on (bundle_sku, component_sku)
        bundle_sku, component_sku, qty, qty_known, legacy_key, confirmed_at
      from (
        select distinct on (legacy_key)
          bundle_sku, component_sku, qty, qty_known, legacy_key, confirmed_at
        from (
          select
            b.item_code as bundle_sku,
            c.item_code as component_sku,
            greatest(coalesce(nullif(c.qty, 0), nullif(c.qty_in_base, 0), 1), 1) as qty,
            true as qty_known,
            b.item_code || '-' || c.item_code as legacy_key,
            w.confirmed_at
          from public.jubelio_bundles b
          cross join lateral jsonb_to_recordset(b.components) as c(item_code text, qty numeric, qty_in_base numeric)
          join public.bundle_weights w on w.bundle_key = b.item_code || '-' || c.item_code
          where jsonb_typeof(b.components) = 'array'
            and coalesce(b.item_code, '') <> ''
            and coalesce(c.item_code, '') <> ''
          union all
          select
            left(w.bundle_key, length(w.bundle_key) - length(p.sku) - 1) as bundle_sku,
            p.sku as component_sku,
            1::numeric as qty,
            false as qty_known,
            w.bundle_key as legacy_key,
            w.confirmed_at
          from public.bundle_weights w
          join lateral (
            select pr.sku
            from public.products pr
            where length(w.bundle_key) > length(pr.sku) + 1
              and right(w.bundle_key, length(pr.sku) + 1) = '-' || pr.sku
            order by length(pr.sku) desc
            limit 1
          ) p on true
          where not exists (
            select 1
            from public.jubelio_bundles b
            cross join lateral jsonb_to_recordset(b.components) as c(item_code text, qty numeric, qty_in_base numeric)
            where jsonb_typeof(b.components) = 'array'
              and w.bundle_key = b.item_code || '-' || c.item_code
              and coalesce(b.item_code, '') <> ''
              and coalesce(c.item_code, '') <> ''
          )
          union all
          select
            w.bundle_key as bundle_sku,
            w.bundle_key as component_sku,
            1::numeric as qty,
            false as qty_known,
            w.bundle_key as legacy_key,
            w.confirmed_at
          from public.bundle_weights w
          where not exists (
            select 1
            from public.jubelio_bundles b
            cross join lateral jsonb_to_recordset(b.components) as c(item_code text, qty numeric, qty_in_base numeric)
            where jsonb_typeof(b.components) = 'array'
              and w.bundle_key = b.item_code || '-' || c.item_code
              and coalesce(b.item_code, '') <> ''
              and coalesce(c.item_code, '') <> ''
          )
            and not exists (
              select 1
              from public.products pr
              where length(w.bundle_key) > length(pr.sku) + 1
                and right(w.bundle_key, length(pr.sku) + 1) = '-' || pr.sku
            )
        ) raw
        order by legacy_key, qty_known desc, qty desc
      ) keyed
      order by bundle_sku, component_sku, qty_known desc, qty desc
    ) picked
    join (
      select bundle_sku, bool_and(qty_known) as by_qty
      from (
        select distinct on (bundle_sku, component_sku)
          bundle_sku, qty_known
        from (
          select distinct on (legacy_key)
            bundle_sku, component_sku, qty_known, legacy_key, qty
          from (
            select
              b.item_code as bundle_sku,
              c.item_code as component_sku,
              greatest(coalesce(nullif(c.qty, 0), nullif(c.qty_in_base, 0), 1), 1) as qty,
              true as qty_known,
              b.item_code || '-' || c.item_code as legacy_key
            from public.jubelio_bundles b
            cross join lateral jsonb_to_recordset(b.components) as c(item_code text, qty numeric, qty_in_base numeric)
            join public.bundle_weights w on w.bundle_key = b.item_code || '-' || c.item_code
            where jsonb_typeof(b.components) = 'array'
              and coalesce(b.item_code, '') <> ''
              and coalesce(c.item_code, '') <> ''
            union all
            select
              left(w.bundle_key, length(w.bundle_key) - length(p.sku) - 1),
              p.sku,
              1::numeric,
              false,
              w.bundle_key
            from public.bundle_weights w
            join lateral (
              select pr.sku
              from public.products pr
              where length(w.bundle_key) > length(pr.sku) + 1
                and right(w.bundle_key, length(pr.sku) + 1) = '-' || pr.sku
              order by length(pr.sku) desc
              limit 1
            ) p on true
            where not exists (
              select 1
              from public.jubelio_bundles b
              cross join lateral jsonb_to_recordset(b.components) as c(item_code text, qty numeric, qty_in_base numeric)
              where jsonb_typeof(b.components) = 'array'
                and w.bundle_key = b.item_code || '-' || c.item_code
                and coalesce(b.item_code, '') <> ''
                and coalesce(c.item_code, '') <> ''
            )
            union all
            select w.bundle_key, w.bundle_key, 1::numeric, false, w.bundle_key
            from public.bundle_weights w
            where not exists (
              select 1
              from public.jubelio_bundles b
              cross join lateral jsonb_to_recordset(b.components) as c(item_code text, qty numeric, qty_in_base numeric)
              where jsonb_typeof(b.components) = 'array'
                and w.bundle_key = b.item_code || '-' || c.item_code
                and coalesce(b.item_code, '') <> ''
                and coalesce(c.item_code, '') <> ''
            )
              and not exists (
                select 1
                from public.products pr
                where length(w.bundle_key) > length(pr.sku) + 1
                  and right(w.bundle_key, length(pr.sku) + 1) = '-' || pr.sku
              )
          ) raw
          order by legacy_key, qty_known desc, qty desc
        ) keyed
        order by bundle_sku, component_sku, qty_known desc
      ) pairs
      group by bundle_sku
    ) mode on mode.bundle_sku = picked.bundle_sku
  ) pair
) scored
on conflict (bundle_sku, component_sku) do nothing;

create or replace function public.ordered_skus()
returns table (sku text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct l.sku
  from public.order_lines l
  where coalesce(l.sku, '') <> ''
$$;

create or replace function public.save_bundle_components(p jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  bundle text := btrim(coalesce(p->>'bundleSku', ''));
  total numeric;
begin
  if bundle = '' then
    raise exception 'SKU paket wajib diisi.';
  end if;
  if jsonb_typeof(p->'components') is distinct from 'array' or jsonb_array_length(p->'components') = 0 then
    raise exception 'Paket harus punya minimal satu komponen.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p->'components') item
    where coalesce(btrim(item->>'sku'), '') = ''
       or coalesce(nullif(item->>'qty', '')::numeric, 0) <= 0
       or coalesce(nullif(item->>'weightPct', '')::numeric, -1) < 0
  ) then
    raise exception 'SKU, qty, dan bobot komponen tidak valid.';
  end if;
  if (
    select count(distinct btrim(item->>'sku'))
    from jsonb_array_elements(p->'components') item
  ) <> jsonb_array_length(p->'components') then
    raise exception 'SKU komponen dobel di paket yang sama.';
  end if;
  select coalesce(sum((item->>'weightPct')::numeric), 0)
    into total
  from jsonb_array_elements(p->'components') item;
  if abs(round(total, 4) - 100) > 0.0001 then
    raise exception 'Total bobot harus tepat 100%%.';
  end if;
  delete from public.bundle_components where bundle_sku = bundle;
  insert into public.bundle_components (
    bundle_sku, component_sku, qty, weight_pct, position, legacy_key, confirmed_at, updated_at
  )
  select
    bundle,
    btrim(item->>'sku'),
    (item->>'qty')::numeric,
    round((item->>'weightPct')::numeric, 4),
    (ordinality - 1)::integer,
    bundle || '-' || btrim(item->>'sku'),
    now(),
    now()
  from jsonb_array_elements(p->'components') with ordinality as t(item, ordinality);
end;
$$;

grant execute on function public.ordered_skus() to authenticated;
grant execute on function public.save_bundle_components(jsonb) to authenticated;

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
    select sku, coalesce(max(master_name), max(product_name)) as name, max(brand_name) as brand, max(category_name) as category,
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
