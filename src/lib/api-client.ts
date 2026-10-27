export async function api<T>(url: string, init?: RequestInit): Promise<T> {
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
