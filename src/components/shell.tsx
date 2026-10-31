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
];

const TITLES: Record<string, string> = {
  "/": "Dashboard E-Commerce",
  "/sync": "Sync ke Accurate",
  "/pesanan": "Data Pesanan",
  "/pengaturan/channel": "Mapping Channel & Toko",
  "/pengaturan/bobot": "Bobot Bundle",
  "/pengaturan/accurate": "Koneksi Accurate",
};

type Meta = { lastImportAt: string | null; accurateConnected: boolean; mode: string; accurateUser: string | null };

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
          <div className="avatar" title={email}>{initials}</div>
        </div>
        <div className="wrap">{children}</div>
      </div>
    </div>
  );
}
