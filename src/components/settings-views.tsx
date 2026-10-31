"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { AppSettings, BundleWeight, ChannelMapRow, CityMapRow, ProvinceMapRow, ReviewItem } from "@/lib/db/types";

type AccurateInfo = {
  settings: AppSettings;
  accurate: { configured: boolean; connected: boolean; missing: string[]; redirectUri: string; userEmail: string | null };
};

export function MappingView() {
  const [tab, setTab] = useState<"channel" | "province" | "city">("channel");
  const [channels, setChannels] = useState<ChannelMapRow[]>([]);
  const [provinces, setProvinces] = useState<ProvinceMapRow[]>([]);
  const [cities, setCities] = useState<CityMapRow[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const [channel, province, city, review] = await Promise.all([
      api<ChannelMapRow[]>("/api/mappings/channel"),
      api<ProvinceMapRow[]>("/api/mappings/province"),
      api<CityMapRow[]>("/api/mappings/city"),
      api<ReviewItem[]>("/api/reviews"),
    ]);
    setChannels(channel);
    setProvinces(province);
    setCities(city);
    setReviews(review.filter((row) => row.status === "open"));
  }
  useEffect(() => { load().catch((error: Error) => setMessage(error.message)); }, []);

  async function saveChannel(row: ChannelMapRow) {
    await api("/api/mappings/channel", { method: "POST", body: JSON.stringify(row) });
    setMessage("Mapping channel disimpan.");
    await load();
  }

  return (
    <div>
      {message ? <div className="note" style={{ marginBottom: 12 }}>{message}</div> : null}
      {reviews.length ? <div className="warnbox" style={{ marginBottom: 12 }}>{reviews.length} nilai belum dipetakan dan tidak ditebak. Lengkapi di tabel, lalu tandai selesai.</div> : <div className="note" style={{ marginBottom: 12 }}>Semua nilai yang sudah lewat impor punya baris mapping. Nilai baru akan muncul di sini, bukan ditebak.</div>}
      <div className="tabs">
        <button className={tab === "channel" ? "on" : ""} onClick={() => setTab("channel")}>Channel & Toko</button>
        <button className={tab === "province" ? "on" : ""} onClick={() => setTab("province")}>Provinsi</button>
        <button className={tab === "city" ? "on" : ""} onClick={() => setTab("city")}>Kota</button>
      </div>
      {tab === "channel" ? (
        <div className="card" style={{ overflow: "auto" }}>
          <button className="btn sm" onClick={() => setChannels((rows) => [...rows, { id: "", channelRaw: "", storeRaw: "", channel: "", store: "", needsReview: true }])}>+ Baris</button>
          <table className="cards"><thead><tr><th>Channel mentah</th><th>Toko mentah</th><th>Channel</th><th>Nama Toko</th><th>Review</th><th></th></tr></thead><tbody>
            {channels.map((row, index) => (
              <tr key={row.id || index}>
                <td data-label="Channel mentah"><input value={row.channelRaw} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, channelRaw: event.target.value } : item))} /></td>
                <td data-label="Toko mentah"><input value={row.storeRaw} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, storeRaw: event.target.value } : item))} /></td>
                <td data-label="Channel"><input value={row.channel} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, channel: event.target.value } : item))} /></td>
                <td data-label="Toko"><input value={row.store} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, store: event.target.value } : item))} /></td>
                <td data-label="Review">{row.needsReview ? "YA" : ""}</td>
                <td><button className="btn sm" onClick={() => saveChannel({ ...row, needsReview: false })}>Simpan</button></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ) : null}
      {tab === "province" ? (
        <div className="card" style={{ overflow: "auto" }}>
          <table className="cards"><thead><tr><th>Provinsi Jubelio</th><th>Provinsi resmi</th><th>Review</th><th></th></tr></thead><tbody>
            {provinces.map((row) => (
              <tr key={row.id}><td data-label="Mentah">{row.raw || "(kosong)"}</td><td data-label="Resmi"><input defaultValue={row.official} id={`p-${row.id}`} /></td><td>{row.needsReview ? "YA" : ""}</td><td><button className="btn sm" onClick={() => api("/api/mappings/province", { method: "POST", body: JSON.stringify({ ...row, official: (document.getElementById(`p-${row.id}`) as HTMLInputElement).value, needsReview: false }) }).then(load)}>Simpan</button></td></tr>
            ))}
          </tbody></table>
        </div>
      ) : null}
      {tab === "city" ? (
        <div className="card" style={{ overflow: "auto" }}>
          <table className="cards"><thead><tr><th>Provinsi mentah</th><th>Kota mentah</th><th>Kab/Kota resmi</th><th>Review</th><th></th></tr></thead><tbody>
            {cities.map((row) => (
              <tr key={row.id}><td data-label="Provinsi">{row.provinceRaw || "(kosong)"}</td><td data-label="Kota">{row.cityRaw || "(kosong)"}</td><td data-label="Resmi"><input defaultValue={row.official} id={`c-${row.id}`} /></td><td>{row.needsReview ? "YA" : ""}</td><td><button className="btn sm" onClick={() => api("/api/mappings/city", { method: "POST", body: JSON.stringify({ ...row, official: (document.getElementById(`c-${row.id}`) as HTMLInputElement).value, needsReview: false }) }).then(load)}>Simpan</button></td></tr>
            ))}
          </tbody></table>
        </div>
      ) : null}
      {reviews.length ? (
        <div className="card mt"><h3>Perlu review</h3>{reviews.map((row) => <div key={row.id} className="small">{row.kind}: {row.rawKey} <button className="btn sm" onClick={() => api("/api/reviews", { method: "POST", body: JSON.stringify({ id: row.id }) }).then(load)}>Tandai selesai</button></div>)}</div>
      ) : null}
    </div>
  );
}

export function BobotView() {
  const [weights, setWeights] = useState<BundleWeight[]>([]);
  const [reviews, setReviews] = useState<{ rawKey: string }[]>([]);
  const [key, setKey] = useState("");
  const [bobot, setBobot] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const result = await api<{ weights: BundleWeight[]; reviews: { rawKey: string }[] }>("/api/weights");
    setWeights(result.weights);
    setReviews(result.reviews);
  }
  useEffect(() => { load().catch((error: Error) => setMessage(error.message)); }, []);

  return (
    <div className="card">
      <h3>Bobot bundle</h3>
      {message ? <div className="note">{message}</div> : null}
      {reviews.length ? <div className="warnbox">Bobot belum ada untuk: {reviews.map((row) => row.rawKey).join(", ")}. Baris ini tidak dibuang diam-diam.</div> : null}
      <div className="filters mt">
        <input placeholder="SKU-item_code_bundle" value={key} onChange={(event) => setKey(event.target.value)} />
        <input placeholder="Bobot" value={bobot} onChange={(event) => setBobot(event.target.value)} />
        <button className="btn pri" onClick={() => api("/api/weights", { method: "POST", body: JSON.stringify({ bundleKey: key, bobot: Number(bobot) }) }).then(() => { setKey(""); setBobot(""); return load(); })}>Tambah</button>
        <label className="btn">Impor Excel<input type="file" accept=".xlsx" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const form = new FormData();
          form.set("file", file);
          fetch("/api/weights", { method: "POST", body: form }).then(() => load());
        }} /></label>
      </div>
      <div className="tbl mt"><table className="cards"><thead><tr><th>Kunci</th><th>Bobot</th><th></th></tr></thead><tbody>
        {weights.map((row) => <tr key={row.id}><td data-label="Kunci">{row.bundleKey}</td><td data-label="Bobot">{row.bobot}</td><td><button className="btn sm" onClick={() => api("/api/weights", { method: "POST", body: JSON.stringify({ deleteId: row.id }) }).then(load)}>Hapus</button></td></tr>)}
      </tbody></table></div>
    </div>
  );
}

export function AccurateView() {
  const [info, setInfo] = useState<AccurateInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<AccurateInfo>("/api/settings").then((result) => { setInfo(result); setSettings(result.settings); }).catch((error: Error) => setMessage(error.message));
  }, []);

  if (!settings || !info) return <div className="card">{message || "Memuat…"}</div>;
  const connected = info.accurate.connected;
  return (
    <div className="grid g2">
      <div className="card">
        <h3>Koneksi Accurate</h3>
        {connected ? <div className="note">Terhubung{info.accurate.userEmail ? ` sebagai ${info.accurate.userEmail}` : ""}.</div> : <div className="warnbox">Belum terhubung. {info.accurate.configured ? "Lanjutkan OAuth." : `Env yang belum diisi: ${info.accurate.missing.join(", ") || "kredensial"}.`}</div>}
        <p className="small">Redirect: {info.accurate.redirectUri}</p>
        <p className="small mut">Client secret tidak disimpan di kode. Isi ACCURATE_CLIENT_ID dan ACCURATE_CLIENT_SECRET di environment.</p>
        <div className="filters">
          <a className="btn pri" href="/api/accurate/authorize">Hubungkan Accurate</a>
          <button className="btn" onClick={() => api("/api/accurate/disconnect", { method: "POST" }).then(() => location.reload())}>Putuskan</button>
        </div>
        <div className="f mt"><label>ID database</label><input value={settings.accurateDatabaseId} onChange={(event) => setSettings({ ...settings, accurateDatabaseId: event.target.value })} /></div>
        <label className="small"><input type="checkbox" checked={settings.requireWarehouse} onChange={(event) => setSettings({ ...settings, requireWarehouse: event.target.checked })} /> Wajibkan gudang bila lokasi terisi</label>
        <div className="mt"><button className="btn pri" onClick={() => api("/api/settings", { method: "PUT", body: JSON.stringify(settings) }).then(() => setMessage("Pengaturan disimpan."))}>Simpan</button></div>
      </div>
      <div className="card">
        <h3>Pelanggan & gudang</h3>
        <p className="small mut">CustomerNo Accurate dicocokkan ke channel atau nama toko hasil mapping. Gudang dicocokkan ke lokasi Jubelio bila ada.</p>
        {settings.customerMappings.map((row, index) => (
          <div key={row.id} className="filters" style={{ marginBottom: 6 }}>
            <input value={row.matchValue} onChange={(event) => setSettings({ ...settings, customerMappings: settings.customerMappings.map((item, i) => i === index ? { ...item, matchValue: event.target.value } : item) })} />
            <input value={row.customerNo} onChange={(event) => setSettings({ ...settings, customerMappings: settings.customerMappings.map((item, i) => i === index ? { ...item, customerNo: event.target.value } : item) })} />
          </div>
        ))}
        {settings.locationMappings.map((row, index) => (
          <div key={row.id} className="filters" style={{ marginBottom: 6 }}>
            <input value={row.lokasiGudang} onChange={(event) => setSettings({ ...settings, locationMappings: settings.locationMappings.map((item, i) => i === index ? { ...item, lokasiGudang: event.target.value } : item) })} />
            <input value={row.warehouseName} onChange={(event) => setSettings({ ...settings, locationMappings: settings.locationMappings.map((item, i) => i === index ? { ...item, warehouseName: event.target.value } : item) })} />
          </div>
        ))}
      </div>
      {message ? <div className="note">{message}</div> : null}
    </div>
  );
}
