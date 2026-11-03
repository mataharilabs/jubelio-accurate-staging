-- Jubelio pull queue and lease. Run after 0003_phase1.sql in the Supabase SQL editor.
-- Does not touch batches, sales_lines, or order data.
-- Existing jobs stay running/done/failed, except a second running row (if a crash left two)
-- is set back to queued so only one worker can hold the job. New columns start null.

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'jubelio_jobs'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    execute format('alter table public.jubelio_jobs drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.jubelio_jobs
  add constraint jubelio_jobs_status_check
  check (status in ('queued', 'running', 'done', 'failed'));

alter table public.jubelio_jobs add column if not exists lease_token text;
alter table public.jubelio_jobs add column if not exists lease_until timestamptz;

-- One worker at a time. If a crash ever left two running rows, keep the oldest and queue the rest.
with ranked as (
  select id, row_number() over (order by created_at, id) as n
  from public.jubelio_jobs
  where status = 'running'
)
update public.jubelio_jobs as job
set status = 'queued', lease_token = null, lease_until = null
from ranked
where job.id = ranked.id and ranked.n > 1;

create unique index if not exists jubelio_jobs_one_running
  on public.jubelio_jobs (status)
  where status = 'running';

create or replace function public.claim_jubelio_job(p_id uuid, p_token text, p_lease_seconds integer)
returns setof public.jubelio_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_lease_seconds < 1 or p_lease_seconds > 600 then
    raise exception 'lease seconds out of range';
  end if;
  return query
  update public.jubelio_jobs
  set lease_token = p_token,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = p_id
    and status = 'running'
    and (
      lease_until is null
      or lease_until < now()
      or lease_token is not distinct from p_token
    )
  returning *;
end;
$$;

revoke all on function public.claim_jubelio_job(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_jubelio_job(uuid, text, integer) to service_role;
