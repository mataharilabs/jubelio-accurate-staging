"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import type { AppSettings, BundleWeight, ChannelMapRow, CityMapRow, ProvinceMapRow, ReviewItem } from "@/lib/db/types";
import { OFFICIAL_CITIES, OFFICIAL_PROVINCES, suggestCity, suggestProvince, type NameSuggestion } from "@/lib/region/names";

type AccurateInfo = {
  settings: AppSettings;
  accurate: { configured: boolean; connected: boolean; missing: string[]; redirectUri: string; userEmail: string | null };
};

function regionSuggestion(row: ReviewItem, provinces: ProvinceMapRow[], cities: CityMapRow[]): NameSuggestion | null {
  if (row.kind === "province") return suggestProvince(row.detail.province || row.rawKey, provinces);
  if (row.kind === "city") return suggestCity(row.detail.province ?? "", row.detail.city || row.rawKey, provinces, cities);
  return null;
}

function regionLabel(row: ReviewItem): string {
  if (row.kind === "province") return row.detail.province || row.rawKey;
  if (row.kind === "city") return `${row.detail.province || "?"} / ${row.detail.city || row.rawKey}`;
  return row.rawKey;
}

export function MappingView() {
  const [tab, setTab] = useState<"channel" | "province" | "city">("channel");
  const [channels, setChannels] = useState<ChannelMapRow[]>([]);
  const [provinces, setProvinces] = useState<ProvinceMapRow[]>([]);
  const [cities, setCities] = useState<CityMapRow[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [officials, setOfficials] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState<{ id: string; label: string; official: string }[] | null>(null);
  const [provinceDraft, setProvinceDraft] = useState({ raw: "", official: "" });
  const [cityDraft, setCityDraft] = useState({ provinceRaw: "", cityRaw: "", official: "" });
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
    setBulk(null);
  }
  useEffect(() => { load().catch((error: Error) => setMessage(error.message)); }, []);

  const suggestions = useMemo(() => {
    const map = new Map<string, NameSuggestion>();
    for (const row of reviews) {
      const suggestion = regionSuggestion(row, provinces, cities);
      if (suggestion) map.set(row.id, suggestion);
    }
    return map;
  }, [reviews, provinces, cities]);

  const suggestedReviews = reviews.filter((row) => suggestions.get(row.id)?.official);
  const cityOptions = OFFICIAL_CITIES.map((city) => city.name);

  async function saveChannel(row: ChannelMapRow) {
    await api("/api/mappings/channel", { method: "POST", body: JSON.stringify(row) });
    setMessage("Mapping channel disimpan.");
    await load();
  }

  async function saveProvince(row: { id?: string; raw: string; official: string }) {
    await api("/api/mappings/province", { method: "POST", body: JSON.stringify({ ...row, needsReview: false }) });
    setMessage("Mapping provinsi disimpan.");
    setProvinceDraft({ raw: "", official: "" });
    await load();
  }

  async function saveCity(row: { id?: string; provinceRaw: string; cityRaw: string; official: string }) {
    await api("/api/mappings/city", { method: "POST", body: JSON.stringify({ ...row, needsReview: false }) });
    setMessage("Mapping kota disimpan.");
    setCityDraft({ provinceRaw: "", cityRaw: "", official: "" });
    await load();
  }

  async function saveReview(row: ReviewItem) {
    const official = (officials[row.id] ?? suggestions.get(row.id)?.official ?? "").trim();
    await api("/api/reviews", { method: "POST", body: JSON.stringify({ id: row.id, official }) });
    setMessage("Mapping disimpan dan review ditutup.");
    await load();
  }

  async function acceptBulk() {
    if (!bulk?.length) return;
    await api("/api/reviews", { method: "POST", body: JSON.stringify({ items: bulk.map((row) => ({ id: row.id, official: row.official })) }) });
    setMessage(`${bulk.length} saran disimpan.`);
    await load();
  }

  return (
    <div>
      {message ? <div className="note" style={{ marginBottom: 12 }}>{message}</div> : null}
      {reviews.length ? <div className="warnbox" style={{ marginBottom: 12 }}>{reviews.length} nilai belum dipetakan. Provinsi dan kota dicocokkan tanpa membedakan huruf besar atau spasi. Saran nama resmi baru tersimpan setelah Anda menyetujuinya.</div> : <div className="note" style={{ marginBottom: 12 }}>Semua nilai yang sudah lewat impor punya baris mapping. Nilai baru akan muncul di sini.</div>}
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
          <div className="filters" style={{ marginBottom: 8 }}>
            <input placeholder="Provinsi Jubelio" value={provinceDraft.raw} onChange={(event) => setProvinceDraft({ ...provinceDraft, raw: event.target.value })} />
            <input placeholder="Provinsi resmi" list="provinsi-resmi" value={provinceDraft.official} onChange={(event) => setProvinceDraft({ ...provinceDraft, official: event.target.value })} />
            <button className="btn sm" onClick={() => saveProvince(provinceDraft).catch((error: Error) => setMessage(error.message))}>+ Baris</button>
          </div>
          <table className="cards"><thead><tr><th>Provinsi Jubelio</th><th>Provinsi resmi</th><th>Review</th><th></th></tr></thead><tbody>
            {provinces.map((row) => (
              <tr key={row.id}>
                <td data-label="Mentah">{row.raw || "(kosong)"}</td>
                <td data-label="Resmi"><input value={row.official} list="provinsi-resmi" onChange={(event) => setProvinces((rows) => rows.map((item) => item.id === row.id ? { ...item, official: event.target.value } : item))} /></td>
                <td>{row.needsReview ? "YA" : ""}</td>
                <td><button className="btn sm" onClick={() => saveProvince(row).catch((error: Error) => setMessage(error.message))}>Simpan</button></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ) : null}
      {tab === "city" ? (
        <div className="card" style={{ overflow: "auto" }}>
          <div className="filters" style={{ marginBottom: 8 }}>
            <input placeholder="Provinsi mentah" value={cityDraft.provinceRaw} onChange={(event) => setCityDraft({ ...cityDraft, provinceRaw: event.target.value })} />
            <input placeholder="Kota mentah" value={cityDraft.cityRaw} onChange={(event) => setCityDraft({ ...cityDraft, cityRaw: event.target.value })} />
            <input placeholder="Kab/Kota resmi" list="kota-resmi" value={cityDraft.official} onChange={(event) => setCityDraft({ ...cityDraft, official: event.target.value })} />
            <button className="btn sm" onClick={() => saveCity(cityDraft).catch((error: Error) => setMessage(error.message))}>+ Baris</button>
          </div>
          <table className="cards"><thead><tr><th>Provinsi mentah</th><th>Kota mentah</th><th>Kab/Kota resmi</th><th>Review</th><th></th></tr></thead><tbody>
            {cities.map((row) => (
              <tr key={row.id}>
                <td data-label="Provinsi">{row.provinceRaw || "(kosong)"}</td>
                <td data-label="Kota">{row.cityRaw || "(kosong)"}</td>
                <td data-label="Resmi"><input value={row.official} list="kota-resmi" onChange={(event) => setCities((rows) => rows.map((item) => item.id === row.id ? { ...item, official: event.target.value } : item))} /></td>
                <td>{row.needsReview ? "YA" : ""}</td>
                <td><button className="btn sm" onClick={() => saveCity(row).catch((error: Error) => setMessage(error.message))}>Simpan</button></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ) : null}
      {reviews.length ? (
        <div className="card mt">
          <h3>Perlu review</h3>
          <p className="small">Untuk provinsi dan kota, simpan nama resmi. Itu membuat mapping dan menutup review yang tulisannya sama. Menandai selesai tanpa nama resmi tidak tersedia, karena impor berikutnya akan membuka review lagi.</p>
          {suggestedReviews.length ? <button className="btn sm" onClick={() => setBulk(suggestedReviews.map((row) => ({ id: row.id, label: regionLabel(row), official: suggestions.get(row.id)?.official ?? "" })))}>Terima semua saran ({suggestedReviews.length})</button> : null}
          {bulk ? (
            <div className="warnbox mt">
              <strong>Periksa {bulk.length} saran sebelum disimpan.</strong>
              <div className="tbl mt" style={{ maxHeight: 240, overflow: "auto" }}>
                <table className="cards"><tbody>
                  {bulk.map((row) => <tr key={row.id}><td data-label="Mentah">{row.label}</td><td data-label="Resmi">{row.official}</td></tr>)}
                </tbody></table>
              </div>
              <div className="filters mt">
                <button className="btn pri sm" onClick={() => acceptBulk().catch((error: Error) => setMessage(error.message))}>Simpan semua saran ini</button>
                <button className="btn sm" onClick={() => setBulk(null)}>Batal</button>
              </div>
            </div>
          ) : null}
          {reviews.map((row) => {
            const suggestion = suggestions.get(row.id);
            if (!suggestion) {
              return <div key={row.id} className="small">{row.kind}: {row.rawKey} <button className="btn sm" onClick={() => api("/api/reviews", { method: "POST", body: JSON.stringify({ id: row.id }) }).then(load).catch((error: Error) => setMessage(error.message))}>Tandai selesai</button></div>;
            }
            const value = officials[row.id] ?? suggestion.official ?? "";
            return (
              <div key={row.id} className="filters" style={{ marginTop: 8 }}>
                <span className="small" style={{ minWidth: 180 }}>{regionLabel(row)}</span>
                <input
                  list={row.kind === "province" ? "provinsi-resmi" : "kota-resmi"}
                  placeholder="Nama resmi"
                  value={value}
                  onChange={(event) => setOfficials((current) => ({ ...current, [row.id]: event.target.value }))}
                />
                <button className="btn sm" onClick={() => saveReview(row).catch((error: Error) => setMessage(error.message))}>Simpan mapping</button>
                {suggestion.ambiguous ? <span className="small">Beberapa nama cocok. Pilih yang resmi.</span> : null}
                {suggestion.fromMapping && suggestion.official ? <span className="small">Sudah ada di mapping: {suggestion.official}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <datalist id="provinsi-resmi">{OFFICIAL_PROVINCES.map((name) => <option key={name} value={name} />)}</datalist>
      <datalist id="kota-resmi">{cityOptions.map((name) => <option key={name} value={name} />)}</datalist>
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
        <div className="f mt"><label>Lokasi Jubelio yang ditarik (satu per baris)</label>
          <textarea rows={8} value={(settings.jubelioLocations ?? []).join("\n")} onChange={(event) => setSettings({ ...settings, jubelioLocations: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })} />
        </div>
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
