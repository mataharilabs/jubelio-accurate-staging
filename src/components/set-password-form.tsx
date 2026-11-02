"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { authLinkError, parseAuthLink } from "@/lib/auth/links";

export function SetPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [payload, setPayload] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    const linkError = authLinkError(window.location.search, window.location.hash);
    if (linkError) {
      setError(linkError);
      setReady(true);
      return;
    }
    const link = parseAuthLink(window.location.search, window.location.hash);
    if (!link) {
      setError("Tautan tidak lengkap. Buka ulang tautan dari email.");
      setReady(true);
      return;
    }
    if (link.kind === "code") setPayload({ code: link.code });
    else if (link.kind === "otp") setPayload({ tokenHash: link.tokenHash, type: link.type });
    else setPayload({ accessToken: link.accessToken, refreshToken: link.refreshToken });
    setReady(true);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!payload) return;
    if (password !== confirm) {
      setError("Konfirmasi sandi tidak sama.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/accept", { method: "POST", body: JSON.stringify({ ...payload, password }) });
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sandi belum tersimpan.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-16">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Asiacommerce</div>
        <h1 className="mt-2 text-2xl font-semibold">Buat sandi</h1>
        <p className="mt-1 text-sm text-muted">Untuk undangan atau pemulihan akun. Setelah sandi tersimpan, Anda masuk ke dasbor.</p>
        <label className="mt-6 block text-sm font-medium" htmlFor="password">Sandi baru</label>
        <Input id="password" type="password" autoComplete="new-password" className="mt-1" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required disabled={!payload} />
        <label className="mt-4 block text-sm font-medium" htmlFor="confirm">Ulangi sandi</label>
        <Input id="confirm" type="password" autoComplete="new-password" className="mt-1" value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={8} required disabled={!payload} />
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        <Button type="submit" className="mt-6 w-full" disabled={busy || !ready || !payload}>
          {busy ? "Menyimpan…" : "Simpan sandi dan masuk"}
        </Button>
      </form>
    </div>
  );
}
