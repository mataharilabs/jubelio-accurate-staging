-- Read-only Accurate sync queue. Additive only.
-- Run after 0014_marketing_apply.sql.
-- Does not change existing columns, does not touch public.batches or public.sales_lines,
-- and does not update order or sync rows.
--
-- Apply by hand in the Supabase SQL Editor. Do not run this from the app,
-- do not call /api/seed, and do not apply it from CI.
--
--   1. Open Supabase → SQL Editor.
--   2. Paste this file and run it.
--   3. Confirm: select proname from pg_proc where proname in ('sync_queue', 'sync_queue_count');
--
-- Membership matches needsAccurateSync in src/lib/domain/phase3.ts:
--   not deleted, and never synced (synced_at is null) or content_updated_at > synced_at.
-- A current manual_delete that was never synced is omitted because reviewRow drops it
-- (classifyOrder returns null). Reason, failure, and Accurate action labels match
-- src/lib/domain/sync-queue.ts. The queue count is still a sequential read of current
-- versions. sync_batch_items_version_idx and order_syncs_no_pesanan_idx cover the
-- failure lookup used when Alasan is set. order_syncs_one_success only includes
-- status = 'tersinkron', so it does not cover gagal rows.

create index if not exists sync_batch_items_version_idx
  on public.sync_batch_items (version_id, created_at desc);

create index if not exists order_syncs_no_pesanan_idx
  on public.order_syncs (no_pesanan);

create or replace function public.sync_money_changed(a numeric, b numeric)
returns boolean
language sql
immutable
security invoker
set search_path = public
as $$
  select case
    when a is null and b is null then false
    when a is null or b is null then true
    else abs(a - b) > 0.5
  end;
$$;

-- Last line for a duplicate SKU wins, matching lineBySku after lines are ordered by line_no.
create or replace function public.sync_lines_differ(current_id uuid, synced_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  with cur as (
    select distinct on (sku)
      sku, qty, unit_price, unit_diskon, sub_total, revenue_per_unit
    from public.order_lines
    where version_id = current_id
    order by sku, line_no desc
  ),
  prev as (
    select distinct on (sku)
      sku, qty, unit_price, unit_diskon, sub_total, revenue_per_unit
    from public.order_lines
    where version_id = synced_id
    order by sku, line_no desc
  )
  select exists (
    select 1
    from cur
    full outer join prev using (sku)
    where prev.sku is null
      or cur.sku is null
      or cur.qty is distinct from prev.qty
      or public.sync_money_changed(prev.unit_price, cur.unit_price)
      or public.sync_money_changed(prev.unit_diskon, cur.unit_diskon)
      or public.sync_money_changed(prev.sub_total, cur.sub_total)
      or public.sync_money_changed(prev.revenue_per_unit, cur.revenue_per_unit)
  );
$$;

-- Same branches as classifyOrder / sqlClassify. Called only when a synced version id exists.
create or replace function public.sync_order_category(current_id uuid, synced_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  cur public.order_versions%rowtype;
  prev public.order_versions%rowtype;
  status_changed boolean := false;
  data_changed boolean := false;
begin
  select * into cur from public.order_versions where id = current_id;
  if not found then
    return null;
  end if;
  if cur.source = 'manual_delete' then
    if synced_id is null or not exists (select 1 from public.order_versions where id = synced_id) then
      return null;
    end if;
    return 'Batal';
  end if;
  if cur.source = 'cancel' or upper(coalesce(cur.status, '')) in ('CANCELED', 'CANCELLED', 'CANCEL') then
    return 'Batal';
  end if;
  if synced_id is null then
    return 'Baru';
  end if;
  select * into prev from public.order_versions where id = synced_id;
  if not found then
    return 'Baru';
  end if;

  status_changed := coalesce(prev.status, '') is distinct from coalesce(cur.status, '');
  data_changed :=
    coalesce(prev.channel, '') is distinct from coalesce(cur.channel, '')
    or coalesce(prev.store_name, '') is distinct from coalesce(cur.store_name, '')
    or coalesce(prev.customer_name, '') is distinct from coalesce(cur.customer_name, '')
    or coalesce(prev.province, '') is distinct from coalesce(cur.province, '')
    or coalesce(prev.city, '') is distinct from coalesce(cur.city, '')
    or coalesce(prev.kurir, '') is distinct from coalesce(cur.kurir, '')
    or prev.tanggal is distinct from cur.tanggal
    or nullif(coalesce(prev.lokasi_gudang, ''), '') is distinct from nullif(coalesce(cur.lokasi_gudang, ''), '')
    or public.sync_money_changed(prev.total_nilai_pesanan, cur.total_nilai_pesanan)
    or public.sync_money_changed(prev.total_diskon, cur.total_diskon)
    or prev.qty is distinct from cur.qty
    or public.sync_money_changed(prev.revenue, cur.revenue)
    or public.sync_lines_differ(cur.id, prev.id);

  if not status_changed and not data_changed then
    return 'Sama';
  end if;
  if upper(coalesce(cur.status, '')) = 'RETURNED' and upper(coalesce(prev.status, '')) <> 'RETURNED' then
    return 'Returned';
  end if;
  if data_changed then
    return 'Berubah';
  end if;
  if status_changed then
    return 'Status saja';
  end if;
  return 'Sama';
end;
$$;

-- Latest gagal for this version until a later success. Same rule as syncFailureForVersion.
create or replace function public.sync_failure_error(p_version uuid, p_no text, p_created timestamptz)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when latest.status = 'gagal' then coalesce(nullif(btrim(coalesce(latest.error, '')), ''), 'Sync gagal.')
    else null
  end
  from (
    select attempts.status, attempts.error
    from (
      select i.created_at as at, i.status, i.error
      from public.sync_batch_items i
      where i.version_id = p_version
        and i.status in ('berhasil', 'gagal', 'tersinkron')
      union all
      select coalesce(o.updated_at, o.synced_at), o.status, o.error
      from public.order_syncs o
      where o.no_pesanan = p_no
        and o.status in ('berhasil', 'gagal', 'tersinkron')
        and (
          p_created is null
          or coalesce(o.updated_at, o.synced_at) >= p_created
        )
    ) attempts
    order by attempts.at desc nulls last
    limit 1
  ) latest;
$$;

create or replace function public.sync_review_reason(p_category text, p_ever_synced boolean, p_failed boolean)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select case
    when p_failed then 'Gagal sync'
    when not coalesce(p_ever_synced, false) or p_category = 'Baru' then 'Belum pernah sync'
    when p_category = 'Returned' then 'Status jadi RETURNED'
    when p_category = 'Batal' then 'Status jadi CANCELED'
    when p_category = 'Berubah' then 'Data berubah'
    else coalesce(p_category, '')
  end;
$$;

create or replace function public.sync_accurate_action(
  p_status text,
  p_ever_synced boolean,
  p_order_day date,
  p_ppn date,
  p_loss_sibling boolean
)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select case
    when upper(btrim(coalesce(p_status, ''))) in ('CANCELED', 'CANCELLED', 'CANCEL') and not coalesce(p_ever_synced, false)
      then 'Tidak dikirim (cancel sebelum sync)'
    when upper(btrim(coalesce(p_status, ''))) = 'RETURNED' and not coalesce(p_ever_synced, false)
      then 'Tidak dikirim (retur sebelum sync)'
    when upper(btrim(coalesce(p_status, ''))) in ('CANCELED', 'CANCELLED', 'CANCEL')
      and p_ppn is not null and p_order_day is not null and p_order_day <= p_ppn
      then 'Tidak diproses otomatis'
    when upper(btrim(coalesce(p_status, ''))) in ('CANCELED', 'CANCELLED', 'CANCEL')
      then 'Hapus penjualan'
    when upper(btrim(coalesce(p_status, ''))) = 'RETURNED'
      and p_ppn is not null and p_order_day is not null and p_order_day <= p_ppn
      then 'Buat Retur penjualan'
    when upper(btrim(coalesce(p_status, ''))) = 'RETURNED'
      then 'Hapus penjualan'
    when not coalesce(p_ever_synced, false) and coalesce(p_loss_sibling, false)
      then 'Buat penjualan (Barang Hilang)'
    when not coalesce(p_ever_synced, false)
      then 'Buat penjualan'
    else 'Ubah penjualan'
  end;
$$;

create or replace function public.sync_queue_count()
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::bigint
  from public.order_versions v
  left join public.sync_states st on st.no_pesanan = v.no_pesanan
  where v.is_current
    and v.data_status is distinct from 'deleted'
    and (
      st.synced_at is null
      or (v.content_updated_at is not null and v.content_updated_at > st.synced_at)
    )
    and not (v.source = 'manual_delete' and st.last_synced_version_id is null);
$$;

create or replace function public.sync_queue(p jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select
      greatest(coalesce((p->>'page')::integer, 0), 0) as page_no,
      least(greatest(coalesce((p->>'pageSize')::integer, 25), 1), 200) as size,
      lower(coalesce(p->>'q', '')) as q,
      nullif(p->>'from', '')::date as dfrom,
      nullif(p->>'to', '')::date as dto,
      coalesce(p->>'store', '') as store_name,
      coalesce(p->>'channel', '') as channel,
      coalesce(p->>'reason', '') as reason,
      coalesce(p->>'action', '') as action,
      nullif(p->>'ppnReportDate', '')::date as ppn
  ),
  -- Materialize once: count, store/channel facets, and the page share this set.
  -- Reason and action expressions sit in CASE branches so the default page does not
  -- read order_lines, sync_batch_items, or order_syncs.
  scoped as materialized (
    select
      v.id,
      v.no_pesanan,
      v.version_no,
      v.import_id,
      v.source,
      v.created_at,
      v.created_by,
      v.is_current,
      v.tanggal,
      v.order_day,
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
      v.qty,
      v.revenue,
      v.data_status,
      v.content_updated_at,
      v.return_case,
      v.parent_no_pesanan,
      v.loss_sibling,
      st.last_synced_version_id,
      st.accurate_id,
      st.accurate_number,
      st.last_sync_status,
      st.decision,
      st.decision_version_id,
      st.updated_at,
      st.synced_at,
      (st.no_pesanan is not null) as has_sync_state
    from public.order_versions v
    left join public.sync_states st on st.no_pesanan = v.no_pesanan
    cross join bounds b
    where v.is_current
      and v.data_status is distinct from 'deleted'
      and (
        st.synced_at is null
        or (v.content_updated_at is not null and v.content_updated_at > st.synced_at)
      )
      and not (v.source = 'manual_delete' and st.last_synced_version_id is null)
      and (b.dfrom is null or coalesce(v.order_day, (v.tanggal at time zone 'UTC')::date) >= b.dfrom)
      and (b.dto is null or coalesce(v.order_day, (v.tanggal at time zone 'UTC')::date) <= b.dto)
      and (
        coalesce(jsonb_array_length(p->'days'), 0) = 0
        or to_char(coalesce(v.order_day, (v.tanggal at time zone 'UTC')::date), 'YYYY-MM-DD') in (select jsonb_array_elements_text(p->'days'))
      )
      and (
        b.q = ''
        or strpos(lower(concat_ws(' ', v.no_pesanan, v.customer_name, v.store_name)), b.q) > 0
      )
      and case
        when b.reason = '' then true
        else public.sync_review_reason(
          case
            when v.source = 'manual_delete' and (
              st.last_synced_version_id is null
              or not exists (select 1 from public.order_versions synced where synced.id = st.last_synced_version_id)
            ) then null
            when v.source = 'manual_delete' then 'Batal'
            when v.source = 'cancel' or upper(coalesce(v.status, '')) in ('CANCELED', 'CANCELLED', 'CANCEL') then 'Batal'
            when st.last_synced_version_id is null
              or not exists (select 1 from public.order_versions synced where synced.id = st.last_synced_version_id)
              then 'Baru'
            else public.sync_order_category(v.id, st.last_synced_version_id)
          end,
          (
            st.last_synced_version_id is not null
            and exists (select 1 from public.order_versions synced where synced.id = st.last_synced_version_id)
          ) or nullif(coalesce(st.accurate_number, ''), '') is not null,
          public.sync_failure_error(v.id, v.no_pesanan, v.created_at) is not null
        ) = b.reason
      end
      and case
        when b.action = '' then true
        else public.sync_accurate_action(
          v.status,
          (
            st.last_synced_version_id is not null
            and exists (select 1 from public.order_versions synced where synced.id = st.last_synced_version_id)
          ) or nullif(coalesce(st.accurate_number, ''), '') is not null,
          coalesce(v.order_day, (v.tanggal at time zone 'UTC')::date),
          b.ppn,
          coalesce(v.loss_sibling, false)
        ) = b.action
      end
  ),
  filtered as (
    select s.*
    from scoped s
    cross join bounds b
    where (b.store_name = '' or s.store_name = b.store_name)
      and (b.channel = '' or s.channel = b.channel)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'page', (select page_no from bounds),
    'pageSize', (select size from bounds),
    'facets', jsonb_build_object(
      'stores', coalesce((
        select jsonb_agg(x order by x)
        from (select distinct store_name as x from scoped where store_name <> '') s
      ), '[]'::jsonb),
      'channels', coalesce((
        select jsonb_agg(x order by x)
        from (select distinct channel as x from scoped where channel <> '') s
      ), '[]'::jsonb)
    ),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(t) order by coalesce(t.order_day, (t.tanggal at time zone 'UTC')::date) desc nulls last, t.no_pesanan)
      from (
        select *
        from filtered
        order by coalesce(order_day, (tanggal at time zone 'UTC')::date) desc nulls last, no_pesanan
        offset (select page_no::bigint from bounds) * (select size::bigint from bounds)
        limit (select size from bounds)
      ) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.sync_money_changed(numeric, numeric) from public, anon, authenticated;
revoke all on function public.sync_lines_differ(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sync_order_category(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sync_failure_error(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.sync_review_reason(text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.sync_accurate_action(text, boolean, date, date, boolean) from public, anon, authenticated;
revoke all on function public.sync_queue_count() from public, anon, authenticated;
revoke all on function public.sync_queue(jsonb) from public, anon, authenticated;

grant execute on function public.sync_money_changed(numeric, numeric) to service_role;
grant execute on function public.sync_lines_differ(uuid, uuid) to service_role;
grant execute on function public.sync_order_category(uuid, uuid) to service_role;
grant execute on function public.sync_failure_error(uuid, text, timestamptz) to service_role;
grant execute on function public.sync_review_reason(text, boolean, boolean) to service_role;
grant execute on function public.sync_accurate_action(text, boolean, date, date, boolean) to service_role;
grant execute on function public.sync_queue_count() to service_role;
grant execute on function public.sync_queue(jsonb) to service_role;
