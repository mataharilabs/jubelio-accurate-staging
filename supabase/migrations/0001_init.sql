-- Staging penjualan Jubelio sebelum sinkron ke Accurate Online.
-- Jalankan di Supabase SQL Editor, atau lewat CLI: supabase db push.
-- Aplikasi memakai SUPABASE_SERVICE_ROLE_KEY di server. Service role melewati RLS.
-- accurate_tokens sengaja tidak punya policy agar token tidak terbaca lewat kunci anon.

create extension if not exists pgcrypto;

create table if not exists public.batches (
  id uuid primary key default gen_random_uuid(),
  report_date date not null,
  filename text not null,
  row_count integer not null default 0,
  dropped_count integer not null default 0,
  missing_weight_count integer not null default 0,
  gross_total numeric not null default 0,
  discount_total numeric not null default 0,
  order_count integer not null default 0,
  unsynced_count integer not null default 0,
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists public.sales_lines (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  row_index integer not null,
  no_pesanan text not null,
  no_pesanan_sumber text,
  channel text not null default '',
  sku text not null default '',
  qty numeric not null,
  harga_jual numeric,
  total_diskon numeric,
  tanggal timestamptz,
  lokasi_gudang text,
  nama_toko text,
  status text,
  nama_barang text,
  source_sku text,
  is_bundle boolean not null default false,
  bundle_key text,
  bobot numeric,
  missing_weight boolean not null default false,
  is_shopee boolean not null default false,
  sync_status text not null default 'belum' check (sync_status in ('belum', 'pratinjau', 'tersinkron', 'gagal')),
  source_qty numeric not null default 0,
  source_harga numeric not null default 0,
  source_total_penjualan numeric not null default 0,
  source_diskon numeric not null default 0,
  source_diskon_lainnya numeric not null default 0,
  source_biaya_lainnya numeric not null default 0,
  source_qty_bundle numeric not null default 0
);

create index if not exists sales_lines_batch_idx on public.sales_lines (batch_id, row_index);
create index if not exists sales_lines_order_idx on public.sales_lines (batch_id, no_pesanan);
create index if not exists sales_lines_sync_idx on public.sales_lines (batch_id, sync_status);

create table if not exists public.order_syncs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  no_pesanan text not null,
  status text not null default 'belum' check (status in ('belum', 'pratinjau', 'tersinkron', 'gagal')),
  accurate_id text,
  accurate_number text,
  payload jsonb,
  response jsonb,
  error text,
  synced_at timestamptz,
  synced_by text,
  updated_at timestamptz not null default now(),
  unique (batch_id, no_pesanan)
);

-- Satu nomor pesanan hanya boleh sukses sekali, lintas batch.
create unique index if not exists order_syncs_one_success
  on public.order_syncs (no_pesanan)
  where status = 'tersinkron';

create table if not exists public.bundle_weights (
  id uuid primary key default gen_random_uuid(),
  bundle_key text not null unique,
  bobot numeric not null check (bobot >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.accurate_tokens (
  id integer primary key default 1 check (id = 1),
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  user_email text,
  updated_at timestamptz not null default now()
);

alter table public.batches enable row level security;
alter table public.sales_lines enable row level security;
alter table public.order_syncs enable row level security;
alter table public.bundle_weights enable row level security;
alter table public.app_settings enable row level security;
alter table public.accurate_tokens enable row level security;

create policy "admin batches" on public.batches for all to authenticated using (true) with check (true);
create policy "admin lines" on public.sales_lines for all to authenticated using (true) with check (true);
create policy "admin syncs" on public.order_syncs for all to authenticated using (true) with check (true);
create policy "admin weights" on public.bundle_weights for all to authenticated using (true) with check (true);
create policy "admin settings" on public.app_settings for all to authenticated using (true) with check (true);
