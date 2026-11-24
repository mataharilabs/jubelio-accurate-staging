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

export function invalidJsonMessage(status: number): string {
  if (status === 504 || status === 408) return `Server timeout (HTTP ${status}), coba lagi`;
  return `Respons server tidak valid (HTTP ${status}).`;
}

/** JSON body required. A 200 with a non-JSON body is an error, and the message includes the HTTP status. */
export function readApiBody(status: number, text: string): unknown {
  if (!text) {
    if (status < 200 || status >= 300) throw new Error(`Permintaan gagal (HTTP ${status}).`);
    return {};
  }
  let body: { error?: string };
  try {
    body = JSON.parse(text) as { error?: string };
  } catch {
    throw new Error(invalidJsonMessage(status));
  }
  if (!body || typeof body !== "object") {
    if (status < 200 || status >= 300) throw new Error(`Permintaan gagal (HTTP ${status}).`);
    return body;
  }
  if (status < 200 || status >= 300) throw new Error(body.error || `Permintaan gagal (HTTP ${status}).`);
  return body;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/masuk";
  }
  return readApiBody(response.status, text) as T;
}
