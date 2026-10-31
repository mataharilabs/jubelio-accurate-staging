# Jubelio → Accurate

Admin penjualan internal: impor ekspor Jubelio, rapikan ke 17 kolom yang sudah disetujui, tinjau di dashboard, lalu kirim sales invoice ke Accurate Online.

## Menjalankan

```bash
cp .env.example .env.local
npm install
npm test
npm run dev
```

Selama `SUPABASE_URL`, `SUPABASE_ANON_KEY`, dan `SUPABASE_SERVICE_ROLE_KEY` kosong, login memakai `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD` dan data tersimpan di `data/store-v2.json`. Pertama kali dibuka, mapping dan empat berkas rapi 26–29 Oktober 2026 dimuat.

## Migrasi Supabase

Jalankan berurutan di SQL Editor proyek `uqzzmrugbuxeivawqfld`. Jangan menganggap migrasi sudah terpasang.

1. `supabase/migrations/0001_init.sql` — token Accurate, pengaturan, tabel lama.
2. `supabase/migrations/0002_ecommerce.sql` — pesanan berversi, mapping, antrian sync, view `v_sales_current`, RPC `dashboard_report` dan `dashboard_options`.

`0002` menambahkan `order_lines.unit_cogs` dan tabel `sku_costs` (masih kosong) supaya laba kotor bisa ditambah nanti: revenue − unit COGS × qty.

## Variabel lingkungan

| Variabel | Fungsi |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | URL publik. Cookie dan redirect OAuth. |
| `AUTH_SECRET` | Menandatangani cookie sesi. |
| `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD` | Login saat Supabase kosong. |
| `SUPABASE_URL` | URL proyek. Alias: `NEXT_PUBLIC_SUPABASE_URL`. |
| `SUPABASE_ANON_KEY` | Login email. Alias: `NEXT_PUBLIC_SUPABASE_ANON_KEY`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Akses server. Jangan diberi prefiks `NEXT_PUBLIC_`. |
| `ACCURATE_CLIENT_ID` / `ACCURATE_CLIENT_SECRET` | OAuth Accurate. Kosong = status belum terhubung. |
| `ACCURATE_REDIRECT_URI` | Opsional. Bawaan `{NEXT_PUBLIC_APP_URL}/api/accurate/callback`. |
| `ACCURATE_DATABASE_ID` | Opsional. Bisa diisi di Koneksi Accurate. |

## Pembersihan

`src/lib/cleanup/rapikan.ts` memport `scripts/rapikan.py`. Tes:

```bash
npm test
```

`src/lib/cleanup/rapikan.test.ts` membandingkan hasil pada `samples/laporan-penjualan-2026-10-27-30-raw.xlsx` untuk 2026-10-28 dan 2026-10-29 dengan `samples/rapi-penjualan-2026-10-28.xlsx` dan `samples/rapi-penjualan-2026-10-29.xlsx`.

Nilai channel, toko, provinsi, kota, atau bobot yang belum ada di tabel mapping ditandai untuk review. Tidak ada tebakan diam-diam. Kota kosong menjadi "Tanpa nama kota". Jubelio-POS memakai kota dari lokasi: Lintas Sby → Surabaya, Lintas Jkt → Jakarta.

Impor Excel yang sudah rapi (17 kolom) lewat Sync ke Accurate, selain unggah mentah.
