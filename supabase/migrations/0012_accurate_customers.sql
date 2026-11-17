-- Cache of Accurate customers created or found by buyer name.
-- Additive only. Does not alter public.batches or public.sales_lines.

create table if not exists public.accurate_customers (
  name_key text primary key,
  name text not null,
  customer_no text not null,
  accurate_id text,
  created_at timestamptz not null default now()
);

alter table public.accurate_customers enable row level security;
revoke all on public.accurate_customers from public, anon;
grant select, insert, update, delete on public.accurate_customers to authenticated;
drop policy if exists "admin accurate customers" on public.accurate_customers;
create policy "admin accurate customers" on public.accurate_customers
  for all to authenticated using (true) with check (true);
