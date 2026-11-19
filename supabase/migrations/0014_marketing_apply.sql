-- Atomic marketing overwrite and delete. Additive only.
-- Run after 0013_marketing_spend.sql, which is already applied.
-- Does not change existing columns. Does not touch batches or sales_lines.
--
-- Apply by hand in the Supabase SQL Editor. Do not run this from the app,
-- do not call /api/seed, and do not apply it from CI.
--
--   1. Open Supabase → SQL Editor.
--   2. Paste this file and run it.
--   3. Confirm: select proname from pg_proc where proname = 'marketing_apply';

-- Insert, soft-delete, and audit commit together. The advisory lock is held
-- until the transaction ends, so two uploads for the same store, platform,
-- and month cannot both pass the duplicate check.
create or replace function public.marketing_apply(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  actor text := coalesce(p->>'actor', '');
  overwrite boolean := coalesce((p->>'overwrite')::boolean, false);
  action text := coalesce(nullif(p->>'action', ''), 'save');
  upload uuid := coalesce(nullif(p->>'uploadId', '')::uuid, gen_random_uuid());
  incoming jsonb := coalesce(p->'rows', '[]'::jsonb);
  dup jsonb := '[]'::jsonb;
  inserted_count integer := 0;
  replaced_count integer := 0;
  rec record;
begin
  if action = 'delete' then
    for rec in
      select distinct s.platform, lower(s.store_name) as store_key, to_char(s.period_start, 'YYYY-MM') as month_key
      from public.marketing_spend s
      where s.deleted_at is null
        and s.id in (
          select value::uuid from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) as value
        )
      order by 1, 2, 3
    loop
      perform pg_advisory_xact_lock(hashtext('marketing:' || rec.platform || '|' || rec.store_key || '|' || rec.month_key)::bigint);
    end loop;

    with updated as (
      update public.marketing_spend
      set deleted_at = now(), deleted_by = actor
      where deleted_at is null
        and id in (
          select value::uuid from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) as value
        )
      returning *
    ),
    audited as (
      insert into public.marketing_spend_audit (
        spend_id, upload_id, action, actor, platform, store_name, period_start, period_end, snapshot
      )
      select id, upload_id, 'delete', actor, platform, store_name, period_start, period_end, to_jsonb(updated.*)
      from updated
      returning 1
    )
    select count(*) into replaced_count from audited;
    return jsonb_build_object('conflict', false, 'inserted', 0, 'replaced', coalesce(replaced_count, 0));
  end if;

  if jsonb_typeof(incoming) <> 'array' or jsonb_array_length(incoming) = 0 then
    raise exception 'Tidak ada baris valid untuk disimpan.';
  end if;

  for rec in
    select distinct r.platform, lower(r.store_name) as store_key, to_char(r.period_start, 'YYYY-MM') as month_key
    from jsonb_to_recordset(incoming) as r(platform text, store_name text, period_start date)
    order by 1, 2, 3
  loop
    perform pg_advisory_xact_lock(hashtext('marketing:' || rec.platform || '|' || rec.store_key || '|' || rec.month_key)::bigint);
  end loop;

  if exists (
    select 1
    from jsonb_to_recordset(incoming) as r(period_start date, period_end date)
    where r.period_start is null
      or r.period_end is null
      or r.period_end < r.period_start
      or date_trunc('month', r.period_start) <> date_trunc('month', r.period_end)
  ) then
    raise exception 'Tanggal mulai dan selesai harus dalam bulan yang sama.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'platform', s.platform,
    'storeName', s.store_name,
    'periodStart', to_char(s.period_start, 'YYYY-MM-DD'),
    'periodEnd', to_char(s.period_end, 'YYYY-MM-DD')
  )), '[]'::jsonb)
  into dup
  from public.marketing_spend s
  where s.deleted_at is null
    and exists (
      select 1
      from jsonb_to_recordset(incoming) as i(platform text, store_name text, period_start date, period_end date)
      where i.platform = s.platform
        and lower(i.store_name) = lower(s.store_name)
        and i.period_start <= s.period_end
        and i.period_end >= s.period_start
    );

  if jsonb_array_length(dup) > 0 and not overwrite then
    return jsonb_build_object('conflict', true, 'duplicates', dup, 'inserted', 0, 'replaced', 0);
  end if;

  insert into public.marketing_spend (
    id, upload_id, line_no, period_start, period_end, platform, store_name, campaign,
    spend, impressions, clicks, orders, ads_revenue, source, source_file, created_by, created_at
  )
  select
    r.id, upload, coalesce(r.line_no, 0), r.period_start, r.period_end, r.platform, r.store_name,
    coalesce(r.campaign, ''), coalesce(r.spend, 0), r.impressions, r.clicks, r.orders, r.ads_revenue,
    r.source, coalesce(r.source_file, ''), actor, coalesce(r.created_at, now())
  from jsonb_to_recordset(incoming) as r(
    id uuid, line_no integer, period_start date, period_end date, platform text, store_name text, campaign text,
    spend numeric, impressions numeric, clicks numeric, orders numeric, ads_revenue numeric,
    source text, source_file text, created_at timestamptz
  );
  get diagnostics inserted_count = row_count;

  if overwrite and jsonb_array_length(dup) > 0 then
    with updated as (
      update public.marketing_spend
      set deleted_at = now(), deleted_by = actor
      where deleted_at is null
        and id in (select (item->>'id')::uuid from jsonb_array_elements(dup) as item)
      returning *
    ),
    audited as (
      insert into public.marketing_spend_audit (
        spend_id, upload_id, action, actor, platform, store_name, period_start, period_end, snapshot
      )
      select id, upload, 'overwrite', actor, platform, store_name, period_start, period_end, to_jsonb(updated.*)
      from updated
      returning 1
    )
    select count(*) into replaced_count from audited;
  end if;

  insert into public.marketing_spend_audit (
    spend_id, upload_id, action, actor, platform, store_name, period_start, period_end, snapshot
  )
  select
    null, upload, 'create', actor,
    incoming->0->>'platform',
    incoming->0->>'store_name',
    (select min(period_start) from jsonb_to_recordset(incoming) as r(period_start date)),
    (select max(period_end) from jsonb_to_recordset(incoming) as r(period_end date)),
    jsonb_build_object(
      'count', inserted_count,
      'ids', (select jsonb_agg(r.id) from jsonb_to_recordset(incoming) as r(id uuid))
    );

  return jsonb_build_object(
    'conflict', false,
    'duplicates', '[]'::jsonb,
    'inserted', inserted_count,
    'replaced', coalesce(replaced_count, 0)
  );
end;
$$;

revoke all on function public.marketing_apply(jsonb) from public, anon, authenticated;
grant execute on function public.marketing_apply(jsonb) to service_role;

-- E-Commerce Admin can already view marketing. They also maintain it.
update public.roles
set permissions = (
  select coalesce(array_agg(distinct perm), '{}')
  from unnest(permissions || array['marketing.manage']::text[]) as perm
),
updated_at = now()
where name = 'E-Commerce Admin';
