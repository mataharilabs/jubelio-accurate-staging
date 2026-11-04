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

## Fase 1

Migrasi tambahan, setelah `0002_ecommerce.sql`:

3. `supabase/migrations/0003_phase1.sql` — peran, pengguna aplikasi, audit, notifikasi, job tarikan Jubelio. Tidak membuat user auth dan tidak menyentuh `batches` / `sales_lines`.
4. `supabase/migrations/0004_jubelio_job_lease.sql` — status `queued`, kolom sewa `lease_token` / `lease_until`, fungsi `claim_jubelio_job`, dan satu job `running` pada satu waktu. Wajib sebelum cron harian berikutnya. Tidak mengubah `batches` / `sales_lines`.

Peran `Super Admin` ikut terisi. Untuk mengangkat login yang sudah ada (ganti emailnya):

```sql
insert into public.app_users (email, role_id, active)
select 'admin@example.com', id, true from public.roles where name = 'Super Admin'
on conflict (email) do update set role_id = excluded.role_id, active = true, updated_at = now();
```

Atau set `BOOTSTRAP_SUPER_ADMIN_EMAIL` ke email itu. Saat orang itu masuk, aplikasi memasangkannya ke Super Admin. Mode demo lokal, bila belum ada pengguna, akun demo diperlakukan sebagai Super Admin.

| Variabel | Fungsi |
| --- | --- |
| `JUBELIO_EMAIL` / `JUBELIO_PASSWORD` | Login API Jubelio. Tidak dicatat di log. |
| `CRON_SECRET` | Vercel mengirim `Authorization: Bearer` ini ke cron. |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | Opsional. Mengangkat email yang sudah bisa masuk. |

Jadwal cron (UTC, karena Vercel Cron memakai UTC; WIB = UTC+7):

| Jadwal | WIB | UTC |
| --- | --- | --- |
| Harian, tarik ulang H-1 s/d H-3 | 16:00 | `0 9 * * *` |
| Mingguan, Minggu, tarik ulang H-14 s/d H-28 | 23:59 | `59 16 * * 0` |

H-4 s/d H-13 tidak ditarik cron mana pun. Daftar pesanan hanya disaring `transaction_date`, tanpa filter perubahan, jadi status pesanan di celah itu tidak dicek ulang. Jendela mingguan tidak dilebarkan: H-4 s/d H-28 kira-kira 25 hari dan, bersama harian, melewati batas 60 langkah.

Tombol **Tarik dari Jubelio** di halaman Sync menjalankan rentang yang dipilih lewat pipeline impor (`source = api`). Cron Hobby hanya dua jadwal, tiap fungsi maksimal 300 detik. Satu langkah bekerja 150 detik dan berhenti 20 detik sebelum habis, lalu koneksi TLS langsung memanggil langkah berikutnya (paling banyak 60 langkah). `fetch` ke deployment yang sama ditolak Vercel dengan HTTP 508, jadi rantai tidak memakai `fetch`. Setiap hit cron atau rantai melanjutkan job `running` yang tidak tersimpan selama 10 menit, atau job `queued` bila tidak ada yang berjalan. Sewa di `jubelio_jobs` menolak dua langkah sekaligus. Jendela mingguan yang datang saat harian masih jalan masuk antrean, bukan ditimpa. Job yang masih `running` setelah 36 jam ditutup agar jadwal berikutnya tidak tertahan. Batch tanpa versi baru tidak menulis baris `imports`. Satu pesanan tetap punya satu versi berjalan.

Undangan dan lupa password memakai Supabase Auth. Redirect yang didaftarkan harus mencakup `{asal}/masuk` (asal dari host permintaan, atau `NEXT_PUBLIC_APP_URL`), misalnya `https://jubelio-accurate-staging.vercel.app/masuk` dan nanti `https://ecommerce.asiacommerce.net/masuk`. Tautan itu dibuka di `/masuk` lalu diteruskan ke `/atur-sandi`.
