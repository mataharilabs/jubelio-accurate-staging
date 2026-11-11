"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { isBundlePending, isMappingPending } from "@/lib/domain/phase3";
import type { AppSettings, BundleWeight, ChannelMapRow, CityMapRow, ProvinceMapRow, ReviewItem } from "@/lib/db/types";
import { OFFICIAL_CITIES, OFFICIAL_PROVINCES, suggestCity, suggestProvince, type NameSuggestion } from "@/lib/region/names";

type AccurateInfo = {
  settings: AppSettings;
  accurate: { configured: boolean; connected: boolean; missing: string[]; redirectUri: string; userEmail: string | null; salesPush?: boolean };
};

function regionSuggestion(row: ReviewItem, provinces: ProvinceMapRow[], cities: CityMapRow[]): NameSuggestion | null {
  if (row.kind === "province") return suggestProvince(row.detail.province || row.rawKey, provinces);
  if (row.kind === "city") return suggestCity(row.detail.province ?? "", row.detail.city || row.rawKey, provinces, cities);
  return null;
}

function regionLabel(row: ReviewItem): string {
  if (row.kind === "province") return row.detail.province || row.rawKey;
  if (row.kind === "city") {
    const raw = row.detail.province || "?";
    const official = row.detail.provinceOfficial;
    const province = official && official !== raw ? `${raw} (${official})` : raw;
    return `${province} / ${row.detail.city || row.rawKey}`;
  }
  return row.rawKey;
}

export function MappingView({ scope = "channel" }: { scope?: "channel" | "geo" }) {
  const [tab, setTab] = useState<"channel" | "province" | "city">(scope === "geo" ? "province" : "channel");
  const [mapFilter, setMapFilter] = useState<"belum" | "sudah" | "semua">("belum");
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
    const openReviews = review.filter((row) => row.status === "open");
    setReviews(openReviews);
    setBulk(null);
    const pending = scope === "channel"
      ? channel.filter((row) => isMappingPending(row)).length
      : province.filter((row) => isMappingPending(row)).length + city.filter((row) => isMappingPending(row)).length;
    setMapFilter((current) => current === "belum" && pending === 0 ? "semua" : current);
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

  const pendingChannel = channels.filter((row) => isMappingPending(row)).length;
  const pendingGeo = provinces.filter((row) => isMappingPending(row)).length + cities.filter((row) => isMappingPending(row)).length;
  const keep = <T extends { mappedAt?: string | null; needsReview?: boolean; official?: string; channel?: string; store?: string }>(rows: T[]) => rows.filter((row) => mapFilter === "semua" || (mapFilter === "belum") === isMappingPending(row));
  const dateText = (value?: string | null) => value ? new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "—";

  return (
    <div>
      <div className="pagehead">
        <div className="desc">{scope === "channel"
          ? "Mapping hanya Channel & Toko di Jubelio ke Channel & Toko di Web. Tanggal mapping kosong = belum termapping. Gudang, cabang, dan pelanggan tidak diisi di sini."
          : "Provinsi dan kota Jubelio ke nama resmi. Tanggal mapping kosong = belum termapping."}</div>
      </div>
      {(scope === "channel" ? pendingChannel : pendingGeo) ? <div className="pendbar"><b>{scope === "channel" ? pendingChannel : pendingGeo}</b> belum termapping.</div> : <div className="note" style={{ marginBottom: 12 }}>Tidak ada yang menunggu mapping.</div>}
      <div className="filterbar">
        <div className="f"><label>Status mapping</label>
          <select value={mapFilter} onChange={(event) => setMapFilter(event.target.value as "belum" | "sudah" | "semua")}>
            <option value="belum">Belum termapping</option>
            <option value="sudah">Sudah termapping</option>
            <option value="semua">Semua</option>
          </select>
        </div>
      </div>
      {message ? <div className="note" style={{ marginBottom: 12 }}>{message}</div> : null}
      {reviews.length ? <div className="warnbox" style={{ marginBottom: 12 }}>{reviews.length} nilai belum dipetakan. Provinsi dan kota dicocokkan tanpa membedakan huruf besar atau spasi. Saran nama resmi baru tersimpan setelah Anda menyetujuinya.</div> : <div className="note" style={{ marginBottom: 12 }}>Semua nilai yang sudah lewat impor punya baris mapping. Nilai baru akan muncul di sini.</div>}
      {scope === "geo" ? <div className="tabs">
        <button className={tab === "province" ? "on" : ""} onClick={() => setTab("province")}>Provinsi</button>
        <button className={tab === "city" ? "on" : ""} onClick={() => setTab("city")}>Kota</button>
      </div> : null}
      {scope === "channel" && tab === "channel" ? (
        <div className="card" style={{ overflow: "auto" }}>
          <button className="btn sm" onClick={() => setChannels((rows) => [...rows, { id: "", channelRaw: "", storeRaw: "", channel: "", store: "", needsReview: true }])}>+ Baris</button>
          <table className="cards"><thead><tr><th>Channel di Jubelio</th><th>Toko di Jubelio</th><th>Channel di Web</th><th>Toko di Web</th><th>Tanggal mapping</th><th></th></tr></thead><tbody>
            {keep(channels).map((row) => {
              const index = channels.indexOf(row);
              return (
              <tr key={row.id || index}>
                <td data-label="Channel mentah"><input value={row.channelRaw} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, channelRaw: event.target.value } : item))} /></td>
                <td data-label="Toko mentah"><input value={row.storeRaw} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, storeRaw: event.target.value } : item))} /></td>
                <td data-label="Channel"><input value={row.channel} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, channel: event.target.value } : item))} /></td>
                <td data-label="Toko"><input value={row.store} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, store: event.target.value } : item))} /></td>
                <td data-label="Tanggal mapping">{row.needsReview || isMappingPending(row) ? <span className="pill p-warn">Belum termapping</span> : dateText(row.mappedAt)}</td>
                <td><button className="btn sm" onClick={() => saveChannel({ ...row, needsReview: false })}>Simpan</button></td>
              </tr>
              );
            })}
          </tbody></table>
        </div>
      ) : null}
      {scope === "geo" && tab === "province" ? (
        <div className="card" style={{ overflow: "auto" }}>
          <div className="filters" style={{ marginBottom: 8 }}>
            <input placeholder="Provinsi Jubelio" value={provinceDraft.raw} onChange={(event) => setProvinceDraft({ ...provinceDraft, raw: event.target.value })} />
            <input placeholder="Provinsi resmi" list="provinsi-resmi" value={provinceDraft.official} onChange={(event) => setProvinceDraft({ ...provinceDraft, official: event.target.value })} />
            <button className="btn sm" onClick={() => saveProvince(provinceDraft).catch((error: Error) => setMessage(error.message))}>+ Baris</button>
          </div>
          <table className="cards"><thead><tr><th>Provinsi Jubelio</th><th>Provinsi resmi</th><th>Review</th><th></th></tr></thead><tbody>
            {keep(provinces).map((row) => (
              <tr key={row.id}>
                <td data-label="Mentah">{row.raw || "(kosong)"}</td>
                <td data-label="Resmi"><input value={row.official} list="provinsi-resmi" onChange={(event) => setProvinces((rows) => rows.map((item) => item.id === row.id ? { ...item, official: event.target.value } : item))} /></td>
                <td data-label="Tanggal mapping">{isMappingPending(row) ? <span className="pill p-warn">Belum termapping</span> : dateText(row.mappedAt)}</td>
                <td><button className="btn sm" onClick={() => saveProvince(row).catch((error: Error) => setMessage(error.message))}>Simpan</button></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ) : null}
      {scope === "geo" && tab === "city" ? (
        <div className="card" style={{ overflow: "auto" }}>
          <div className="filters" style={{ marginBottom: 8 }}>
            <input placeholder="Provinsi mentah" value={cityDraft.provinceRaw} onChange={(event) => setCityDraft({ ...cityDraft, provinceRaw: event.target.value })} />
            <input placeholder="Kota mentah" value={cityDraft.cityRaw} onChange={(event) => setCityDraft({ ...cityDraft, cityRaw: event.target.value })} />
            <input placeholder="Kab/Kota resmi" list="kota-resmi" value={cityDraft.official} onChange={(event) => setCityDraft({ ...cityDraft, official: event.target.value })} />
            <button className="btn sm" onClick={() => saveCity(cityDraft).catch((error: Error) => setMessage(error.message))}>+ Baris</button>
          </div>
          <table className="cards"><thead><tr><th>Provinsi mentah</th><th>Kota mentah</th><th>Kab/Kota resmi</th><th>Review</th><th></th></tr></thead><tbody>
            {keep(cities).map((row) => (
              <tr key={row.id}>
                <td data-label="Provinsi">{row.provinceRaw || "(kosong)"}</td>
                <td data-label="Kota">{row.cityRaw || "(kosong)"}</td>
                <td data-label="Resmi"><input value={row.official} list="kota-resmi" onChange={(event) => setCities((rows) => rows.map((item) => item.id === row.id ? { ...item, official: event.target.value } : item))} /></td>
                <td data-label="Tanggal mapping">{isMappingPending(row) ? <span className="pill p-warn">Belum termapping</span> : dateText(row.mappedAt)}</td>
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
  const [filter, setFilter] = useState<"belum" | "sudah" | "semua">("belum");

  async function load() {
    const result = await api<{ weights: BundleWeight[]; reviews: { rawKey: string }[] }>("/api/weights");
    setWeights(result.weights);
    setReviews(result.reviews);
    const waiting = result.reviews.length + result.weights.filter((row) => isBundlePending(row)).length;
    setFilter((current) => current === "belum" && waiting === 0 ? "semua" : current);
  }
  useEffect(() => { load().catch((error: Error) => setMessage(error.message)); }, []);

  const pending = reviews.length + weights.filter((row) => isBundlePending(row)).length;
  const shown = weights.filter((row) => filter === "semua" || (filter === "belum") === isBundlePending(row));
  return (
    <div>
      <div className="pagehead"><div className="desc">Tanggal updated kosong = bobot perlu keputusan. Bundle baru dari Jubelio tetap muncul sampai bobotnya disimpan.</div></div>
      {pending ? <div className="pendbar"><b>{pending}</b> bobot belum terupdate.</div> : null}
      <div className="filterbar">
        <div className="f"><label>Status</label>
          <select value={filter} onChange={(event) => setFilter(event.target.value as "belum" | "sudah" | "semua")}>
            <option value="belum">Belum terupdate</option>
            <option value="sudah">Sudah terupdate</option>
            <option value="semua">Semua</option>
          </select>
        </div>
      </div>
      {message ? <div className="note">{message}</div> : null}
      {filter !== "sudah" && reviews.length ? <div className="warnbox">Bobot belum ada untuk: {reviews.map((row) => row.rawKey).join(", ")}.</div> : null}
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
      <div className="tablecard mt"><div className="tscroll"><table className="cards"><thead><tr><th>Kunci</th><th>Bobot</th><th>Tanggal updated</th><th></th></tr></thead><tbody>
        {shown.map((row) => <tr key={row.id}><td data-label="Kunci">{row.bundleKey}</td><td data-label="Bobot">{row.bobot}</td><td data-label="Tanggal updated">{isBundlePending(row) ? <span className="pill p-warn">Belum terupdate</span> : new Date(row.confirmedAt || row.updatedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</td><td><button className="btn sm" onClick={() => api("/api/weights", { method: "POST", body: JSON.stringify({ deleteId: row.id }) }).then(load)}>Hapus</button></td></tr>)}
      </tbody></table></div></div>
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
          <button className="btn" onClick={() => api<{ ok?: boolean; error?: string }>("/api/accurate/test", { method: "POST" }).then(() => setMessage("Koneksi Accurate OK.")).catch((error: Error) => setMessage(error.message))}>Tes koneksi</button>
          <button className="btn" onClick={() => api("/api/accurate/disconnect", { method: "POST" }).then(() => location.reload())}>Putuskan</button>
        </div>
        <div className="mt">{info.accurate.salesPush ? <span className="pill p-ok">Pengiriman penjualan aktif</span> : <span className="pill p-warn">Hanya-baca · penjualan ditahan</span>}</div>
        <div className="f mt"><label>ID database</label><input value={settings.accurateDatabaseId} onChange={(event) => setSettings({ ...settings, accurateDatabaseId: event.target.value })} /></div>
        <div className="f mt"><label>Tanggal lapor PPN terakhir</label><input type="date" value={settings.ppnReportDate || ""} onChange={(event) => setSettings({ ...settings, ppnReportDate: event.target.value })} /></div>
        <div className="small mut">Pesanan bertanggal pada atau sebelum tanggal ini sudah tutup buku.</div>
        <div className="f mt"><label>Gudang default</label><input value={settings.defaultWarehouse || ""} onChange={(event) => setSettings({ ...settings, defaultWarehouse: event.target.value })} /></div>
        <div className="f mt"><label>Cabang default</label><input value={settings.defaultBranch || ""} onChange={(event) => setSettings({ ...settings, defaultBranch: event.target.value })} /></div>
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
      <div className="card mt">
        <h3>Aturan ke Accurate · Cancel / Retur / Tutup buku</h3>
        <ol className="rules">
          <li>Cancel belum tutup buku: status CANCELED di web, penjualan dihapus saat sync. Tidak di-soft-delete.</li>
          <li>Cancel sudah tutup buku: tidak diproses otomatis. Finance menangani manual, lalu Abaikan.</li>
          <li>Retur Case 1 balik semua: harga web tetap. Belum tutup buku = hapus penjualan. Sudah tutup buku = buat Retur.</li>
          <li>Retur Case 2/3: pesanan asal tetap berharga. Jubelio membuat no-R harga 0, channel Internal, toko Barang Hilang.</li>
          <li>Pesanan yang sudah sync tidak bisa dihapus. Pengiriman jual/retur ditahan sampai ACCURATE_SALES_PUSH=enabled.</li>
        </ol>
      </div>
    </div>
  );
}

export function JubelioView() {
  const [info, setInfo] = useState<{ configured: boolean; email: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    api<{ configured: boolean; email: string }>("/api/jubelio/test").then(setInfo).catch((error: Error) => setMessage(error.message));
  }, []);
  return (
    <div>
      <div className="pagehead">
        <div className="desc">Akun Jubelio untuk menarik pesanan dan master item. Rahasia tidak ditampilkan.</div>
        <div className="actions">
          <button className="btn" onClick={() => api("/api/jubelio/test", { method: "POST" }).then(() => setMessage("Koneksi Jubelio OK.")).catch((error: Error) => setMessage(error.message))}>Tes koneksi</button>
        </div>
      </div>
      {message ? <div className="note" style={{ marginBottom: 12 }}>{message}</div> : null}
      <div className="grid g2">
        <div className="card">
          <h3>Akun {info?.configured ? <span className="pill p-ok">Terhubung</span> : <span className="pill p-warn">Belum diisi</span>}</h3>
          <p className="small">Email: {info?.email || "—"}</p>
          <p className="small mut">Password dan token tidak pernah ditampilkan di halaman ini.</p>
        </div>
        <div className="card">
          <h3>Jadwal otomatis</h3>
          <table><tbody>
            <tr><td>Harian</td><td>16:00 WIB</td><td>H-1 s/d H-3</td></tr>
            <tr><td>Mingguan</td><td>Minggu 23:59 WIB</td><td>H-4 s/d H-28</td></tr>
            <tr><td>Lanjutan</td><td>Setiap 5 menit</td><td>job yang belum selesai</td></tr>
            <tr><td>Tombol Sync</td><td>Master Data › Pesanan</td><td>H-1 saja</td></tr>
          </tbody></table>
        </div>
      </div>
    </div>
  );
}
