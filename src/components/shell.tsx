"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

type NavLink = { href: string; label: string; group: string; soon?: boolean; badge?: "channel" | "geo" | "bundle" | "hpp" };

const LINKS: NavLink[] = [
  { href: "/", label: "Toko", group: "Dashboard" },
  { href: "/produk", label: "Produk", group: "Dashboard" },
  { href: "/pesanan", label: "Pesanan", group: "Master Data" },
  { href: "/produk/daftar", label: "Produk", group: "Master Data" },
  { href: "/produk/merek", label: "Brand", group: "Master Data" },
  { href: "/produk/kategori", label: "Kategori", group: "Master Data" },
  { href: "/produk/hpp", label: "HPP", group: "Master Data", badge: "hpp" },
  { href: "/pembayaran", label: "Pembayaran", group: "Master Data", soon: true },
  { href: "/marketing", label: "Marketing spending", group: "Master Data", soon: true },
  { href: "/sync", label: "Pesanan", group: "Sinkron ke Accurate" },
  { href: "/sync/pembayaran", label: "Pembayaran", group: "Sinkron ke Accurate", soon: true },
  { href: "/pengaturan/channel", label: "Mapping Channel & Toko", group: "Pengaturan", badge: "channel" },
  { href: "/pengaturan/wilayah", label: "Mapping Provinsi & Kota", group: "Pengaturan", badge: "geo" },
  { href: "/pengaturan/bobot", label: "Bobot bundle", group: "Pengaturan", badge: "bundle" },
  { href: "/pengaturan/jubelio", label: "Koneksi Jubelio", group: "Pengaturan" },
  { href: "/pengaturan/accurate", label: "Koneksi Accurate", group: "Pengaturan" },
  { href: "/pengaturan/pengguna", label: "Pengguna & Peran", group: "Pengaturan" },
];

const GROUPS = ["Dashboard", "Master Data", "Sinkron ke Accurate", "Pengaturan"];

const TITLES: Record<string, { crumb: string; title: string }> = {
  "/": { crumb: "Dashboard", title: "Toko" },
  "/produk": { crumb: "Dashboard", title: "Produk" },
  "/pesanan": { crumb: "Master Data", title: "Pesanan" },
  "/produk/daftar": { crumb: "Master Data", title: "Produk" },
  "/produk/merek": { crumb: "Master Data", title: "Brand" },
  "/produk/kategori": { crumb: "Master Data", title: "Kategori" },
  "/produk/hpp": { crumb: "Master Data", title: "HPP" },
  "/pembayaran": { crumb: "Master Data", title: "Pembayaran" },
  "/marketing": { crumb: "Master Data", title: "Marketing spending" },
  "/sync": { crumb: "Sinkron ke Accurate", title: "Pesanan" },
  "/sync/pembayaran": { crumb: "Sinkron ke Accurate", title: "Pembayaran" },
  "/pengaturan/channel": { crumb: "Pengaturan", title: "Mapping Channel & Toko" },
  "/pengaturan/wilayah": { crumb: "Pengaturan", title: "Mapping Provinsi & Kota" },
  "/pengaturan/bobot": { crumb: "Pengaturan", title: "Bobot bundle" },
  "/pengaturan/jubelio": { crumb: "Pengaturan", title: "Koneksi Jubelio" },
  "/pengaturan/accurate": { crumb: "Pengaturan", title: "Koneksi Accurate" },
  "/pengaturan/pengguna": { crumb: "Pengaturan", title: "Pengguna & Peran" },
  "/pengaturan/audit": { crumb: "Pengaturan", title: "Jejak audit" },
};

type Pending = { channel: number; geo: number; bundle: number; hpp: number };

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
  const [role, setRole] = useState("");
  const [pending, setPending] = useState<Pending>({ channel: 0, geo: 0, bundle: 0, hpp: 0 });

  useEffect(() => {
    api<{ email: string; role?: string }>("/api/auth/me").then((me) => { setEmail(me.email); setRole(me.role ?? ""); }).catch(() => setEmail(""));
    api<Pending>("/api/pending").then(setPending).catch(() => undefined);
  }, [pathname]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/masuk");
    router.refresh();
  }

  const initials = (email || "ML").slice(0, 2).toUpperCase();
  const current = TITLES[pathname] ?? { crumb: "Jubelio", title: "Accurate" };
  const activeHref = LINKS.filter((link) => link.href === "/" ? pathname === "/" : pathname === link.href || (link.href !== "/produk" && pathname.startsWith(link.href))).sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <div className="app">
      {open ? <button className="backdrop" aria-label="Tutup menu" onClick={() => setOpen(false)} /> : null}
      <aside className={`nav ${open ? "open" : ""}`}>
        <div className="brand">Jubelio ↔ Accurate<small>Admin E-Commerce · ecommerce.asiacommerce.id</small></div>
        <nav>
          {GROUPS.map((group) => (
            <div key={group}>
              <div className="sec">{group}</div>
              {LINKS.filter((link) => link.group === group).map((link) => {
                const count = link.badge ? pending[link.badge] : 0;
                return (
                  <Link key={link.href} href={link.href} className={activeHref === link.href ? "on" : ""} onClick={() => setOpen(false)}>
                    {link.label}
                    {link.soon ? <span className="soon">Segera</span> : null}
                    {!link.soon && count ? <span className="cnt" title="Perlu dibereskan">{count}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <button onClick={logout} className="btn ghost" style={{ padding: 0 }}>Keluar</button>
        </div>
      </aside>
      <div className="main">
        <div className="top">
          <button className="btn menu-btn" onClick={() => setOpen(true)} aria-label="Buka menu">Menu</button>
          <div>
            <div className="crumb">{current.crumb}</div>
            <h1>{current.title}</h1>
          </div>
          <div className="sp" />
          <span className="mut small hide-m">{email}{role ? ` · ${role}` : ""}</span>
          <Bell />
          <div className="avatar" title={email}>{initials}</div>
        </div>
        <div className="wrap">{children}</div>
      </div>
    </div>
  );
}
