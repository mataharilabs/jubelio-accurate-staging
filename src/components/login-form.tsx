"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [mode, setMode] = useState<"demo" | "supabase" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ mode: "demo" | "supabase"; emailHint: string | null }>("/api/auth/mode")
      .then((result) => {
        setMode(result.mode);
        setHint(result.emailHint);
        if (result.emailHint) setEmail(result.emailHint);
      })
      .catch(() => setMode(null));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal masuk.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <section className="hidden flex-col justify-between bg-sidebar px-10 py-12 text-white lg:flex">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b36a]">Asiacommerce Network</div>
          <h1 className="mt-6 max-w-md text-4xl font-semibold leading-tight">Penjualan Jubelio, rapi, sebelum jadi faktur Accurate.</h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/70">
            Unggah laporan harian, pecah bundle sesuai bobot, tinjau pesanan Lintas Jakarta dan Surabaya, lalu kirim faktur penjualan saat angka sudah beres.
          </p>
        </div>
        <p className="text-xs text-white/45">Hanya untuk admin internal. Kredensial Accurate tidak disimpan di peramban.</p>
      </section>
      <section className="flex items-center justify-center px-5 py-16">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-primary lg:hidden">Asiacommerce</div>
          <h2 className="mt-2 text-2xl font-semibold">Masuk</h2>
          <p className="mt-1 text-sm text-muted">
            {mode === "supabase"
              ? "Gunakan akun admin yang dibuat di Supabase Auth."
              : "Mode lokal aktif. Supabase belum dihubungkan."}
          </p>
          {hint ? (
            <p className="mt-3 rounded-md bg-[#f6f2e9] px-3 py-2 text-xs text-muted">
              Akun demo lokal: <span className="font-medium text-foreground">{hint}</span>. Sandi ada di <span className="font-mono">.env.local</span>.
            </p>
          ) : null}
          <label className="mt-6 block text-sm font-medium" htmlFor="email">Email</label>
          <Input id="email" type="email" autoComplete="username" className="mt-1" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <label className="mt-4 block text-sm font-medium" htmlFor="password">Sandi</label>
          <Input id="password" type="password" autoComplete="current-password" className="mt-1" value={password} onChange={(event) => setPassword(event.target.value)} required />
          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
          <Button type="submit" className="mt-6 w-full" disabled={busy}>
            {busy ? "Memeriksa…" : "Masuk"}
          </Button>
        </form>
      </section>
    </div>
  );
}
