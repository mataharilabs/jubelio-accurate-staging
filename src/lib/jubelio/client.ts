import { AppError } from "@/lib/errors";

const BASE = "https://api2.jubelio.com";

type TokenResponse = { token?: string; access_token?: string; data?: { token?: string } };

export class JubelioClient {
  private token: string | null = null;
  private tokenAt = 0;
  private stamps: number[] = [];

  constructor(private readonly email = process.env.JUBELIO_EMAIL?.trim() ?? "", private readonly password = process.env.JUBELIO_PASSWORD ?? "") {}

  configured(): boolean {
    return Boolean(this.email && this.password);
  }

  private async pace() {
    const now = Date.now();
    this.stamps = this.stamps.filter((stamp) => now - stamp < 60_000);
    if (this.stamps.length >= 560) {
      const wait = 60_000 - (now - this.stamps[0]) + 250;
      await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 1000)));
    }
    this.stamps.push(Date.now());
  }

  private async login() {
    if (!this.configured()) throw new AppError("JUBELIO_EMAIL dan JUBELIO_PASSWORD belum diisi.");
    if (this.token && Date.now() - this.tokenAt < 11 * 60 * 60 * 1000) return;
    await this.pace();
    const response = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.email, password: this.password }),
      signal: AbortSignal.timeout(30000),
    });
    const json = (await response.json().catch(() => ({}))) as TokenResponse;
    const token = json.token || json.access_token || json.data?.token;
    if (!response.ok || !token) throw new AppError("Login Jubelio gagal.");
    this.token = token;
    this.tokenAt = Date.now();
  }

  async get<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    await this.login();
    const url = new URL(`${BASE}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.pace();
      const response = await fetch(url, {
        headers: { authorization: this.token ?? "" },
        signal: AbortSignal.timeout(45000),
      });
      if (response.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        continue;
      }
      if (!response.ok) throw new AppError(`Jubelio menolak ${path} (${response.status}).`);
      return (await response.json()) as T;
    }
    throw new AppError("Jubelio membatasi permintaan. Coba lagi sebentar.");
  }
}

export function jubelioConfigured(): boolean {
  return Boolean(process.env.JUBELIO_EMAIL?.trim() && process.env.JUBELIO_PASSWORD);
}
