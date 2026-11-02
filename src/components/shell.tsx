"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

const LINKS = [
  { href: "/", label: "Dashboard E-Commerce", group: "Menu" },
  { href: "/sync", label: "Sync ke Accurate", group: "Menu" },
  { href: "/pesanan", label: "Data Pesanan", group: "Menu" },
  { href: "/pengaturan/channel", label: "Mapping Channel & Toko", group: "Pengaturan" },
  { href: "/pengaturan/bobot", label: "Bobot Bundle", group: "Pengaturan" },
  { href: "/pengaturan/accurate", label: "Koneksi Accurate", group: "Pengaturan" },
  { href: "/pengaturan/pengguna", label: "Pengguna & peran", group: "Pengaturan" },
  { href: "/pengaturan/audit", label: "Jejak audit", group: "Pengaturan" },
];

const TITLES: Record<string, string> = {
  "/": "Dashboard E-Commerce",
  "/sync": "Sync ke Accurate",
  "/pesanan": "Data Pesanan",
  "/pengaturan/channel": "Mapping Channel & Toko",
  "/pengaturan/bobot": "Bobot Bundle",
  "/pengaturan/accurate": "Koneksi Accurate",
  "/pengaturan/pengguna": "Pengguna & peran",
  "/pengaturan/audit": "Jejak audit",
};

type Meta = { lastImportAt: string | null; accurateConnected: boolean; mode: string; accurateUser: string | null };

function Bell() {
  const [open, setOpen] = useState(false);
  const [notices, setNotices] = useState<{ id: string; title: string; body: string; read: boolean; createdAt: string }[]>([]);
  useEffect(() => {
    api<{ notices: { id: string; title: string; body: string; read: boolean; createdAt: string }[] }>("/api/notifications")
      .then((result) => setNotices(result.notices))
      .catch(() => setNotices([]));
  }, [open]);
  const unread = notices.filter((notice) => !notice.read).length;
  return (
    <div style={{ position: "relative" }}>
      <button className="btn sm" onClick={() => setOpen((value) => !value)} aria-label="Notifikasi">Notifikasi{unread ? ` (${unread})` : ""}</button>
      {open ? (
        <div className="card" style={{ position: "absolute", right: 0, top: "110%", width: 320, maxWidth: "80vw", zIndex: 70, maxHeight: 360, overflow: "auto" }}>
          <button className="btn sm" onClick={() => api("/api/notifications", { method: "POST", body: JSON.stringify({ ids: notices.map((notice) => notice.id) }) }).then(() => setNotices((rows) => rows.map((row) => ({ ...row, read: true }))))}>Tandai dibaca</button>
          {notices.length ? notices.map((notice) => (
            <div key={notice.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <b className="small">{notice.title}</b>
              <div className="small mut">{notice.body}</div>
            </div>
          )) : <div className="small mut">Belum ada notifikasi.</div>}
        </div>
      ) : null}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [meta, setMeta] = useState<Meta | null>(null);

  useEffect(() => {
    api<{ email: string }>("/api/auth/me").then((me) => setEmail(me.email)).catch(() => setEmail(""));
    api<Meta>("/api/meta").then(setMeta).catch(() => setMeta(null));
  }, [pathname]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/masuk");
    router.refresh();
  }

  const initials = (email || "ML").slice(0, 2).toUpperCase();
  const last = meta?.lastImportAt
    ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(meta.lastImportAt))
    : "belum ada";

  return (
    <div className="app">
      {open ? <button className="backdrop" aria-label="Tutup menu" onClick={() => setOpen(false)} /> : null}
      <aside className={`nav ${open ? "open" : ""}`}>
        <div className="brand">Jubelio → Accurate<small>Admin Penjualan</small></div>
        <nav>
          {["Menu", "Pengaturan"].map((group) => (
            <div key={group}>
              <div className="sec">{group}</div>
              {LINKS.filter((link) => link.group === group).map((link) => {
                const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
                return (
                  <Link key={link.href} href={link.href} className={active ? "on" : ""} onClick={() => setOpen(false)}>
                    {link.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          {meta?.accurateConnected ? "Accurate terhubung" : "Accurate belum terhubung"}
          <br />
          {meta?.mode === "supabase" ? "Data di Supabase" : "Mode lokal"}
          <button onClick={logout} className="btn ghost" style={{ marginTop: 8, padding: 0 }}>Keluar</button>
        </div>
      </aside>
      <div className="main">
        <div className="top">
          <button className="btn menu-btn" onClick={() => setOpen(true)} aria-label="Buka menu">Menu</button>
          <h1>{TITLES[pathname] ?? "Jubelio → Accurate"}</h1>
          <div className="sp" />
          <span className="mut small">Terakhir impor: {last} WIB</span>
          <Bell />
          <div className="avatar" title={email}>{initials}</div>
        </div>
        <div className="wrap">{children}</div>
      </div>
    </div>
  );
}
