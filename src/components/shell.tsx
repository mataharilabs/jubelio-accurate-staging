"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LayoutDashboard, LogOut, Menu, Scale, Settings, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/cn";

const links = [
  { href: "/", label: "Dasbor", icon: LayoutDashboard },
  { href: "/bobot", label: "Bobot bundle", icon: Scale },
  { href: "/pengaturan", label: "Pengaturan", icon: Settings },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");

  useEffect(() => {
    api<{ email: string }>("/api/auth/me")
      .then((me) => setEmail(me.email))
      .catch(() => setEmail(""));
  }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/masuk");
    router.refresh();
  }

  return (
    <div className="min-h-screen md:flex">
      {open ? (
        <button className="fixed inset-0 z-20 bg-[#172033]/50 md:hidden" aria-label="Tutup menu" onClick={() => setOpen(false)} />
      ) : null}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-sidebar text-white transition md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="border-b border-white/10 px-5 py-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#d6b36a]">Asiacommerce</div>
          <div className="mt-1 text-lg font-semibold leading-tight">Staging penjualan</div>
          <p className="mt-2 text-xs leading-relaxed text-white/60">Jubelio harian, ditinjau di sini, baru masuk Accurate.</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
          {links.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white",
                  active && "bg-white/15 text-white",
                )}
              >
                <Icon className="h-4 w-4" />
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/10 px-4 py-4">
          <div className="truncate text-xs text-white/60">{email || "Admin"}</div>
          <button onClick={logout} className="mt-2 flex items-center gap-2 text-sm text-white/80 hover:text-white">
            <LogOut className="h-4 w-4" />
            Keluar
          </button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/90 px-4 py-3 backdrop-blur md:hidden">
          <button onClick={() => setOpen((value) => !value)} className="rounded-md p-1" aria-label="Menu">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <span className="text-sm font-semibold">Asiacommerce</span>
        </div>
        <main className="px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
