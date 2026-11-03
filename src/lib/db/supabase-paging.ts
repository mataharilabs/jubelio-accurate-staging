/** PostgREST returns at most 1000 rows unless the query uses range. */
export const SUPABASE_PAGE = 1000;
export const SUPABASE_TIMEOUT_MS = 30_000;

export async function eachPage<T>(load: (from: number, to: number) => Promise<T[]>, pageSize = SUPABASE_PAGE): Promise<T[]> {
  if (pageSize < 1) throw new Error("pageSize must be positive");
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await load(from, from + pageSize - 1);
    if (page.length > pageSize) {
      throw new Error(`Supabase mengembalikan ${page.length} baris untuk permintaan ${pageSize}.`);
    }
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

export function pickLatestRows<T extends { no_pesanan?: unknown; version_no?: unknown }>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = String(row.no_pesanan ?? "");
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || Number(row.version_no) > Number(prev.version_no)) latest.set(key, row);
  }
  return [...latest.values()];
}

export type RollbackStep = { run: () => Promise<void>; undo: () => Promise<void> };

/** Runs steps in order. If a later step throws, completed steps are undone in reverse. */
export async function commitWithRollback(steps: RollbackStep[]): Promise<void> {
  const done: RollbackStep[] = [];
  try {
    for (const step of steps) {
      await step.run();
      done.push(step);
    }
  } catch (error) {
    const undoErrors: unknown[] = [];
    for (const step of [...done].reverse()) {
      try {
        await step.undo();
      } catch (undoError) {
        undoErrors.push(undoError);
      }
    }
    if (undoErrors.length && error instanceof Error) {
      error.message += ` Pemulihan versi lama juga gagal (${undoErrors.length} langkah).`;
    }
    throw error;
  }
}

export function supabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(SUPABASE_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}
