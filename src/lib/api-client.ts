let inflight = 0;
const inflightListeners = new Set<(count: number) => void>();

function setInflight(next: number) {
  inflight = Math.max(0, next);
  for (const listener of inflightListeners) listener(inflight);
}

export function subscribeInflight(listener: (count: number) => void): () => void {
  inflightListeners.add(listener);
  listener(inflight);
  return () => inflightListeners.delete(listener);
}

export function track<T>(work: Promise<T>): Promise<T> {
  setInflight(inflight + 1);
  return work.finally(() => setInflight(inflight - 1));
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  return track(request<T>(url, init));
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let body: { error?: string } = {};
  if (text) {
    try {
      body = JSON.parse(text) as { error?: string };
    } catch {
      body = { error: "Respons server tidak valid." };
    }
  }
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/masuk";
    throw new Error(body.error || "Sesi habis.");
  }
  if (!response.ok) throw new Error(body.error || "Permintaan gagal.");
  return body as T;
}
