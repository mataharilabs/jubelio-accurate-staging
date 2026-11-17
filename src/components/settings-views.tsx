"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ActionButton, reported, reportedOk, TableShell } from "@/components/ui/feedback";
import { Pager, useClientPage } from "@/components/ui/pager";
import { api, track } from "@/lib/api-client";
import { splitWeights, weightTotalError } from "@/lib/domain/bundle-weight";
import { isBundlePending, isMappingPending } from "@/lib/domain/phase3";
import type { AppSettings, BundleDefinition, ChannelMapRow, CityMapRow, ProvinceMapRow, ReviewItem } from "@/lib/db/types";
import { recommendationOf, type GeoPair } from "@/lib/region/pairs";
import { citiesInProvince, OFFICIAL_CITIES, OFFICIAL_PROVINCES, suggestCity, suggestProvince, type NameSuggestion } from "@/lib/region/names";

type AccurateInfo = {
  settings: AppSettings;
  accurate: {
    configured: boolean;
    connected: boolean;
    missing: string[];
    redirectUri: string;
    userEmail: string | null;
    salesPush?: boolean;
    scope?: string | null;
    missingCustomerScopes?: string[];
  };
};

function DatabaseField({ connected, value, onChange }: { connected: boolean; value: string; onChange: (next: string) => void }) {
  const [databases, setDatabases] = useState<{ id: string; alias: string }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (!connected) return;
    api<{ databases: { id: string; alias: string }[] }>("/api/accurate/databases")
      .then((result) => setDatabases(result.databases))
      .catch(() => setFailed(true));
  }, [connected]);
  const options = databases ?? [];
  const known = options.some((row) => row.id === value);
  const useList = connected && !failed && !manual && options.length > 0;
  return (
    <div className="f mt">
      <label>Database Accurate</label>
      {useList ? (
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Pilih database</option>
          {!known && value ? <option value={value}>{value}</option> : null}
          {options.map((row) => <option key={row.id} value={row.id}>{row.alias ? `${row.alias} · ${row.id}` : row.id}</option>)}
        </select>
      ) : (
        <input value={value} placeholder="ID database" onChange={(event) => onChange(event.target.value)} />
      )}
      {failed ? <div className="small mut">Daftar database tidak bisa dimuat. Isi ID secara manual.</div> : null}
      {connected && options.length ? <button type="button" className="btn sm" onClick={() => setManual((current) => !current)}>{manual || !useList ? "Pilih dari daftar" : "Isi manual"}</button> : null}
    </div>
  );
}

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

type GeoDraft = { provinceOfficial: string; cityOfficial: string };
type GeoFailure = { key: string; label: string; error: string };
type GeoBulkResult = { saved: number; savedKeys: string[]; failed: GeoFailure[] };

function SelectAllBox({ checked, indeterminate, disabled, onChange, label }: { checked: boolean; indeterminate: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange} />;
}

function GeoMapping() {
  const [rows, setRows] = useState<GeoPair[]>([]);
  const [pending, setPending] = useState(0);
  const [mapFilter, setMapFilter] = useState<"belum" | "sudah" | "semua">("belum");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, GeoDraft>>({});
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ provinceRaw: "", cityRaw: "", provinceOfficial: "", cityOfficial: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [failures, setFailures] = useState<GeoFailure[]>([]);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const result = await api<{ rows: GeoPair[]; pending: number }>("/api/mappings/geo");
      setRows(result.rows);
      setPending(result.pending);
      setMapFilter((current) => current === "belum" && result.pending === 0 ? "semua" : current);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh().catch((error: Error) => setMessage(error.message)); }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!Object.keys(edits).length) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [edits]);

  const filtered = rows.filter((row) => {
    if (mapFilter === "belum" && !row.pending) return false;
    if (mapFilter === "sudah" && row.pending) return false;
    const hay = `${row.provinceRaw} ${row.cityRaw} ${row.provinceOfficial} ${row.cityOfficial} ${row.provinceSuggestion} ${row.citySuggestion}`.toLowerCase();
    return !q.trim() || hay.includes(q.trim().toLowerCase());
  });
  const listing = useClientPage(filtered, "geo-map", 25);
  const shown = listing.shown;
  const safePage = listing.page;
  const dateText = (value?: string | null) => value ? new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "—";
  const draftOf = (row: GeoPair): GeoDraft => edits[row.key] ?? {
    provinceOfficial: row.provinceOfficial || row.provinceSuggestion,
    cityOfficial: row.cityRaw ? (row.cityOfficial || row.citySuggestion) : "",
  };
  const payloadOf = (row: GeoPair) => {
    const value = draftOf(row);
    return {
      provinceRaw: row.provinceRaw,
      cityRaw: row.cityRaw,
      provinceOfficial: value.provinceOfficial.trim(),
      cityOfficial: row.cityRaw ? value.cityOfficial.trim() : "",
    };
  };
  const dirtyCount = Object.keys(edits).length;
  const pageKeys = shown.map((row) => row.key);
  const selectedOnPage = pageKeys.filter((key) => checked.has(key)).length;
  const allPageChecked = pageKeys.length > 0 && selectedOnPage === pageKeys.length;
  const somePageChecked = selectedOnPage > 0 && !allPageChecked;

  function toggleAll() {
    setChecked((current) => {
      const next = new Set(current);
      const keys = shown.map((row) => row.key);
      if (keys.length > 0 && keys.every((key) => next.has(key))) {
        for (const key of keys) next.delete(key);
      } else {
        for (const key of keys) next.add(key);
      }
      return next;
    });
  }

  function toggleRow(key: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function changeOfficial(row: GeoPair, field: keyof GeoDraft, next: string) {
    const value = draftOf(row);
    setEdits((current) => ({ ...current, [row.key]: { ...value, [field]: next } }));
    setChecked((current) => {
      if (current.has(row.key)) return current;
      const copy = new Set(current);
      copy.add(row.key);
      return copy;
    });
  }

  function dropSaved(keys: string[]) {
    const saved = new Set(keys);
    setEdits((current) => {
      const next: Record<string, GeoDraft> = {};
      for (const [key, value] of Object.entries(current)) if (!saved.has(key)) next[key] = value;
      return next;
    });
    setChecked((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  }

  async function saveChecked() {
    const items = rows.filter((row) => checked.has(row.key)).map(payloadOf);
    if (!items.length || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await api<GeoBulkResult>("/api/mappings/geo", { method: "POST", body: JSON.stringify({ items }) });
      setFailures(result.failed);
      const text = result.saved
        ? result.failed.length
          ? `${result.saved} mapping disimpan. ${result.failed.length} baris gagal.`
          : `${result.saved} mapping disimpan.`
        : "Tidak ada mapping yang disimpan.";
      setToast(text);
      if (result.failed.length) reported(new Error(text));
      else reportedOk(text);
      const savedKeys = new Set(result.savedKeys);
      const failedKeys = new Set(result.failed.map((row) => row.key));
      setEdits((current) => {
        const next: Record<string, GeoDraft> = {};
        for (const [key, value] of Object.entries(current)) if (!savedKeys.has(key)) next[key] = value;
        return next;
      });
      setChecked((current) => {
        const next = new Set<string>();
        for (const key of current) if (!savedKeys.has(key)) next.add(key);
        for (const key of failedKeys) next.add(key);
        return next;
      });
      await refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Gagal menyimpan.";
      setMessage(text);
      reported(error, "Gagal menyimpan.");
    } finally {
      setSaving(false);
    }
  }

  async function approve(row: GeoPair) {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await api("/api/mappings/geo", { method: "POST", body: JSON.stringify(payloadOf(row)) });
      setToast(reportedOk("1 mapping disetujui."));
      setFailures((current) => current.filter((item) => item.key !== row.key));
      await refresh();
      dropSaved([row.key]);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Gagal menyimpan.";
      setMessage(text);
      reported(error, "Gagal menyimpan.");
    } finally {
      setSaving(false);
    }
  }

  async function saveManual() {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await api("/api/mappings/geo", { method: "POST", body: JSON.stringify(draft) });
      setAdding(false);
      setDraft({ provinceRaw: "", cityRaw: "", provinceOfficial: "", cityOfficial: "" });
      setToast(reportedOk("Mapping wilayah disimpan."));
      await refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Gagal menyimpan.";
      setMessage(text);
      reported(error, "Gagal menyimpan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="pagehead">
        <div className="desc">Satu baris untuk setiap kombinasi provinsi dan kota dari Jubelio. Centang baris lalu Simpan untuk menyimpan sekaligus. Setujui hanya muncul bila ada rekomendasi yang belum dikonfirmasi.</div>
        <div className="actions">
          <button className="btn pri" onClick={() => setAdding(true)}>Tambah</button>
        </div>
      </div>
      {pending ? <div className="pendbar"><b>{pending}</b> wilayah baru perlu di-mapping.</div> : <div className="note" style={{ marginBottom: 12 }}>Semua provinsi dan kota sudah termapping.</div>}
      {dirtyCount ? <div className="note" style={{ marginBottom: 12 }}>Ada {dirtyCount} baris yang diubah dan belum disimpan. Mengganti filter atau halaman tidak menghapus perubahan itu.</div> : null}
      {message ? <div className="note" style={{ marginBottom: 12 }}>{message}</div> : null}
      {failures.length ? <div className="warnbox" style={{ marginBottom: 12 }}><b>{failures.length} baris gagal disimpan dan tetap dicentang.</b><ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{failures.map((row) => <li key={row.key}>{row.label}: {row.error}</li>)}</ul></div> : null}
      <div className="filterbar">
        <div className="f grow"><label>Cari</label><input value={q} placeholder="Provinsi atau kota…" onChange={(event) => { setQ(event.target.value); listing.setPage(0); }} /></div>
        <div className="f"><label>Status mapping</label>
          <select value={mapFilter} onChange={(event) => { setMapFilter(event.target.value as "belum" | "sudah" | "semua"); listing.setPage(0); }}>
            <option value="belum">Belum termapping</option>
            <option value="sudah">Sudah termapping</option>
            <option value="semua">Semua</option>
          </select>
        </div>
      </div>
      <TableShell loading={loading}>
        <div className="th3">
          <ActionButton className="btn pri" disabled={checked.size === 0 || saving} onClick={() => saveChecked()}>Simpan ({checked.size})</ActionButton>
          <label className="only-mobile" style={{ alignItems: "center", gap: 6 }}>
            <SelectAllBox checked={allPageChecked} indeterminate={somePageChecked} disabled={!shown.length || saving} onChange={toggleAll} label="Pilih semua baris di halaman ini" />
            Pilih semua
          </label>
          <span className="small mut">{checked.size ? "Simpan menulis semua baris yang dicentang, termasuk yang ada di halaman lain." : "Centang baris yang akan disimpan."}</span>
        </div>
        <div className="tscroll"><table className="cards small">
        <thead><tr>
          <th className="nowrap"><SelectAllBox checked={allPageChecked} indeterminate={somePageChecked} disabled={!shown.length || saving} onChange={toggleAll} label="Pilih semua baris di halaman ini" /></th>
          <th>Provinsi (Jubelio)</th><th>Provinsi standar</th><th>Kota (Jubelio)</th><th>Kota standar</th><th>Tanggal mapping</th><th>Status</th><th>Aksi</th>
        </tr></thead>
        <tbody>
          {shown.map((row, index) => {
            const value = draftOf(row);
            const cityOptions = value.provinceOfficial ? citiesInProvince(value.provinceOfficial) : OFFICIAL_CITIES.map((city) => city.name);
            const listId = `kota-geo-${index}`;
            const recommendation = recommendationOf(row);
            return (
              <tr key={row.key}>
                <td data-label="Pilih"><input type="checkbox" checked={checked.has(row.key)} disabled={saving} aria-label={`Pilih ${row.provinceRaw} ${row.cityRaw}`.trim()} onChange={() => toggleRow(row.key)} /></td>
                <td data-label="Provinsi (Jubelio)"><span className="mono">{row.provinceRaw || "—"}</span></td>
                <td data-label="Provinsi standar">
                  <input list="provinsi-resmi" value={value.provinceOfficial} placeholder={row.provinceSuggestion || "Pilih"} onChange={(event) => changeOfficial(row, "provinceOfficial", event.target.value)} />
                  {row.pending && row.provinceSuggestion && value.provinceOfficial !== row.provinceSuggestion ? <div className="small mut">Saran: {row.provinceSuggestion}</div> : null}
                </td>
                <td data-label="Kota (Jubelio)"><span className="mono">{row.cityRaw || "—"}</span></td>
                <td data-label="Kota standar">
                  <input list={listId} value={value.cityOfficial} placeholder={row.citySuggestion || "Pilih"} disabled={!row.cityRaw} onChange={(event) => changeOfficial(row, "cityOfficial", event.target.value)} />
                  <datalist id={listId}>{cityOptions.map((name) => <option key={name} value={name} />)}</datalist>
                  {row.pending && row.citySuggestion && value.cityOfficial !== row.citySuggestion ? <div className="small mut">Saran: {row.citySuggestion}</div> : null}
                </td>
                <td data-label="Tanggal mapping">{row.pending ? <span className="pill p-warn">Belum termapping</span> : dateText(row.mappedAt)}</td>
                <td data-label="Status">{row.pending ? <span className="pill p-warn">Belum</span> : <span className="pill p-ok">Sudah</span>}</td>
                <td className="nowrap" data-label="Aksi">
                  {recommendation ? <ActionButton className="btn sm" disabled={saving} onClick={() => approve(row)}>Setujui</ActionButton> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      <Pager page={safePage} pageSize={listing.pageSize} total={filtered.length} shown={shown.length} onPage={listing.setPage} onPageSize={listing.setPageSize} />
      </TableShell>
      <datalist id="provinsi-resmi">{OFFICIAL_PROVINCES.map((name) => <option key={name} value={name} />)}</datalist>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
      {adding ? <div className="modal-bg on"><div className="modal">
        <h2>Tambah mapping wilayah</h2>
        <div className="small mut">Satu kombinasi provinsi dan kota dari Jubelio.</div>
        <div className="grid g2 mt">
          <div className="f"><label>Provinsi (Jubelio)</label><input value={draft.provinceRaw} onChange={(event) => setDraft({ ...draft, provinceRaw: event.target.value })} /></div>
          <div className="f"><label>Provinsi standar</label><input list="provinsi-resmi" value={draft.provinceOfficial} onChange={(event) => setDraft({ ...draft, provinceOfficial: event.target.value })} /></div>
          <div className="f"><label>Kota (Jubelio)</label><input value={draft.cityRaw} onChange={(event) => setDraft({ ...draft, cityRaw: event.target.value })} /></div>
          <div className="f"><label>Kota standar</label><input list="kota-resmi-baru" value={draft.cityOfficial} onChange={(event) => setDraft({ ...draft, cityOfficial: event.target.value })} /></div>
        </div>
        <datalist id="kota-resmi-baru">{(draft.provinceOfficial ? citiesInProvince(draft.provinceOfficial) : OFFICIAL_CITIES.map((city) => city.name)).map((name) => <option key={name} value={name} />)}</datalist>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={() => setAdding(false)}>Batal</button>
          <ActionButton className="btn pri" disabled={saving} onClick={() => saveManual()}>Simpan</ActionButton>
        </div>
      </div></div> : null}
    </div>
  );
}

function ChannelMapping() {
  const [mapFilter, setMapFilter] = useState<"belum" | "sudah" | "semua">("belum");
  const [channels, setChannels] = useState<ChannelMapRow[]>([]);
  const [provinces, setProvinces] = useState<ProvinceMapRow[]>([]);
  const [cities, setCities] = useState<CityMapRow[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [officials, setOfficials] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState<{ id: string; label: string; official: string }[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      await loadRows();
    } finally {
      setLoading(false);
    }
  }

  async function loadRows() {
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
    const pending = channel.filter((row) => isMappingPending(row)).length;
    setMapFilter((current) => current === "belum" && pending === 0 ? "semua" : current);
  }
  useEffect(() => { load().catch((error: Error) => setMessage(error.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    try {
      await api("/api/mappings/channel", { method: "POST", body: JSON.stringify(row) });
      setMessage(reportedOk("Mapping channel disimpan."));
      await load();
    } catch (error) {
      setMessage(reported(error, "Gagal menyimpan mapping."));
    }
  }

  async function saveReview(row: ReviewItem) {
    try {
      const official = (officials[row.id] ?? suggestions.get(row.id)?.official ?? "").trim();
      await api("/api/reviews", { method: "POST", body: JSON.stringify({ id: row.id, official }) });
      setMessage(reportedOk("Mapping disimpan dan review ditutup."));
      await load();
    } catch (error) {
      setMessage(reported(error, "Gagal menyimpan mapping."));
    }
  }

  async function acceptBulk() {
    if (!bulk?.length) return;
    try {
      await api("/api/reviews", { method: "POST", body: JSON.stringify({ items: bulk.map((row) => ({ id: row.id, official: row.official })) }) });
      setMessage(reportedOk(`${bulk.length} saran disimpan.`));
      await load();
    } catch (error) {
      setMessage(reported(error, "Gagal menyimpan saran."));
    }
  }

  const pendingChannel = channels.filter((row) => isMappingPending(row)).length;
  const keep = <T extends { mappedAt?: string | null; needsReview?: boolean; official?: string; channel?: string; store?: string }>(rows: T[]) => rows.filter((row) => mapFilter === "semua" || (mapFilter === "belum") === isMappingPending(row));
  const channelPage = useClientPage(keep(channels), "channel-map", 25);
  const reviewPage = useClientPage(reviews, "channel-reviews", 25);
  const dateText = (value?: string | null) => value ? new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "—";

  return (
    <div>
      <div className="pagehead">
        <div className="desc">Mapping hanya Channel & Toko di Jubelio ke Channel & Toko di Web. Tanggal mapping kosong = belum termapping. Gudang, cabang, dan pelanggan tidak diisi di sini.</div>
      </div>
      {pendingChannel ? <div className="pendbar"><b>{pendingChannel}</b> belum termapping.</div> : <div className="note" style={{ marginBottom: 12 }}>Tidak ada yang menunggu mapping.</div>}
      <div className="filterbar">
        <div className="f"><label>Status mapping</label>
          <select value={mapFilter} onChange={(event) => { setMapFilter(event.target.value as "belum" | "sudah" | "semua"); channelPage.setPage(0); }}>
            <option value="belum">Belum termapping</option>
            <option value="sudah">Sudah termapping</option>
            <option value="semua">Semua</option>
          </select>
        </div>
      </div>
      {message ? <div className="note" style={{ marginBottom: 12 }}>{message}</div> : null}
      {reviews.length ? <div className="warnbox" style={{ marginBottom: 12 }}>{reviews.length} nilai belum dipetakan. Provinsi dan kota dicocokkan tanpa membedakan huruf besar atau spasi. Saran nama resmi baru tersimpan setelah Anda menyetujuinya.</div> : <div className="note" style={{ marginBottom: 12 }}>Semua nilai yang sudah lewat impor punya baris mapping. Nilai baru akan muncul di sini.</div>}
      {(
        <TableShell loading={loading} className="card">
          <button className="btn sm" onClick={() => setChannels((rows) => [...rows, { id: "", channelRaw: "", storeRaw: "", channel: "", store: "", needsReview: true }])}>+ Baris</button>
          <table className="cards"><thead><tr><th>Channel di Jubelio</th><th>Toko di Jubelio</th><th>Channel di Web</th><th>Toko di Web</th><th>Tanggal mapping</th><th></th></tr></thead><tbody>
            {channelPage.shown.map((row) => {
              const index = channels.indexOf(row);
              return (
              <tr key={row.id || index}>
                <td data-label="Channel mentah"><input value={row.channelRaw} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, channelRaw: event.target.value } : item))} /></td>
                <td data-label="Toko mentah"><input value={row.storeRaw} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, storeRaw: event.target.value } : item))} /></td>
                <td data-label="Channel"><input value={row.channel} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, channel: event.target.value } : item))} /></td>
                <td data-label="Toko"><input value={row.store} onChange={(event) => setChannels((rows) => rows.map((item, i) => i === index ? { ...item, store: event.target.value } : item))} /></td>
                <td data-label="Tanggal mapping">{row.needsReview || isMappingPending(row) ? <span className="pill p-warn">Belum termapping</span> : dateText(row.mappedAt)}</td>
                <td><ActionButton className="btn sm" onClick={() => saveChannel({ ...row, needsReview: false })}>Simpan</ActionButton></td>
              </tr>
              );
            })}
          </tbody></table>
          <Pager page={channelPage.page} pageSize={channelPage.pageSize} total={channelPage.total} shown={channelPage.shown.length} onPage={channelPage.setPage} onPageSize={channelPage.setPageSize} />
        </TableShell>
      )}
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
                <ActionButton className="btn pri sm" onClick={() => acceptBulk()}>Simpan semua saran ini</ActionButton>
                <button className="btn sm" onClick={() => setBulk(null)}>Batal</button>
              </div>
            </div>
          ) : null}
          {reviewPage.shown.map((row) => {
            const suggestion = suggestions.get(row.id);
            if (!suggestion) {
              return <div key={row.id} className="small">{row.kind}: {row.rawKey} <ActionButton className="btn sm" onClick={() => api("/api/reviews", { method: "POST", body: JSON.stringify({ id: row.id }) }).then(() => { setMessage(reportedOk("Review ditutup.")); return load(); }).catch((error: Error) => setMessage(reported(error, "Gagal menutup review.")))}>Tandai selesai</ActionButton></div>;
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
                <ActionButton className="btn sm" onClick={() => saveReview(row)}>Simpan mapping</ActionButton>
                {suggestion.ambiguous ? <span className="small">Beberapa nama cocok. Pilih yang resmi.</span> : null}
                {suggestion.fromMapping && suggestion.official ? <span className="small">Sudah ada di mapping: {suggestion.official}</span> : null}
              </div>
            );
          })}
          <Pager page={reviewPage.page} pageSize={reviewPage.pageSize} total={reviewPage.total} shown={reviewPage.shown.length} onPage={reviewPage.setPage} onPageSize={reviewPage.setPageSize} />
        </div>
      ) : null}
      <datalist id="provinsi-resmi">{OFFICIAL_PROVINCES.map((name) => <option key={name} value={name} />)}</datalist>
      <datalist id="kota-resmi">{cityOptions.map((name) => <option key={name} value={name} />)}</datalist>
    </div>
  );
}

export function MappingView({ scope = "channel" }: { scope?: "channel" | "geo" }) {
  if (scope === "geo") return <GeoMapping />;
  return <ChannelMapping />;
}

type DraftRow = { sku: string; qty: string; weight: string };

function blankComponent(): DraftRow {
  return { sku: "", qty: "1", weight: "100" };
}

export function BobotView() {
  const [bundles, setBundles] = useState<BundleDefinition[]>([]);
  const [reviews, setReviews] = useState<{ rawKey: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"belum" | "sudah" | "semua">("belum");
  const [draft, setDraft] = useState<{ bundleSku: string; originalSku: string; creating: boolean; rows: DraftRow[] } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const result = await api<{ bundles: BundleDefinition[]; reviews: { rawKey: string }[] }>("/api/weights");
      setBundles(result.bundles);
      setReviews(result.reviews);
      const waiting = result.reviews.length + result.bundles.filter((row) => isBundlePending(row)).length;
      setFilter((current) => current === "belum" && waiting === 0 ? "semua" : current);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load().catch((error: Error) => setMessage(error.message)); }, []);

  function applySplit(mode: "qty" | "equal") {
    setDraft((current) => {
      if (!current) return current;
      const weights = splitWeights(current.rows.map((row) => ({ qty: Number(row.qty) || 0 })), mode);
      return { ...current, rows: current.rows.map((row, index) => ({ ...row, weight: String(weights[index] ?? "") })) };
    });
  }

  function saveDraft() {
    if (!draft) return;
    const components = draft.rows.map((row) => ({ sku: row.sku.trim(), qty: Number(row.qty), weightPct: Number(row.weight) }));
    if (!draft.bundleSku.trim()) {
      setMessage("SKU paket wajib diisi.");
      return;
    }
    const error = weightTotalError(components);
    if (error) {
      setMessage(error);
      return;
    }
    const bundleSku = draft.bundleSku.trim();
    return api("/api/weights", { method: "POST", body: JSON.stringify({ bundleSku, components }) })
      .then(() => {
        if (draft.originalSku && draft.originalSku !== bundleSku) {
          return api("/api/weights", { method: "POST", body: JSON.stringify({ deleteBundle: draft.originalSku }) });
        }
        return null;
      })
      .then(() => { setDraft(null); setMessage(reportedOk("Paket disimpan.")); return load(); })
      .catch((err: Error) => setMessage(reported(err, "Gagal menyimpan paket.")));
  }

  const pending = reviews.length + bundles.filter((row) => isBundlePending(row)).length;
  const filteredBundles = bundles.filter((row) => filter === "semua" || (filter === "belum") === isBundlePending(row));
  const bundlePage = useClientPage(filteredBundles, "bundles", 25);
  const total = draft ? Math.round(draft.rows.reduce((sum, row) => sum + (Number(row.weight) || 0), 0) * 10000) / 10000 : 0;
  return (
    <div>
      <div className="pagehead">
        <div className="desc">Setiap paket punya daftar SKU komponen, qty, dan bobot persen. Total bobot harus 100%. Revenue dan diskon dibagi menurut persen itu. HPP komponen tetap HPP satuan × qty.</div>
        <div className="actions"><button className="btn pri" onClick={() => { setMessage(null); setDraft({ bundleSku: "", originalSku: "", creating: true, rows: [blankComponent()] }); }}>Tambah</button></div>
      </div>
      {pending ? <div className="pendbar"><b>{pending}</b> bobot belum terupdate.</div> : null}
      <div className="filterbar">
        <div className="f"><label>Status</label>
          <select value={filter} onChange={(event) => { setFilter(event.target.value as "belum" | "sudah" | "semua"); bundlePage.setPage(0); }}>
            <option value="belum">Belum terupdate</option>
            <option value="sudah">Sudah terupdate</option>
            <option value="semua">Semua</option>
          </select>
        </div>
        <label className="btn">Impor Excel<input type="file" accept=".xlsx" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const form = new FormData();
          form.set("file", file);
          track(fetch("/api/weights", { method: "POST", body: form })).then(async (response) => {
            if (!response.ok) {
              const body = await response.json().catch(() => ({})) as { error?: string };
              throw new Error(body.error || "Impor gagal.");
            }
            setMessage(reportedOk("Impor bobot selesai."));
            return load();
          }).catch((error: Error) => setMessage(reported(error, "Impor gagal.")));
        }} /></label>
      </div>
      {message ? <div className="note">{message}</div> : null}
      {filter !== "sudah" && reviews.length ? <div className="warnbox">Bobot belum ada untuk: {reviews.map((row) => row.rawKey).join(", ")}.</div> : null}
      <TableShell loading={loading} className="tablecard mt"><div className="tscroll"><table className="cards"><thead><tr><th>Paket</th><th>Komponen</th><th>Total</th><th>Tanggal updated</th><th></th></tr></thead><tbody>
        {bundlePage.shown.map((row) => {
          const sum = Math.round(row.components.reduce((value, item) => value + item.weightPct, 0) * 10000) / 10000;
          return (
            <tr key={row.bundleSku}>
              <td data-label="Paket">{row.bundleSku}</td>
              <td data-label="Komponen">{row.components.map((item) => `${item.sku} × ${item.qty} · ${item.weightPct}%`).join(", ") || "—"}</td>
              <td data-label="Total">{sum}%</td>
              <td data-label="Tanggal updated">{isBundlePending(row) ? <span className="pill p-warn">Belum terupdate</span> : row.updatedAt ? new Date(row.updatedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "—"}</td>
              <td>
                <button className="btn sm" onClick={() => setDraft({ bundleSku: row.bundleSku, originalSku: row.bundleSku, creating: false, rows: row.components.map((item) => ({ sku: item.sku, qty: String(item.qty), weight: String(item.weightPct) })) })}>Edit</button>
                <ActionButton className="btn sm" onClick={() => api("/api/weights", { method: "POST", body: JSON.stringify({ deleteBundle: row.bundleSku }) }).then(() => { setMessage(reportedOk("Paket dihapus.")); return load(); }).catch((error: Error) => setMessage(reported(error, "Gagal menghapus paket.")))}>Hapus</ActionButton>
              </td>
            </tr>
          );
        })}
      </tbody></table></div>
      <Pager page={bundlePage.page} pageSize={bundlePage.pageSize} total={bundlePage.total} shown={bundlePage.shown.length} onPage={bundlePage.setPage} onPageSize={bundlePage.setPageSize} />
      </TableShell>
      {draft ? (
        <div className="modal-bg on"><div className="modal">
          <h2>{draft.creating ? "Tambah paket" : "Ubah paket"}</h2>
          <div className="f"><label>SKU paket</label><input value={draft.bundleSku} onChange={(event) => setDraft({ ...draft, bundleSku: event.target.value })} /></div>
          <div className="note mt">Bobot dibagi rata atau mengikuti qty. Komponen terakhir menampung selisih pembulatan supaya total 100%.</div>
          {draft.rows.map((row, index) => (
            <div className="filters mt" key={index}>
              <input placeholder="SKU komponen" value={row.sku} onChange={(event) => setDraft({ ...draft, rows: draft.rows.map((item, itemIndex) => itemIndex === index ? { ...item, sku: event.target.value } : item) })} />
              <input placeholder="Qty" type="number" value={row.qty} onChange={(event) => setDraft({ ...draft, rows: draft.rows.map((item, itemIndex) => itemIndex === index ? { ...item, qty: event.target.value } : item) })} />
              <input placeholder="Bobot %" type="number" value={row.weight} onChange={(event) => setDraft({ ...draft, rows: draft.rows.map((item, itemIndex) => itemIndex === index ? { ...item, weight: event.target.value } : item) })} />
              <button className="btn sm" onClick={() => setDraft({ ...draft, rows: draft.rows.filter((_, itemIndex) => itemIndex !== index) })}>Hapus</button>
            </div>
          ))}
          <div className="filters mt">
            <button className="btn" onClick={() => setDraft((current) => {
              if (!current) return current;
              const rows = [...current.rows, { sku: "", qty: "1", weight: "" }];
              const weights = splitWeights(rows.map((row) => ({ qty: Number(row.qty) || 0 })), "qty");
              return { ...current, rows: rows.map((row, rowIndex) => ({ ...row, weight: String(weights[rowIndex] ?? "") })) };
            })}>Tambah komponen</button>
            <button className="btn" onClick={() => applySplit("equal")}>Bagi rata</button>
            <button className="btn" onClick={() => applySplit("qty")}>Sesuai qty</button>
            <span className={total === 100 ? "pill p-ok" : "pill p-warn"}>Total {total}%</span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => setDraft(null)}>Batal</button>
            <ActionButton className="btn pri" onClick={() => saveDraft()}>Simpan</ActionButton>
          </div>
        </div></div>
      ) : null}
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
        {connected && info.accurate.missingCustomerScopes?.length ? <div className="warnbox mt">Token Accurate belum mencakup izin pelanggan ({info.accurate.missingCustomerScopes.join(", ")}). Klik Hubungkan Accurate lagi supaya nama pembeli bisa dicari dan dibuat di Accurate.</div> : null}
        <p className="small">Redirect: {info.accurate.redirectUri}</p>
        <p className="small mut">Client secret tidak disimpan di kode. Isi ACCURATE_CLIENT_ID dan ACCURATE_CLIENT_SECRET di environment.</p>
        <div className="filters">
          <a className="btn pri" href="/api/accurate/authorize">Hubungkan Accurate</a>
          <ActionButton className="btn" onClick={() => api<{ ok?: boolean; error?: string }>("/api/accurate/test", { method: "POST" }).then(() => setMessage(reportedOk("Koneksi Accurate OK."))).catch((error: Error) => setMessage(reported(error, "Tes koneksi gagal.")))}>Tes koneksi</ActionButton>
          <ActionButton className="btn" onClick={() => api("/api/accurate/disconnect", { method: "POST" }).then(() => location.reload())}>Putuskan</ActionButton>
        </div>
        <div className="mt">{info.accurate.salesPush ? <span className="pill p-ok">Pengiriman penjualan aktif</span> : <span className="pill p-warn">Hanya-baca · penjualan ditahan</span>}</div>
        {info.accurate.salesPush && !settings.accurateDatabaseId ? <div className="warnbox mt">Pengiriman penjualan aktif, tetapi ID database Accurate kosong. Pilih database sebelum sync.</div> : null}
        <DatabaseField connected={connected} value={settings.accurateDatabaseId} onChange={(accurateDatabaseId) => setSettings({ ...settings, accurateDatabaseId })} />
        <div className="f mt"><label>Tanggal lapor PPN terakhir</label><input type="date" value={settings.ppnReportDate || ""} onChange={(event) => setSettings({ ...settings, ppnReportDate: event.target.value })} /></div>
        <div className="small mut">Pesanan bertanggal pada atau sebelum tanggal ini sudah tutup buku.</div>
        <div className="f mt"><label>Gudang default</label><input value={settings.defaultWarehouse || ""} placeholder="Utama" onChange={(event) => setSettings({ ...settings, defaultWarehouse: event.target.value })} /></div>
        <div className="small mut">Satu gudang untuk semua baris faktur bila lokasi tidak punya mapping. Isi nama gudang Accurate, biasanya Utama.</div>
        <div className="f mt"><label>Cabang default</label><input value={settings.defaultBranch || ""} onChange={(event) => setSettings({ ...settings, defaultBranch: event.target.value })} /></div>
        <label className="small"><input type="checkbox" checked={settings.requireWarehouse} onChange={(event) => setSettings({ ...settings, requireWarehouse: event.target.checked })} /> Wajibkan gudang bila lokasi terisi</label>
        <div className="f mt"><label>Lokasi Jubelio yang ditarik (satu per baris)</label>
          <textarea rows={8} value={(settings.jubelioLocations ?? []).join("\n")} onChange={(event) => setSettings({ ...settings, jubelioLocations: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })} />
        </div>
        <div className="mt"><ActionButton className="btn pri" onClick={() => api("/api/settings", { method: "PUT", body: JSON.stringify(settings) }).then(() => setMessage(reportedOk("Pengaturan disimpan."))).catch((error: Error) => setMessage(reported(error, "Gagal menyimpan pengaturan.")))}>Simpan</ActionButton></div>
      </div>
      <div className="card">
        <h3>Pelanggan & gudang</h3>
        <p className="small">Faktur memakai nama pembeli pada pesanan. Nama yang sudah ada di Accurate dipakai nomornya. Nama yang belum ada dibuat, lalu disimpan supaya tidak dicari ulang. Mapping channel atau toko tidak dipakai lagi.</p>
        <div className="f mt"><label>Nomor pelanggan default</label><input value={settings.defaultCustomerNo} onChange={(event) => setSettings({ ...settings, defaultCustomerNo: event.target.value })} /></div>
        <div className="f mt"><label>Nama pelanggan default</label><input value={settings.defaultCustomerName} onChange={(event) => setSettings({ ...settings, defaultCustomerName: event.target.value })} /></div>
        <p className="small mut">Pelanggan default hanya dipakai bila pesanan tidak punya nama pembeli. Gudang dicocokkan ke lokasi Jubelio bila ada; selain itu dipakai gudang default.</p>
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
          <li>Pesanan yang sudah sync tidak bisa dihapus. {info.accurate.salesPush ? "Pengiriman penjualan ke Accurate sedang aktif." : "Pengiriman jual/retur ditahan sampai ACCURATE_SALES_PUSH=enabled."}</li>
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
          <ActionButton className="btn" onClick={() => api("/api/jubelio/test", { method: "POST" }).then(() => setMessage(reportedOk("Koneksi Jubelio OK."))).catch((error: Error) => setMessage(reported(error, "Tes koneksi gagal.")))}>Tes koneksi</ActionButton>
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
