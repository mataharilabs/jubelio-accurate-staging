"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import type { AppSettings, CustomerMapping, LocationMapping } from "@/lib/db/types";

type AccurateInfo = {
  configured: boolean;
  missing: string[];
  connected: boolean;
  userEmail: string | null;
  expiresAt: string | null;
  redirectUri: string;
  databaseIdFromEnv: boolean;
};

export function SettingsPanel() {
  const params = useSearchParams();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [accurate, setAccurate] = useState<AccurateInfo | null>(null);
  const [databases, setDatabases] = useState<{ id: string; alias: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    setError(null);
    api<{ settings: AppSettings; accurate: AccurateInfo }>("/api/settings")
      .then((result) => {
        setSettings(result.settings);
        setAccurate(result.accurate);
        if (result.accurate.connected) {
          api<{ databases: { id: string; alias: string }[] }>("/api/accurate/databases")
            .then((list) => setDatabases(list.databases))
            .catch(() => setDatabases([]));
        }
      })
      .catch((err: Error) => setError(err.message));
  }

  useEffect(load, []);

  useEffect(() => {
    const flag = params.get("accurate");
    if (flag === "terhubung") setNotice("Accurate terhubung. Pilih database lalu simpan pemetaan.");
    if (flag === "gagal") setNotice("Otorisasi Accurate gagal atau dibatalkan. Coba lagi.");
  }, [params]);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSettings(saved);
      setNotice("Pengaturan disimpan.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Gagal menyimpan.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await api("/api/accurate/disconnect", { method: "POST" });
    setNotice("Koneksi Accurate diputus. Token dihapus dari server.");
    load();
  }

  if (error) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="text-danger">{error}</p>
        <Button className="mt-4" variant="secondary" onClick={load}>Coba lagi</Button>
      </div>
    );
  }
  if (!settings || !accurate) return <p className="text-sm text-muted">Memuat pengaturan…</p>;

  function updateCustomer(id: string, patch: Partial<CustomerMapping>) {
    setSettings({
      ...settings!,
      customerMappings: settings!.customerMappings.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    });
  }
  function updateLocation(id: string, patch: Partial<LocationMapping>) {
    setSettings({
      ...settings!,
      locationMappings: settings!.locationMappings.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    });
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-semibold tracking-tight">Pengaturan Accurate</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Nomor pelanggan, cabang, dan gudang harus sama dengan data di database Accurate. Client ID dan secret hanya lewat environment, tidak lewat halaman ini.
      </p>
      {notice ? <p className="mt-4 rounded-lg border border-border bg-card px-4 py-3 text-sm">{notice}</p> : null}

      <section className="mt-5 rounded-xl border border-border bg-card p-5">
        <h2 className="font-semibold">Koneksi</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-muted">Kredensial aplikasi</dt><dd>{accurate.configured ? "ACCURATE_CLIENT_ID dan secret terisi" : `Belum: ${accurate.missing.join(", ") || "client id / secret"}`}</dd></div>
          <div><dt className="text-muted">Akun</dt><dd>{accurate.connected ? accurate.userEmail || "Terhubung" : "Belum terhubung"}</dd></div>
          <div className="sm:col-span-2"><dt className="text-muted">Redirect URI yang harus didaftarkan</dt><dd className="font-mono text-[13px]">{accurate.redirectUri}</dd></div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {accurate.configured ? (
            <a href="/api/accurate/authorize" className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">Hubungkan Accurate</a>
          ) : (
            <Button disabled>Hubungkan Accurate</Button>
          )}
          {accurate.connected ? <Button variant="secondary" onClick={() => void disconnect()}>Putuskan</Button> : null}
        </div>
        {databases.length > 0 ? (
          <div className="mt-4">
            <div className="text-sm font-medium">Database yang bisa dibuka</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {databases.map((db) => (
                <button key={db.id} className="rounded-md border border-border px-3 py-1.5 text-left text-sm hover:bg-[#f6f2e9]" onClick={() => setSettings({ ...settings, accurateDatabaseId: db.id })}>
                  <div className="font-medium">{db.alias || "Tanpa nama"}</div>
                  <div className="text-xs text-muted">ID {db.id}</div>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-4 rounded-xl border border-border bg-card p-5">
        <h2 className="font-semibold">Database dan pelanggan bawaan</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-sm">ID database
            <Input className="mt-1" value={settings.accurateDatabaseId} onChange={(event) => setSettings({ ...settings, accurateDatabaseId: event.target.value })} placeholder={accurate.databaseIdFromEnv ? "Pakai ACCURATE_DATABASE_ID" : "1156"} />
          </label>
          <label className="text-sm">No. pelanggan bawaan
            <Input className="mt-1" value={settings.defaultCustomerNo} onChange={(event) => setSettings({ ...settings, defaultCustomerNo: event.target.value })} />
          </label>
          <label className="text-sm">Nama pelanggan bawaan
            <Input className="mt-1" value={settings.defaultCustomerName} onChange={(event) => setSettings({ ...settings, defaultCustomerName: event.target.value })} />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.requireWarehouse} onChange={(event) => setSettings({ ...settings, requireWarehouse: event.target.checked })} className="h-4 w-4 accent-[#0e6b4f]" />
          Tolak sync jika lokasi gudang belum dipetakan
        </label>
      </section>

      <section className="mt-4 rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Pemetaan pelanggan</h2>
          <Button variant="secondary" size="sm" onClick={() => setSettings({ ...settings, customerMappings: [...settings.customerMappings, { id: crypto.randomUUID(), matchType: "channel", matchValue: "", customerNo: "", customerName: "" }] })}>Tambah</Button>
        </div>
        <p className="mt-1 text-sm text-muted">Toko dicek lebih dulu, lalu channel, lalu pelanggan bawaan. Nomor harus ada di Accurate.</p>
        <div className="mt-3 space-y-2">
          {settings.customerMappings.map((row) => (
            <div key={row.id} className="grid gap-2 md:grid-cols-[140px_1fr_1fr_1fr_auto]">
              <select className="h-9 rounded-md border border-border bg-white px-2 text-sm" value={row.matchType} onChange={(event) => updateCustomer(row.id, { matchType: event.target.value as "channel" | "toko" })}>
                <option value="channel">Channel</option>
                <option value="toko">Nama toko</option>
              </select>
              <Input value={row.matchValue} placeholder="SHOPEE" onChange={(event) => updateCustomer(row.id, { matchValue: event.target.value })} aria-label="Nilai cocok" />
              <Input value={row.customerNo} placeholder="No. pelanggan" onChange={(event) => updateCustomer(row.id, { customerNo: event.target.value })} aria-label="Nomor pelanggan" />
              <Input value={row.customerName} placeholder="Nama" onChange={(event) => updateCustomer(row.id, { customerName: event.target.value })} aria-label="Nama pelanggan" />
              <Button variant="ghost" onClick={() => setSettings({ ...settings, customerMappings: settings.customerMappings.filter((item) => item.id !== row.id) })}>Hapus</Button>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Cabang dan gudang</h2>
          <Button variant="secondary" size="sm" onClick={() => setSettings({ ...settings, locationMappings: [...settings.locationMappings, { id: crypto.randomUUID(), lokasiGudang: "", branchName: "", warehouseName: "" }] })}>Tambah</Button>
        </div>
        <div className="mt-3 space-y-2">
          {settings.locationMappings.map((row) => (
            <div key={row.id} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
              <Input value={row.lokasiGudang} placeholder="Lokasi Jubelio" onChange={(event) => updateLocation(row.id, { lokasiGudang: event.target.value })} aria-label="Lokasi gudang" />
              <Input value={row.branchName} placeholder="Nama cabang Accurate" onChange={(event) => updateLocation(row.id, { branchName: event.target.value })} aria-label="Cabang" />
              <Input value={row.warehouseName} placeholder="Nama gudang Accurate" onChange={(event) => updateLocation(row.id, { warehouseName: event.target.value })} aria-label="Gudang" />
              <Button variant="ghost" onClick={() => setSettings({ ...settings, locationMappings: settings.locationMappings.filter((item) => item.id !== row.id) })}>Hapus</Button>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-4">
        <Button onClick={() => void save()} disabled={busy}>{busy ? "Menyimpan…" : "Simpan pengaturan"}</Button>
      </div>
    </div>
  );
}
