-- External continuation for the Jubelio pull. Run after 0004 in the SQL editor.
-- Does not touch batches, sales_lines, jubelio_jobs, or any order data.
-- Does not store CRON_SECRET. Insert that into Vault yourself after this file.
--
-- If create extension is denied, enable pg_cron and pg_net in
-- Dashboard → Database → Extensions, then run this file again.

create extension if not exists pg_net;
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'jubelio-continue') then
    perform cron.unschedule('jubelio-continue');
  end if;
end $$;

-- Every 5 minutes. The route resumes a running or queued job and does nothing
-- when none is open, so this does not start a new date window.
-- The secret is read from Vault at run time. Until cron_secret exists, the
-- job returns without calling the app.
select cron.schedule(
  'jubelio-continue',
  '*/5 * * * *',
  $job$
  do $cron$
  declare
    secret text;
  begin
    select decrypted_secret into secret
    from vault.decrypted_secrets
    where name = 'cron_secret'
    limit 1;
    if coalesce(secret, '') = '' then
      return;
    end if;
    perform net.http_get(
      url := 'https://ecommerce.asiacommerce.id/api/cron/jubelio/continue',
      headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
      timeout_milliseconds := 15000
    );
  end
  $cron$;
  $job$
);
