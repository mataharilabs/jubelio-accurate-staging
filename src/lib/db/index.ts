import { supabaseConfigured } from "@/lib/env";
import { LocalStore } from "@/lib/db/local-store";
import type { DataStore } from "@/lib/db/store";
import { SupabaseStore } from "@/lib/db/supabase-store";

let pending: Promise<DataStore> | null = null;

async function open(): Promise<DataStore> {
  if (supabaseConfigured()) return new SupabaseStore();
  const store = new LocalStore();
  const dash = await store.dashboard();
  if (dash.stats.batchCount === 0 && dash.stats.weightCount === 0) {
    const { loadSampleData } = await import("@/lib/sample-data");
    await loadSampleData(store, "sistem");
  }
  return store;
}

export function getStore(): Promise<DataStore> {
  if (!pending) {
    pending = open().catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

export type { DataStore };
