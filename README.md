# Staging Penjualan Jubelio → Accurate

Aplikasi internal Asiacommerce Network untuk menampung laporan penjualan harian Jubelio yang sudah dirapikan, sebelum dikirim sebagai faktur penjualan (sales invoice) ke Accurate Online.

## Deploy to Vercel

Impor dari GitHub, bukan dari unggahan zip.

1. Di [vercel.com/new](https://vercel.com/new), pilih **Import Project** dari GitHub.
2. Pilih repositori `mataharilabs/jubelio-accurate-staging` (private). Kalau belum muncul, hubungkan akun GitHub @mataharilabs di Vercel dan izinkan akses ke repo itu.
3. Framework preset: **Next.js**. Root directory kosong (repo ini ada di root). Build command `npm run build`, output biarkan bawaan Next.js. Jangan menimpa install command.
4. Isi environment production sebelum deploy. Jangan memasukkan `.env.local` atau `data/local-db.json` ke repo. Berkas lokal itu diabaikan git; di Vercel sampel dimuat dari `samples/` hanya selama Supabase kosong, dan disk Vercel tidak awet. Untuk produksi isi Supabase.

Wajib:

| Variabel | Nilai |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | URL publik, diawali `https://` (domain Vercel atau domain sendiri). Dipakai cookie dan redirect OAuth. |
| `AUTH_SECRET` | String acak panjang. Menandatangani cookie sesi. |
| `SUPABASE_URL` | URL proyek Supabase. |
| `SUPABASE_ANON_KEY` | Kunci anon, untuk login email. |
| `SUPABASE_SERVICE_ROLE_KEY` | Kunci service role. Hanya di server. Jangan memakai prefiks `NEXT_PUBLIC_`. |

Accurate, setelah aplikasi terdaftar di area developer:

| Variabel | Nilai |
| --- | --- |
| `ACCURATE_CLIENT_ID` | Client ID. |
| `ACCURATE_CLIENT_SECRET` | Client secret. Jangan menulisnya di kode. |
| `ACCURATE_REDIRECT_URI` | Opsional. Bawaan: `{NEXT_PUBLIC_APP_URL}/api/accurate/callback`. Daftarkan URI yang sama di Accurate. |
| `ACCURATE_DATABASE_ID` | Opsional. Bisa diisi nanti dari halaman Pengaturan. |

`DEMO_ADMIN_EMAIL` dan `DEMO_ADMIN_PASSWORD` hanya untuk mode lokal saat ketiga variabel Supabase kosong. Jangan mengandalkannya di Vercel.

Setelah deploy pertama, jalankan `supabase/migrations/0001_init.sql` di SQL Editor Supabase, buat user admin di Authentication → Users, lalu daftarkan redirect Accurate `https://domain-anda/api/accurate/callback`.

Satu batch = satu tanggal laporan. Baris bundle dipecah memakai tabel bobot. Admin meninjau, mengoreksi, lalu menekan **Sync ke Accurate**. Sebelum kredensial Accurate ada, mode pratinjau menampilkan payload persis yang akan dikirim.

## Menjalankan lokal

Butuh Node.js 20+.

```bash
cp .env.example .env.local
npm install
npm run dev
```

Buka http://127.0.0.1:3847.

Selama `SUPABASE_URL`, `SUPABASE_ANON_KEY`, dan `SUPABASE_SERVICE_ROLE_KEY` kosong, aplikasi memakai:

- login demo dari `DEMO_ADMIN_EMAIL` dan `DEMO_ADMIN_PASSWORD`
- penyimpanan berkas `data/local-db.json` (tidak di-commit)

Nilai di `.env.example` hanya contoh. Untuk mesin ini, akun demo yang aktif ada di `.env.local` (biasanya `admin@asiacommerce.local` / `asiacommerce` kalau berkas itu belum diganti).

Saat pertama kali dibuka dalam mode lokal, sampel 26 Oktober 2026 (Lintas Surabaya + Lintas Jakarta) dan tabel bobot ikut dimuat. Tombol yang sama ada di dasbor.

Tes pembersihan:

```bash
npm test
npm run build
```

## Aturan rapikan

Port dari `scripts/rapikan.py`. Tes `src/lib/cleanup/rapikan.test.ts` membandingkan hasilnya dengan `samples/rapi-penjualan-2026-10-26-lintas-sby-jkt.xlsx` baris per baris.

1. Baris berstatus Pending, Paid, Canceled, Cancelled, atau Cancel dibuang.
2. Nomor pesanan keluaran = `REF`. Kalau REF kosong (POS / offline), dipakai nomor pesanan asal.
3. SKU = `item_code_bundle` bila terisi, selain itu SKU asal.
4. Qty = Qty untuk barang satuan; `qty_bundle × Qty` untuk bundle.
5. Bobot = cari kunci `SKU-item_code_bundle` di tabel bundle. Barang satuan bobotnya 1. Kalau kunci bundle tidak ada, baris **tetap disimpan** dan ditandai bobot hilang — tidak dibuang diam-diam.
6. Unit Price: selain Shopee = `Qty × Harga Jual × bobot` (nilai kotor satu baris). Shopee (`Channel` setelah di-trim dan dijadikan huruf besar sama dengan `SHOPEE`) = `Total Penjualan Per Produk × bobot ÷ Qty`. Qty pada rumus Shopee adalah jumlah paket di kolom Qty Jubelio, sebelum dikali `qty_bundle`.
7. Total Diskon, per paket untuk semua channel: bagi hasil rumus diskon dengan Qty Jubelio (jumlah paket, sebelum `qty_bundle`). Selain Shopee rumus diskonnya `(Diskon + Diskon Lainnya + Biaya Lainnya) × bobot`. Shopee = `Diskon Lainnya × bobot`.

Kolom keluaran: No Pesanan, Channel, SKU, Qty, Unit Price, Total Diskon. Konteks yang ikut tersimpan: tanggal, lokasi gudang, nama toko, status Jubelio, nomor pesanan asal, dan batch sumber.

Di Accurate field-nya tetap `detailItem[n].unitPrice`, yaitu harga per Qty keluaran (barang satuan, atau `qty_bundle × Qty` untuk bundle). Selain Shopee, Unit Price sudah berupa nilai baris, jadi `unitPrice = Unit Price / Qty`. Untuk Shopee, Unit Price adalah harga per paket, jadi `unitPrice = Unit Price × Qty paket / Qty`. `itemCashDiscount = Total Diskon × Qty paket`, jadi diskon yang dikirim tetap diskon satu baris. Angka kotor dan total diskon di dasbor menjumlahkan nilai baris, bukan kolom per paket.

## Supabase

1. Buat proyek di [supabase.com](https://supabase.com).
2. Buka SQL Editor, tempel isi `supabase/migrations/0001_init.sql`, jalankan.
3. Authentication → Providers → Email. Matikan pendaftaran publik bila hanya admin internal yang boleh masuk. Buat user lewat Authentication → Users → Add user.
4. Project Settings → API. Salin URL, anon key, dan service role key ke environment:

```bash
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Service role hanya dipakai di server, setelah sesi admin dicek. Jangan memasukkan service role ke kode klien atau `NEXT_PUBLIC_*`.

Tabel `accurate_tokens` mengaktifkan RLS tanpa policy, jadi token tidak terbaca dengan kunci anon. Tabel lain mengizinkan peran `authenticated`; aplikasi tetap menulis lewat service role.

Kalau ketiga variabel terisi, login berpindah ke Supabase Auth dan data berpindah ke Postgres. Kosongkan `DEMO_ADMIN_EMAIL` tidak wajib, tetapi sandi demo tidak lagi dipakai.

## Variabel lingkungan

| Variabel | Fungsi |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | URL publik aplikasi. Dipakai cookie dan redirect OAuth. |
| `AUTH_SECRET` | Menandatangani cookie sesi. Wajib, string acak. |
| `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD` | Login saat Supabase belum diisi. |
| `SUPABASE_URL` | URL proyek. |
| `SUPABASE_ANON_KEY` | Login email Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Tulis/baca data dari server. |
| `ACCURATE_CLIENT_ID` | Client ID aplikasi di area developer Accurate. |
| `ACCURATE_CLIENT_SECRET` | Dipakai menukar authorization code dan refresh token. |
| `ACCURATE_REDIRECT_URI` | Opsional. Bawaan: `{NEXT_PUBLIC_APP_URL}/api/accurate/callback`. |
| `ACCURATE_DATABASE_ID` | Opsional. Bisa diisi dari halaman Pengaturan. |

Langkah impor Vercel dan daftar environment ada di bagian **Deploy to Vercel** di atas. `npm run build` harus lulus sebelum deploy. Tanpa Supabase, Vercel hanya punya disk sementara dan data hilang.

## Menghubungkan Accurate

Dokumentasi: [accurate.id/api-integration](https://accurate.id/api-integration/).

1. Masuk ke area developer Accurate, daftarkan aplikasi website.
2. Catat Client ID dan Client Secret ke environment. Jangan menulisnya di kode.
3. Daftarkan redirect URI persis seperti yang tampil di halaman Pengaturan.
4. Scope yang diminta aplikasi: `sales_invoice_view sales_invoice_save`.
5. Buka Pengaturan → Hubungkan Accurate. Alurnya OAuth 2.0 authorization code: `/oauth/authorize` → tukar `code` di `/oauth/token` dengan HTTP Basic `client_id:client_secret` → simpan access token dan refresh token di server.
6. Token diperbarui otomatis bila sisa masa aktifnya kurang dari satu hari.
7. Pilih database (dari `db-list.do`) atau isi ID-nya. Sync memanggil `open-db.do`, lalu `POST {host}/accurate/api/sales-invoice/save.do` dengan header `Authorization: Bearer` dan `X-Session-ID`.
8. Samakan pemetaan:
   - channel atau nama toko → `customerNo`
   - lokasi gudang Jubelio → `branchName` dan `warehouseName`

Satu nomor pesanan menjadi satu faktur. Field baris: `detailItem[n].itemNo` (SKU), `quantity`, `unitPrice`, `itemCashDiscount`, plus `warehouseName` bila dipetakan. Header memakai `customerNo`, `transDate` (dd/MM/yyyy, zona Asia/Jakarta), `description`, dan `branchName`.

Pesanan yang sudah berstatus tersinkron tidak dikirim lagi, termasuk bila nomor yang sama sudah sukses di batch lain. "Tandai belum sinkron" hanya memperbaiki catatan di aplikasi ini; faktur yang sudah masuk Accurate tidak terhapus.

Tombol **Pratinjau** tidak memanggil Accurate. Tombol **Sync ke Accurate** menolak dengan pesan yang jelas bila token atau ID database belum ada.

## Alur harian

1. Masuk.
2. Pastikan tabel bobot masih sesuai. Unggah pembaruan dari menu Bobot bundle bila ada bundle baru.
3. Unggah ekspor Laporan Penjualan (.xlsx) dari dasbor.
4. Saring channel, lokasi, nomor pesanan, atau status sinkron. Perbaiki baris yang perlu. Baris bobot hilang harus dilengkapi di tabel bobot, lalu tekan **Hitung ulang bobot**.
5. Pratinjau payload. Kirim per pesanan, per pilihan, atau seluruh batch.
6. Unduh Excel bila perlu arsip. Lembar `Data` memakai enam kolom keluaran; lembar `Konteks` menyimpan detail tambahan.
